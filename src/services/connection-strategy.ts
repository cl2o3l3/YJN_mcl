/**
 * 连接策略管理器 (渲染进程)
 * 编排三级降级: STUN 直连 → TURN 中继 → WS 中继
 * 返回统一的 send/onData 接口
 */

import type { ConnectionTier, TurnServerConfig } from '../types'
import { SignalingClient } from './signaling-client'

export interface PeerConnection {
  tier: ConnectionTier
  /** 底层 RTCPeerConnection（仅 WebRTC 连接可用，relay 为 null） */
  pc: RTCPeerConnection | null
  send(data: Uint8Array): void
  onData(cb: (data: Uint8Array) => void): void
  onClose(cb: (reason: string) => void): void
  close(): void
}

interface StrategyConfig {
  stunServers: string[]
  turnServers: TurnServerConfig[]
  relayServers: string[]       // 独立中继端点列表 (wss://...)
  enableIPv6: boolean
  relayFallback: boolean
}

// base64 编解码
function uint8ToBase64(data: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i])
  }
  return btoa(binary)
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * 尝试与 peer 建立连接，自动降级
 */
export async function attemptConnection(
  peerId: string,
  isInitiator: boolean,
  signaling: SignalingClient,
  config: StrategyConfig,
  onTierChange?: (tier: ConnectionTier) => void
): Promise<PeerConnection> {
  // 尝试 Tier 1: STUN 直连
  try {
    const conn = await attemptWebRTC(peerId, isInitiator, signaling, {
      iceServers: config.stunServers.map(url => ({ urls: url })),
      enableIPv6: config.enableIPv6,
    }, 8000)
    onTierChange?.('direct')
    signaling.reportConnectionTier('direct')
    return wrapWebRTC(conn, 'direct')
  } catch {
    // Tier 1 失败
  }

  // 尝试 Tier 2: TURN 中继 (用户配置的 TURN 服务器)
  const turnIceServers: RTCIceServer[] = config.turnServers.map(t => ({
    urls: t.urls,
    username: t.username,
    credential: t.credential,
  }))

  if (turnIceServers.length > 0) {
    try {
      const allServers = [
        ...config.stunServers.map(url => ({ urls: url })),
        ...turnIceServers
      ]
      const conn = await attemptWebRTC(peerId, isInitiator, signaling, {
        iceServers: allServers,
        enableIPv6: config.enableIPv6,
      }, 8000)
      onTierChange?.('turn')
      signaling.reportConnectionTier('turn')
      return wrapWebRTC(conn, 'turn')
    } catch {
      // TURN 失败
    }
  }

  // 尝试 Tier 2b: Cloudflare TURN (动态凭据)
  try {
    const cfCredentials = await requestCfTurn(signaling, 5000)
    if (cfCredentials.length > 0) {
      const allServers = [
        ...config.stunServers.map(url => ({ urls: url })),
        ...cfCredentials
      ]
      const conn = await attemptWebRTC(peerId, isInitiator, signaling, {
        iceServers: allServers,
        enableIPv6: config.enableIPv6,
      }, 8000)
      onTierChange?.('turn')
      signaling.reportConnectionTier('turn')
      return wrapWebRTC(conn, 'turn')
    }
  } catch {
    // CF TURN 失败
  }

  // Tier 3: WS 中继 (依次尝试: 信令服务器 → 独立中继端点)
  if (!config.relayFallback) {
    throw new Error('所有连接方式均失败，且 WS 中继已禁用')
  }

  // 3a: 先通过当前信令服务器中继
  try {
    onTierChange?.('relay')
    signaling.reportConnectionTier('relay')
    return createRelayConnection(peerId, signaling)
  } catch {
    // 信令中继失败
  }

  // 3b: 尝试独立中继端点列表
  for (const relayUrl of config.relayServers) {
    try {
      const relayConn = await connectStandaloneRelay(peerId, relayUrl, signaling.peerId, 6000)
      onTierChange?.('relay')
      return relayConn
    } catch {
      // 该中继端点失败，尝试下一个
    }
  }

  throw new Error('所有连接方式均失败')
}

// ========== WebRTC 连接尝试 ==========

interface WebRTCConfig {
  iceServers: RTCIceServer[]
  enableIPv6: boolean
}

interface WebRTCResult {
  pc: RTCPeerConnection
  dc: RTCDataChannel
}

