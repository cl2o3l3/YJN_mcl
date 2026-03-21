/**
 * 信令客户端 (渲染进程)
 * WebSocket 连接信令服务器, 处理房间管理和 SDP/ICE 中继
 */

type EventCallback = (...args: any[]) => void

export class SignalingClient {
  private ws: WebSocket | null = null
  private url: string = ''
  private reconnectAttempts = 0
  private maxReconnects = 3
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Map<string, Set<EventCallback>>()
  private _peerId: string = ''
  private _connected = false
  private intentionalClose = false
  private lastRoomId: string = ''
  private lastPlayerName: string = ''

  get peerId(): string { return this._peerId }
  get connected(): boolean { return this._connected }

  on(event: string, cb: EventCallback): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(cb)
  }

  off(event: string, cb: EventCallback): void {
    this.listeners.get(event)?.delete(cb)
  }

  private emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach(cb => cb(...args))
  }

  /** 将 WS/HTTP URL 转为 HTTP(S) URL */
  private toHttpUrl(url: string): string {
    return url
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://')
      .replace(/\/$/, '')
  }

  /** 将 URL 转为 WSS URL（localhost 除外） */
  private toWsUrl(url: string): string {
    let wsUrl = url
    if (!wsUrl.startsWith('ws://localhost') && !wsUrl.startsWith('wss://')) {
      wsUrl = wsUrl.replace(/^(http:\/\/|ws:\/\/)/, 'wss://')
      if (!wsUrl.startsWith('wss://')) wsUrl = 'wss://' + wsUrl
    }
    if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
      wsUrl = 'wss://' + wsUrl
    }
    return wsUrl
  }

  /** 唤醒服务器（Render 免费实例休眠后 cold start 需要时间） */
  private async wakeUpServer(url: string): Promise<void> {
    const httpUrl = this.toHttpUrl(url)
    this.emit('waking-up')
    try {
      await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(60000) })
    } catch {
      // 即使 health 失败也继续尝试 WebSocket 连接
    }
  }

  /** 连接到信令服务器 */
  async connect(url: string): Promise<void> {
    this.url = url
    this.intentionalClose = false
    this.reconnectAttempts = 0

    // 先用 HTTP 唤醒服务器（处理 Render 免费实例休眠）
    await this.wakeUpServer(url)

    return new Promise((resolve, reject) => {
      this.doConnect(resolve, reject)
    })
  }

  private doConnect(
    resolve?: ((value: void) => void) | (() => void),
    reject?: (reason: Error) => void
  ): void {
    try {
      const wsUrl = this.toWsUrl(this.url)
      this.ws = new WebSocket(wsUrl)
    } catch (err) {
      reject?.(new Error(`WebSocket creation failed: ${err}`))
      return
    }

    // 15 秒连接超时
    const connectTimeout = setTimeout(() => {
      if (!this._connected) {
        this.ws?.close()
        reject?.(new Error('WebSocket 连接超时，请稍后重试'))
      }
    }, 15000)

    const firstMessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'welcome' && msg.peerId) {
          clearTimeout(connectTimeout)
          this._peerId = msg.peerId
          this._connected = true
          this.reconnectAttempts = 0
          this.emit('connected')
          resolve?.()
        }
      } catch { /* ignore parse errors on first message */ }
      this.ws?.removeEventListener('message', firstMessage)
    }

    this.ws.addEventListener('message', firstMessage)

    this.ws.addEventListener('open', () => {
      // wait for welcome message
    })

    this.ws.addEventListener('message', (event) => {
      this.handleMessage(event.data as string)
    })

    this.ws.addEventListener('close', () => {
      this._connected = false
      this.emit('disconnected')
      if (!this.intentionalClose) {
        this.tryReconnect()
      }
    })

    this.ws.addEventListener('error', () => {
      clearTimeout(connectTimeout)
      if (!this._connected) {
        reject?.(new Error('WebSocket connection failed'))
      }
    })
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, any>
    try {
      msg = JSON.parse(raw)
    } catch { return }

    const type = msg.type as string
    this.emit(type, msg)
    this.emit('message', msg) // 通用监听
  }

  private tryReconnect(): void {
    if (this.intentionalClose) return
    if (this.reconnectAttempts >= this.maxReconnects) {
      this.emit('reconnect-failed')
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 8000)
    this.emit('reconnecting', this.reconnectAttempts)

    this.reconnectTimer = setTimeout(() => {
      this.doConnect(() => {
        // 重连成功后自动 rejoin
        if (this.lastRoomId && this.lastPlayerName) {
          this.send({ type: 'rejoin-room', roomId: this.lastRoomId, playerName: this.lastPlayerName, peerId: this._peerId })
        }
      })
    }, delay)
  }

  /** 发送消息 */
  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  // ========== 业务方法 ==========

  createRoom(playerName: string, gameVersion: string): void {
    this.lastPlayerName = playerName
    this.send({ type: 'create-room', playerName, gameVersion })
  }

  joinRoom(roomCode: string, playerName: string): void {
    this.lastPlayerName = playerName
    this.send({ type: 'join-room', roomCode, playerName })
  }

  /** 记录当前房间 ID，用于断线重连 */
  setRoomId(roomId: string): void {
    this.lastRoomId = roomId
  }

  leaveRoom(): void {
    this.lastRoomId = ''
    this.send({ type: 'leave-room' })
  }

  sendOffer(targetPeerId: string, sdp: RTCSessionDescriptionInit): void {
    this.send({ type: 'offer', targetPeerId, sdp })
  }

  sendAnswer(targetPeerId: string, sdp: RTCSessionDescriptionInit): void {
    this.send({ type: 'answer', targetPeerId, sdp })
  }

  sendIceCandidate(targetPeerId: string, candidate: RTCIceCandidateInit): void {
    this.send({ type: 'ice-candidate', targetPeerId, candidate })
  }

  sendRelayData(targetPeerId: string, data: string): void {
    this.send({ type: 'relay-data', targetPeerId, data })
  }

  startRelay(targetPeerId: string): void {
    this.send({ type: 'relay-start', targetPeerId })
  }

  stopRelay(targetPeerId: string): void {
    this.send({ type: 'relay-stop', targetPeerId })
  }

  reportConnectionTier(tier: string): void {
    this.send({ type: 'connection-tier', tier })
  }

  requestTurnCredentials(): void {
    this.send({ type: 'request-turn-credentials' })
  }

  // ========== 共享世界 (Persistent Room) ==========

  createPersistentRoom(playerName: string, worldMeta: {
    worldName: string; mcVersion: string; modLoader?: { type: string; version: string }
  }): void {
    this.lastPlayerName = playerName
    this.send({ type: 'create-persistent-room', playerName, worldMeta })
  }

  registerHost(mcPort: number): void {
    this.send({ type: 'register-host', mcPort })
  }

  unregisterHost(): void {
    this.send({ type: 'unregister-host' })
  }

  queryHost(): void {
    this.send({ type: 'query-host' })
  }

  sendSaveOffer(targetPeerId: string, size: number, sha1: string): void {
    this.send({ type: 'save-offer', targetPeerId, size, sha1 })
  }

  sendSaveAccept(targetPeerId: string): void {
    this.send({ type: 'save-accept', targetPeerId })
  }

  sendSaveReject(targetPeerId: string, reason: string): void {
    this.send({ type: 'save-reject', targetPeerId, reason })
  }

  /** 主动断开 */
  disconnect(): void {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this._connected = false
    this._peerId = ''
    this.listeners.clear()
  }
}
