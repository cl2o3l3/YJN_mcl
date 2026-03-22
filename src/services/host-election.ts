/**
 * Host Election — 主机自动选举 + 上下线流程 + 崩溃恢复
 *
 * 方案 A (LAN 模式):
 *   房主：启动 MC 客户端 → 加载世界 → 开局域网 → LAN 检测端口 → 注册为主机
 *   客人：通过 P2P 代理连接房主的 LAN
 *   迁移：房主退出 → 打包存档 → 传给候选人 → 候选人加载 → 开 LAN → 其他人重连
 */

import type { ModLoaderInfo } from '../types'
import { SignalingClient } from './signaling-client'
import type { TransferProgress } from './save-transfer'

// ========== 类型 ==========

export type ElectionState =
  | 'idle'
  | 'joining'              // 正在加入房间
  | 'querying-host'        // 正在查询当前主机
  | 'becoming-host'        // 正在成为主机 (等待用户开 LAN)
  | 'connected'            // 已连接到主机 (作为客户端)
  | 'hosting'              // 正在作为主机运行
  | 'transferring'         // 正在传输存档 (主机迁移中)
  | 'waiting-host'         // 等待新主机 (崩溃恢复 / 主机离开)
  | 'receiving-save'       // 正在接收存档 (即将成为新主机)

export interface HostInfo {
  peerId: string
  peerName: string
  mcPort?: number
}

export interface WorldMeta {
  worldName: string
  mcVersion: string
  modLoader?: ModLoaderInfo
}

export interface ElectionEvents {
  /** 状态变化 */
  onStateChange: (state: ElectionState) => void
  /** 主机信息变化 */
  onHostChange: (host: HostInfo | null) => void
  /**
   * 主机要离开 — 打包存档用于传输
   * 返回打包结果
   */
  onNeedTransferHost: (worldName: string) => Promise<{ archivePath: string; size: number; sha1: string }>
  /**
   * 需要接收并解包存档 (即将成为新主机)
   */
  onNeedReceiveSave: (archivePath: string, sha1: string, worldName: string) => Promise<void>
  /** 存档传输进度 */
  onTransferProgress: (progress: TransferProgress) => void
  /** 检查本地是否有缓存存档 */
  onCheckLocalSave: (worldName: string) => Promise<boolean>
  /** 日志 */
  onLog: (message: string) => void
}

// ========== Host Election ==========

export class HostElection {
  private signaling: SignalingClient
  private events: ElectionEvents
  private state: ElectionState = 'idle'
  private worldMeta: WorldMeta | null = null
  private currentHost: HostInfo | null = null
  private myRole: 'host' | 'client' | null = null

  // 信令监听器清理
  private cleanups: (() => void)[] = []

  constructor(signaling: SignalingClient, events: ElectionEvents) {
    this.signaling = signaling
    this.events = events
  }

  getState(): ElectionState { return this.state }
  getHost(): HostInfo | null { return this.currentHost }
  getRole(): 'host' | 'client' | null { return this.myRole }
  getWorldMeta(): WorldMeta | null { return this.worldMeta }

  setWorldMeta(meta: WorldMeta): void { this.worldMeta = meta }

  private setState(state: ElectionState) {
    this.state = state
    this.events.onStateChange(state)
  }

  private setHost(host: HostInfo | null) {
    this.currentHost = host
    this.events.onHostChange(host)
  }

  // ========== 上线流程 ==========

  /**
   * 加入共享世界，查询主机状态
   * 不再自动竞选 — 等待 LAN 检测后由 store 层调用 becomeHost(port)
   */
  async joinWorld(roomCode: string, playerName: string): Promise<void> {
    this.setState('joining')

    // 监听信令事件
    this.setupListeners()

    // 先挂监听，再发消息，避免快速响应导致竞态丢包
    const roomJoinedPromise = this.waitForEvent('room-joined', 15000)
    this.signaling.joinRoom(roomCode, playerName)
    const roomJoined = await roomJoinedPromise as any
    if (roomJoined.roomId) {
      this.signaling.setRoomId(roomJoined.roomId)
    }

    // 查询当前主机
    this.setState('querying-host')
    const hostInfoPromise = this.waitForEvent('host-info', 10000)
    this.signaling.queryHost()

    // 等待 host-info 响应
    const hostInfo = await hostInfoPromise as any

    if (hostInfo.host) {
      // 有主机在线 → 作为客户端连接
      this.events.onLog(`当前主机: ${hostInfo.host.peerName}，作为客户端加入`)
      this.setHost(hostInfo.host)
      this.myRole = 'client'
      this.setState('connected')
    } else {
      // 无主机 → 等待有人开启局域网
      this.events.onLog('当前无主机，等待有人在 MC 中开启局域网...')
      this.setState('waiting-host')
    }

    // 保存服务端返回的 worldMeta
    if (hostInfo.worldMeta) {
      this.worldMeta = hostInfo.worldMeta
    }
  }