function attemptWebRTC(
  peerId: string,
  isInitiator: boolean,
  signaling: SignalingClient,
  config: WebRTCConfig,
  timeout: number
): Promise<WebRTCResult> {
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection({
      iceServers: config.iceServers,
    })

    let dc: RTCDataChannel | null = null
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        cleanup()
        pc.close()
        reject(new Error('WebRTC timeout'))
      }
    }, timeout)

    function cleanup() {
      clearTimeout(timer)
      signaling.off('ice-candidate', onIceCandidate)
      signaling.off('offer', onOffer)
      signaling.off('answer', onAnswer)
    }

    function done() {
      if (!settled && dc) {
        settled = true
        cleanup()
        resolve({ pc, dc })
      }
    }

    // ICE candidate 交换
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        signaling.sendIceCandidate(peerId, e.candidate.toJSON())
      }
    }

    const onIceCandidate = (msg: any) => {
      if (msg.fromPeerId === peerId && msg.candidate) {
        pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {})
      }
    }
    signaling.on('ice-candidate', onIceCandidate)

    // DataChannel
    if (isInitiator) {
      dc = pc.createDataChannel('mc-tcp', { ordered: true, protocol: 'mc-tcp' })
      dc.binaryType = 'arraybuffer'
      dc.onopen = () => done()

      pc.createOffer().then(offer => {
        return pc.setLocalDescription(offer)
      }).then(() => {
        signaling.sendOffer(peerId, pc.localDescription!)
      }).catch(err => {
        if (!settled) { settled = true; cleanup(); pc.close(); reject(err) }
      })
    } else {
      pc.ondatachannel = (e) => {
        dc = e.channel
        dc.binaryType = 'arraybuffer'
        dc.onopen = () => done()
      }
    }

    // SDP 交换
    const onOffer = (msg: any) => {
      if (msg.fromPeerId !== peerId) return
      pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
        .then(() => pc.createAnswer())
        .then(answer => pc.setLocalDescription(answer))
        .then(() => {
          signaling.sendAnswer(peerId, pc.localDescription!)
        })
        .catch(() => {})
    }

    const onAnswer = (msg: any) => {
      if (msg.fromPeerId !== peerId) return
      pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).catch(() => {})
    }

    signaling.on('offer', onOffer)
    signaling.on('answer', onAnswer)

    // ICE 失败 — disconnected 等 5s 自愈，failed 立即降级
    let disconnectTimer: ReturnType<typeof setTimeout> | null = null
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState
      if (s === 'failed') {
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null }
        if (!settled) { settled = true; cleanup(); pc.close(); reject(new Error('ICE failed')) }
      } else if (s === 'disconnected') {
        if (!disconnectTimer && !settled) {
          disconnectTimer = setTimeout(() => {
            if (!settled && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
              settled = true; cleanup(); pc.close(); reject(new Error('ICE disconnected (timeout)'))
            }
          }, 5000)
        }
      } else if (s === 'connected' || s === 'completed') {
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null }
      }
    }
  })
}

function wrapWebRTC(result: WebRTCResult, tier: ConnectionTier): PeerConnection {
  const { pc, dc } = result
  const dataCallbacks: ((data: Uint8Array) => void)[] = []
  const closeCallbacks: ((reason: string) => void)[] = []
  let closed = false
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null

  function notifyClose(reason: string) {
    if (closed) return
    closed = true
    if (disconnectTimer) {
      clearTimeout(disconnectTimer)
      disconnectTimer = null
    }
    closeCallbacks.forEach(cb => cb(reason))
  }

  dc.onmessage = (e) => {
    const data = new Uint8Array(e.data as ArrayBuffer)
    dataCallbacks.forEach(cb => cb(data))
  }

  dc.onclose = () => {
    notifyClose('DataChannel closed')
  }

  dc.onerror = () => {
    notifyClose('DataChannel error')
  }

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState
    if (state === 'connected') {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer)
        disconnectTimer = null
      }
      return
    }

    if (state === 'disconnected') {
      if (!disconnectTimer) {
        disconnectTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            notifyClose(`PeerConnection ${pc.connectionState}`)
          }
        }, 5000)
      }
      return
    }

    if (state === 'failed' || state === 'closed') {
      notifyClose(`PeerConnection ${state}`)
    }
  }

  return {
    tier,
    pc,
    send(data: Uint8Array) {
      if (!closed && dc.readyState === 'open') {
        dc.send(new Uint8Array(data) as unknown as ArrayBufferView<ArrayBuffer>)
      }
    },
    onData(cb) {
      dataCallbacks.push(cb)
    },
    onClose(cb) {
      closeCallbacks.push(cb)
    },
    close() {
      closed = true
      if (disconnectTimer) {
        clearTimeout(disconnectTimer)
        disconnectTimer = null
      }
      closeCallbacks.length = 0
      dc.close()
      pc.close()
      dataCallbacks.length = 0
    }
  }
}

