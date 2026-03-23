/**
 * WebRTC 管理器 (渲染进程)
 * 管理与多个 peer 的连接, 利用 connection-strategy 自动降级
 * 通过 IPC 将 DataChannel 数据桥接到主进程 TCP 代理
 */

import type { ConnectionTier, P2PPeer, TurnServerConfig } from '../types'
import type { PeerConnection } from './connection-strategy'
import { attemptConnection } from './connection-strategy'
import { SignalingClient } from './signaling-client'

export interface WebRTCManagerConfig {
  stunServers: string[]
  turnServers: TurnServerConfig[]
  relayServers: string[]
  enableIPv6: boolean
  relayFallback: boolean
}

interface ManagedPeer {
  peerId: string
  peerName: string
  connection: PeerConnection | null
  rtt: number
  state: P2PPeer['state']
  tier: ConnectionTier
  rttInterval: ReturnType<typeof setInterval> | null
}

type EventHandler = (...args: any[]) => void

export class WebRTCManager {
  private peers = new Map<string, ManagedPeer>()
  private connectionAttempts = new Map<string, number>()
  private signaling: SignalingClient
  private config: WebRTCManagerConfig
  private listeners = new Map<string, Set<EventHandler>>()

  constructor(signaling: SignalingClient, config: WebRTCManagerConfig) {
    this.signaling = signaling
    this.config = config
  }

  on(event: string, cb: EventHandler): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(cb)
  }

  off(event: string, cb: EventHandler): void {
    this.listeners.get(event)?.delete(cb)
  }

  private emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach(cb => cb(...args))
  }

  setRole(_role: 'host' | 'guest'): void {
    // Reserved for future role-specific behavior
  }

  /** 与新 peer 建立连接 */
  async connectToPeer(peerId: string, peerName: string, isInitiator: boolean): Promise<void> {
    const existing = this.peers.get(peerId)
    if (existing && (existing.state === 'connecting' || existing.state === 'connected')) {
      return
    }

    // 如果已有旧连接先清理
    this.disconnectPeer(peerId)

    const attemptId = (this.connectionAttempts.get(peerId) ?? 0) + 1
    this.connectionAttempts.set(peerId, attemptId)

    const managed: ManagedPeer = {
      peerId,
      peerName,
      connection: null,
      rtt: -1,
      state: 'connecting',
      tier: 'direct',
      rttInterval: null
    }
    this.peers.set(peerId, managed)
    this.emitPeerUpdate()

    try {
      const conn = await attemptConnection(
        peerId,
        isInitiator,
        this.signaling,
        this.config,
        (tier) => {
          managed.tier = tier
          this.emitPeerUpdate()
        }
      )

      managed.connection = conn

      if (this.connectionAttempts.get(peerId) !== attemptId || this.peers.get(peerId) !== managed) {
        conn.close()
        return
      }

      managed.state = 'connected'
      managed.tier = conn.tier

      // 数据回调: 从 peer 收到数据 → 检查 RTT 控制消息，否则发到本地 MC
      conn.onData((data) => {
        if (this.handleRttMessage(peerId, data)) return
        this.emit('data-from-peer', peerId, data)
      })

      // RTT 心跳 (仅 WebRTC 直连/TURN, WS 中继不适用)
      if (conn.tier !== 'relay') {
        managed.rttInterval = setInterval(() => {
          this.measureRtt(managed)
        }, 5000)
      }

      this.emitPeerUpdate()
      this.emit('peer-connected', peerId)
    } catch (err) {
      if (this.connectionAttempts.get(peerId) !== attemptId || this.peers.get(peerId) !== managed) {
        return
      }

      managed.state = 'disconnected'
      this.emitPeerUpdate()
      this.emit('peer-error', peerId, (err as Error).message)
    }
  }

  /** 向 peer 发送数据 */
  sendToPeer(peerId: string, data: Uint8Array): void {
    const managed = this.peers.get(peerId)
    if (managed?.connection) {
      managed.connection.send(data)
    }
  }

  /** 向所有 peer 广播 */
  broadcast(data: Uint8Array): void {
    for (const [, managed] of this.peers) {
      if (managed.connection && managed.state === 'connected') {
        managed.connection.send(data)
      }
    }
  }

  /** 断开某个 peer */
  disconnectPeer(peerId: string): void {
    const managed = this.peers.get(peerId)
    this.connectionAttempts.set(peerId, (this.connectionAttempts.get(peerId) ?? 0) + 1)
    if (!managed) return

    if (managed.rttInterval) clearInterval(managed.rttInterval)
    managed.connection?.close()
    this.peers.delete(peerId)
    this.emitPeerUpdate()
  }

  /** 断开所有 */
  disconnectAll(): void {
    for (const [id] of this.peers) {
      this.disconnectPeer(id)
    }
  }

  /** 获取 peer 列表 */
  getPeers(): P2PPeer[] {
    return Array.from(this.peers.values()).map(m => ({
      id: m.peerId,
      name: m.peerName,
      rtt: m.rtt,
      state: m.state,
      connectionTier: m.tier,
    }))
  }

  /** 获取某 peer 的连接层级 */
  getPeerTier(peerId: string): ConnectionTier | undefined {
    return this.peers.get(peerId)?.tier
  }

  /** 获取某 peer 的底层 RTCPeerConnection（仅 WebRTC 连接可用） */
  getPeerConnection(peerId: string): RTCPeerConnection | null {
    return this.peers.get(peerId)?.connection?.pc ?? null
  }

  private emitPeerUpdate(): void {
    this.emit('peers-updated', this.getPeers())
  }

  private rttPending = new Map<string, number>() // peerId → sendTime

  /** 发送 RTT ping，记录时间戳 */
  private measureRtt(managed: ManagedPeer): void {
    if (!managed.connection || managed.state !== 'connected') return
    const now = performance.now()
    this.rttPending.set(managed.peerId, now)
    managed.connection.send(new TextEncoder().encode('__RTT_PING'))
  }

  /** 处理收到的 RTT 消息，返回 true 表示是 RTT 控制消息 */
  handleRttMessage(peerId: string, data: Uint8Array): boolean {
    const text = new TextDecoder().decode(data)
    if (text === '__RTT_PING') {
      // 收到 ping，回 pong
      const managed = this.peers.get(peerId)
      managed?.connection?.send(new TextEncoder().encode('__RTT_PONG'))
      return true
    }
    if (text === '__RTT_PONG') {
      // 收到 pong，计算 RTT
      const sendTime = this.rttPending.get(peerId)
      if (sendTime !== undefined) {
        const managed = this.peers.get(peerId)
        if (managed) {
          managed.rtt = Math.round(performance.now() - sendTime)
          this.emitPeerUpdate()
        }
        this.rttPending.delete(peerId)
      }
      return true
    }
    return false
  }

  destroy(): void {
    this.disconnectAll()
    this.connectionAttempts.clear()
    this.listeners.clear()
  }
}
