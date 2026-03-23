/**
 * Save Transfer — WebRTC 分块大文件传输
 * 通过独立 DataChannel 传输存档文件，16KB/chunk
 * 降级到信令 relay 中继
 */

import type { SignalingClient } from './signaling-client'

// ========== 类型 ==========

export interface TransferProgress {
  direction: 'upload' | 'download'
  current: number       // 已传输字节
  total: number         // 总字节
  speed: number         // bytes/s
}

type ProgressCallback = (progress: TransferProgress) => void
type CompleteCallback = (success: boolean, error?: string) => void

const CHUNK_SIZE = 16384  // 16KB (WebRTC SCTP 安全上限)
const SAVE_CHANNEL_LABEL = 'save-sync'

// ========== 发送端 ==========

export class SaveSender {
  private dc: RTCDataChannel | null = null
  private aborted = false
  private settled = false
  private onProgress: ProgressCallback
  private onComplete: CompleteCallback

  constructor(onProgress: ProgressCallback, onComplete: CompleteCallback) {
    this.onProgress = onProgress
    this.onComplete = onComplete
  }

  /**
   * 通过一个已建立的 RTCPeerConnection 发送文件
   * @param pc 已连接的 RTCPeerConnection
   * @param fileData 完整文件数据
   * @param sha1 校验和
   * @param worldName MC 存档目录名
   */
  async send(pc: RTCPeerConnection, fileData: ArrayBuffer, sha1: string, worldName: string): Promise<void> {
    const totalSize = fileData.byteLength
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE)

    // 创建独立 DataChannel
    this.dc = pc.createDataChannel(SAVE_CHANNEL_LABEL, {
      ordered: true,
    })

    return new Promise<void>((resolve, reject) => {
      const dc = this.dc!
      let sentBytes = 0
      let chunkIndex = 0
      const startTime = Date.now()

      const finishSuccess = () => {
        if (this.settled) return
        this.settled = true
        this.onComplete(true)
        resolve()
      }

      const finishError = (message: string, error: Error) => {
        if (this.settled) return
        this.settled = true
        this.onComplete(false, message)
        reject(error)
      }

      dc.binaryType = 'arraybuffer'
      dc.bufferedAmountLowThreshold = CHUNK_SIZE * 4

      dc.onopen = () => {
        // 发送元数据
        const meta = JSON.stringify({
          type: '__SAVE_META',
          totalSize,
          sha1,
          chunkSize: CHUNK_SIZE,
          totalChunks,
          worldName,
        })
        dc.send(meta)
      }

      const sendNextChunks = () => {
        if (this.aborted) {
          dc.close()
          finishError('传输已取消', new Error('传输已取消'))
          return
        }

        // 发送直到 buffer 满或全部发完
        while (chunkIndex < totalChunks && dc.bufferedAmount < CHUNK_SIZE * 16) {
          const offset = chunkIndex * CHUNK_SIZE
          const end = Math.min(offset + CHUNK_SIZE, totalSize)
          const chunk = fileData.slice(offset, end)
          dc.send(chunk)
          chunkIndex++
          sentBytes = end

          const elapsed = (Date.now() - startTime) / 1000 || 0.001
          this.onProgress({
            direction: 'upload',
            current: sentBytes,
            total: totalSize,
            speed: sentBytes / elapsed,
          })
        }

        // 全部发完
        if (chunkIndex >= totalChunks) {
          // 发送完成标记
          dc.send(JSON.stringify({ type: '__SAVE_DONE', totalChunks }))
        }
      }

      dc.onbufferedamountlow = sendNextChunks

      dc.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === '__SAVE_ACK') {
            // 接收端确认收到 meta，开始发送 chunks
            sendNextChunks()
          } else if (msg.type === '__SAVE_VERIFY') {
            dc.close()
            if (msg.sha1Match) {
              finishSuccess()
            } else {
              const err = 'SHA1 校验失败'
              finishError(err, new Error(err))
            }
          }
        } catch { /* binary chunk ack or non-json, ignore */ }
      }

      dc.onerror = (err) => {
        finishError(`DataChannel 错误: ${err}`, new Error('DataChannel error'))
      }

      dc.onclose = () => {
        if (!this.settled && chunkIndex < totalChunks && !this.aborted) {
          finishError('连接意外关闭', new Error('DataChannel closed prematurely'))
        }
      }
    })
  }

  abort(): void {
    this.aborted = true
    this.settled = true
    this.dc?.close()
  }
}

// ========== 接收端 ==========

export class SaveReceiver {
  private settled = false
  private onProgress: ProgressCallback
  private onComplete: CompleteCallback

  constructor(onProgress: ProgressCallback, onComplete: CompleteCallback) {
    this.onProgress = onProgress
    this.onComplete = onComplete
  }