// ========== Cloudflare TURN 凭据请求 ==========

function requestCfTurn(signaling: SignalingClient, timeout: number): Promise<RTCIceServer[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signaling.off('turn-credentials', handler)
      resolve([])
    }, timeout)

    const handler = (msg: any) => {
      clearTimeout(timer)
      signaling.off('turn-credentials', handler)
      resolve(msg.iceServers || [])
    }

    signaling.on('turn-credentials', handler)
    signaling.requestTurnCredentials()
  })
}

// ========== WS 中继 ==========

function createRelayConnection(peerId: string, signaling: SignalingClient): PeerConnection {
  const dataCallbacks: ((data: Uint8Array) => void)[] = []

  const handler = (msg: any) => {
    if (msg.fromPeerId === peerId && msg.data) {
      const data = base64ToUint8(msg.data)
      dataCallbacks.forEach(cb => cb(data))
    }
  }

  signaling.on('relay-data', handler)
  signaling.startRelay(peerId)

  return {
    tier: 'relay',
    pc: null,
    send(data: Uint8Array) {
      signaling.sendRelayData(peerId, uint8ToBase64(data))
    },
    onData(cb) {
      dataCallbacks.push(cb)
    },
    onClose() {
      // 信令中继当前没有独立关闭回调，交由上层信令状态处理
    },
    close() {
      signaling.off('relay-data', handler)
      signaling.stopRelay(peerId)
      dataCallbacks.length = 0
    }
  }
}

// ========== 独立中继端点连接 ==========

/**
 * 连接到独立的 WS 中继服务器 (CF Worker / 腾讯云 SCF / 自建)
 * 协议: 连接后发 { type: 'register', peerId, targetPeerId }
 * 数据帧: { type: 'data', data: base64 }
 */
function connectStandaloneRelay(
  targetPeerId: string,
  relayUrl: string,
  selfPeerId: string,
  timeout: number
): Promise<PeerConnection> {
  return new Promise((resolve, reject) => {
    const wsUrl = relayUrl.replace(/^http/, 'ws')
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch {
      return reject(new Error('Invalid relay URL'))
    }
    const dataCallbacks: ((data: Uint8Array) => void)[] = []
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.close()
        reject(new Error('Relay connect timeout'))
      }
    }, timeout)

    // paired 超时: 15s 内未配对则放弃
    const pairedTimer = setTimeout(() => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        ws.close()
        reject(new Error('Relay pairing timeout'))
      }
    }, 15000)

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'register',
        peerId: selfPeerId,
        targetPeerId,
      }))
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(typeof e.data === 'string' ? e.data : '')
        if (msg.type === 'paired' && !settled) {
          settled = true
          clearTimeout(timer)
          clearTimeout(pairedTimer)
          resolve({
            tier: 'relay',
            pc: null,
            send(data: Uint8Array) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'data', data: uint8ToBase64(data) }))
              }
            },
            onData(cb) {
              dataCallbacks.push(cb)
            },
            onClose() {
              // 独立 WS 中继当前没有额外关闭回调，依赖 ws.onclose
            },
            close() {
              ws.close()
              dataCallbacks.length = 0
            }
          })
        } else if (msg.type === 'data' && msg.data) {
          const bytes = base64ToUint8(msg.data)
          dataCallbacks.forEach(cb => cb(bytes))
        } else if (msg.type === 'error') {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            ws.close()
            reject(new Error(msg.message || 'Relay error'))
          }
        }
      } catch { /* ignore parse errors */ }
    }

    ws.onerror = () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('Relay WebSocket error'))
      }
    }

    ws.onclose = () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('Relay closed before pairing'))
      }
    }
  })
}