  /**
   * 创建共享世界 — 只创建房间，立即返回房间码
   * 不再阻塞等待 LAN，由 store 层被动检测 LAN 后调用 becomeHost(port)
   */
  async createWorld(playerName: string, worldMeta?: WorldMeta): Promise<string> {
    if (worldMeta) this.worldMeta = worldMeta
    this.setState('joining')

    this.setupListeners()

    const createPromise = this.waitForEvent('persistent-room-created', 15000)
    this.signaling.createPersistentRoom(playerName, worldMeta)

    // 等待 persistent-room-created
    const result = await createPromise as any
    const roomCode = result.roomCode
    this.signaling.setRoomId(result.roomId)

    // 不再立即 becomeHost，等待 LAN 检测
    this.setState('waiting-host')
    this.events.onLog('房间已创建，等待有人在 MC 中开启局域网...')

    return roomCode
  }

  // ========== 成为主机 ==========

  /**
   * 成为主机 — 外部检测到 LAN 端口后调用，直接向信令服务器注册
   */
  async becomeHost(port: number): Promise<void> {
    this.setState('becoming-host')
    this.events.onLog('正在注册为主机...')

    try {
      if (!this.signaling.connected) {
        this.events.onLog('信令连接已断开，等待重连...')
        await this.waitForReconnect(15000)
        this.events.onLog('✓ 信令已重连')
      }

      // 注册为主机（单一 waiter 避免竞态和未处理的 rejection）
      const result = await this.waitForOneOfEvents(
        ['host-registered', 'host-conflict'], 10000,
        () => this.signaling.registerHost(port)
      )

      if (result.type === 'host-conflict') {
        // 已有其他人先一步注册
        this.events.onLog(`主机竞选失败，${result.currentHostName} 已抢先注册`)
        this.setHost({ peerId: result.currentHostId, peerName: result.currentHostName })
        this.myRole = 'client'
        this.setState('connected')
        return
      }

      // 注册成功
      this.myRole = 'host'
      this.setHost({
        peerId: this.signaling.peerId,
        peerName: '我',
        mcPort: port,
      })
      this.setState('hosting')
      this.events.onLog(`✓ 已成为主机 (port: ${port})`)
    } catch (e: any) {
      this.events.onLog(`成为主机失败: ${e.message}`)
      this.setState('waiting-host')
      throw e
    }
  }

  // ========== 下线流程 ==========

  /**
   * 正常离开共享世界
   * 如果是主机，先迁移给其他人
   */
  async leaveWorld(): Promise<void> {
    if (this.myRole === 'host') {
      await this.migrateHostAndLeave()
    } else {
      this.signaling.leaveRoom()
      this.cleanup()
    }
  }

  /**
   * 主机迁移后离开
   * LAN 模式: 用户已退出 MC，存档已落盘，直接打包 + unregister
   */
  private async migrateHostAndLeave(): Promise<void> {
    this.setState('transferring')

    if (!this.worldMeta) {
      this.signaling.leaveRoom()
      this.cleanup()
      return
    }

    try {
      this.events.onLog('正在打包存档...')

      // 打包存档 (此时用户的 MC 应已退出或存档已落盘)
      await this.events.onNeedTransferHost(this.worldMeta.worldName)

      this.signaling.unregisterHost()
      this.events.onLog('已移交主机权限')

      this.signaling.leaveRoom()
      this.cleanup()
    } catch (e: any) {
      this.events.onLog(`主机迁移失败: ${e.message}`)
      this.signaling.leaveRoom()
      this.cleanup()
    }
  }