  /**
   * 监听来自发送端的 save-sync DataChannel
   * @param pc 已连接的 RTCPeerConnection
   * @returns 接收到的文件数据
   */
  listen(pc: RTCPeerConnection): Promise<{ data: ArrayBuffer; sha1: string; worldName: string }> {
    return new Promise((resolve, reject) => {
      const handler = (event: RTCDataChannelEvent) => {
        if (event.channel.label !== SAVE_CHANNEL_LABEL) return
        pc.removeEventListener('datachannel', handler)

        const dc = event.channel
        dc.binaryType = 'arraybuffer'

        let meta: { totalSize: number; sha1: string; chunkSize: number; totalChunks: number; worldName: string } | null = null
        const chunks: ArrayBuffer[] = []
        let receivedBytes = 0
        const startTime = Date.now()

        const finishSuccess = (payload: { data: ArrayBuffer; sha1: string; worldName: string }) => {
          if (this.settled) return
          this.settled = true
          this.onComplete(true)
          resolve(payload)
        }

        const finishError = (message: string, error: Error) => {
          if (this.settled) return
          this.settled = true
          this.onComplete(false, message)
          reject(error)
        }

        dc.onmessage = (msgEvent) => {
          const data = msgEvent.data

          // JSON 消息
          if (typeof data === 'string') {
            try {
              const msg = JSON.parse(data)
              if (msg.type === '__SAVE_META') {
                meta = {
                  totalSize: msg.totalSize,
                  sha1: msg.sha1,
                  chunkSize: msg.chunkSize,
                  totalChunks: msg.totalChunks,
                  worldName: msg.worldName || 'shared-world',
                }
                this.onProgress({
                  direction: 'download',
                  current: 0,
                  total: meta.totalSize,
                  speed: 0,
                })
                // 确认收到 meta
                dc.send(JSON.stringify({ type: '__SAVE_ACK' }))
                return
              }
              if (msg.type === '__SAVE_DONE') {
                // 组装完整文件
                const result = new Uint8Array(receivedBytes)
                let offset = 0
                for (const chunk of chunks) {
                  result.set(new Uint8Array(chunk), offset)
                  offset += chunk.byteLength
                }

                // 计算 SHA1 校验
                crypto.subtle.digest('SHA-1', result.buffer).then(hashBuf => {
                  const hashArray = Array.from(new Uint8Array(hashBuf))
                  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
                  const match = hashHex === meta!.sha1

                  dc.send(JSON.stringify({ type: '__SAVE_VERIFY', sha1Match: match }))

                  if (match) {
                    finishSuccess({ data: result.buffer, sha1: meta!.sha1, worldName: meta!.worldName })
                  } else {
                    finishError('SHA1 不匹配', new Error('SHA1 mismatch'))
                  }

                  setTimeout(() => dc.close(), 500)
                })
                return
              }
            } catch { /* not JSON, treat as binary */ }
          }

          // 二进制 chunk
          if (data instanceof ArrayBuffer && meta) {
            chunks.push(data)
            receivedBytes += data.byteLength

            const elapsed = (Date.now() - startTime) / 1000 || 0.001
            this.onProgress({
              direction: 'download',
              current: receivedBytes,
              total: meta.totalSize,
              speed: receivedBytes / elapsed,
            })
          }
        }

        dc.onerror = () => {
          finishError('DataChannel 错误', new Error('DataChannel error'))
        }

        dc.onclose = () => {
          if (!this.settled && (!meta || receivedBytes < meta.totalSize)) {
            finishError('连接意外关闭', new Error('DataChannel closed before transfer complete'))
          }
        }
      }

      pc.addEventListener('datachannel', handler)
    })
  }
}

// ========== 降级中继传输 ==========

/**
 * 通过信令服务器中继发送文件 (base64)
 * 限速 ~1MB/s，仅用于 WebRTC 完全不可用的场景
 */
export class RelaySender {
  private aborted = false
  private onProgress: ProgressCallback
  private onComplete: CompleteCallback

  constructor(onProgress: ProgressCallback, onComplete: CompleteCallback) {
    this.onProgress = onProgress
    this.onComplete = onComplete
  }

  async send(signaling: SignalingClient, targetPeerId: string, fileData: ArrayBuffer, sha1: string): Promise<void> {
    const totalSize = fileData.byteLength
    // 使用更小的 chunk (8KB) 因为 base64 膨胀 33%
    const chunkSize = 8192
    const totalChunks = Math.ceil(totalSize / chunkSize)

    // 发送 meta
    signaling.send({
      type: 'relay-data',
      targetPeerId,
      data: btoa(JSON.stringify({ type: '__SAVE_META', totalSize, sha1, chunkSize, totalChunks })),
    })

    let sentBytes = 0
    const startTime = Date.now()

    for (let i = 0; i < totalChunks; i++) {
      if (this.aborted) {
        this.onComplete(false, '传输已取消')
        return
      }

      const offset = i * chunkSize
      const end = Math.min(offset + chunkSize, totalSize)
      const chunk = new Uint8Array(fileData.slice(offset, end))

      // 转 base64
      let binary = ''
      for (let j = 0; j < chunk.length; j++) {
        binary += String.fromCharCode(chunk[j])
      }
      const b64 = btoa(binary)

      signaling.send({
        type: 'relay-data',
        targetPeerId,
        data: b64,
      })

      sentBytes = end
      const elapsed = (Date.now() - startTime) / 1000 || 0.001
      this.onProgress({
        direction: 'upload',
        current: sentBytes,
        total: totalSize,
        speed: sentBytes / elapsed,
      })

      // 限速: 大约 500KB/s 实际 (base64 膨胀后约 666KB/s < 1MB/s relay limit)
      await new Promise(r => setTimeout(r, 15))
    }

    // 发送完成标记
    signaling.send({
      type: 'relay-data',
      targetPeerId,
      data: btoa(JSON.stringify({ type: '__SAVE_DONE', totalChunks })),
    })

    this.onComplete(true)
  }

  abort(): void {
    this.aborted = true
  }
}