  // ========== 事件监听 ==========

  private setupListeners(): void {
    // host-changed: 主机变更通知
    const onHostChanged = (msg: any) => {
      if (msg.hostId) {
        this.setHost({ peerId: msg.hostId, peerName: msg.hostName, mcPort: msg.mcPort })
        if (msg.hostId !== this.signaling.peerId && this.myRole !== 'host') {
          this.myRole = 'client'
          this.setState('connected')
          this.events.onLog(`主机已变更为 ${msg.hostName}`)
        }
      } else {
        this.setHost(null)
        if (this.myRole === 'client') {
          this.setState('waiting-host')
          this.events.onLog(`主机已离线 (${msg.reason || 'unknown'})，等待新主机...`)
          // 自动尝试竞选
          this.tryAutoElection()
        }
      }
    }
    this.signaling.on('host-changed', onHostChanged)
    this.cleanups.push(() => this.signaling.off('host-changed', onHostChanged))

    // room-closed
    const onRoomClosed = () => {
      this.events.onLog('房间已关闭')
      this.cleanup()
    }
    this.signaling.on('room-closed', onRoomClosed)
    this.cleanups.push(() => this.signaling.off('room-closed', onRoomClosed))
  }

  /**
   * 崩溃恢复：主机断连后提示用户竞选
   * 实际竞选由 store 层的被动 LAN 检测触发 becomeHost(port)
   */
  private async tryAutoElection(): Promise<void> {
    if (!this.worldMeta) return

    // 稍等一下，确认确实没有新主机
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000))

    // 再次确认仍然没有主机
    if (this.currentHost) return

    // 检查本地是否有缓存存档
    const hasLocal = await this.events.onCheckLocalSave(this.worldMeta.worldName)
    if (!hasLocal) {
      this.events.onLog('本地无缓存存档，等待其他人竞选主机')
      return
    }

    this.events.onLog('检测到本地有缓存存档，请在 MC 中加载世界并开启局域网')
    // LAN 检测器会自动触发 becomeHost
  }

  // ========== 工具 ==========

  private waitForEvent(eventName: string, timeoutMs: number): Promise<any> {
    return this.waitForOneOfEvents([eventName], timeoutMs)
  }

  /**
   * 等待多个事件中任意一个，或 error 事件；超时后拒绝。
   * 可选 sendFn 在注册监听后执行（避免先发消息再挂监听的竞态）。
   */
  private waitForOneOfEvents(
    eventNames: string[],
    timeoutMs: number,
    sendFn?: () => void
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let settled = false
      const handlers = new Map<string, (msg: any) => void>()

      const cleanup = () => {
        clearTimeout(timeout)
        for (const [name, h] of handlers) this.signaling.off(name, h)
        this.signaling.off('error', errorHandler)
      }

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`等待 ${eventNames.join('/')} 超时 (${timeoutMs}ms)`))
      }, timeoutMs)

      for (const name of eventNames) {
        const handler = (msg: any) => {
          if (settled) return
          settled = true
          cleanup()
          resolve({ ...msg, type: name })
        }
        handlers.set(name, handler)
        this.signaling.on(name, handler)
      }

      const errorHandler = (msg: any) => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`信令错误: ${msg.message || '未知错误'}`))
      }
      this.signaling.on('error', errorHandler)

      // 监听器全部挂好后再发送消息
      if (sendFn) sendFn()
    })
  }

  /**
   * 等待信令重连（断线后自动重连机制会触发 'connected' 事件）
   */
  private waitForReconnect(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.signaling.connected) { resolve(); return }

      const timeout = setTimeout(() => {
        this.signaling.off('connected', handler)
        reject(new Error('信令重连超时，请检查网络后重试'))
      }, timeoutMs)

      const handler = () => {
        clearTimeout(timeout)
        this.signaling.off('connected', handler)
        resolve()
      }
      this.signaling.on('connected', handler)
    })
  }

  private cleanup(): void {
    for (const fn of this.cleanups) fn()
    this.cleanups = []
    this.state = 'idle'
    this.myRole = null
    this.currentHost = null
    this.worldMeta = null
  }

  destroy(): void {
    this.cleanup()
  }
}
