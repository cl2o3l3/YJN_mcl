/**
 * Shared World Store (Pinia)
 * 管理共享世界全流程: 创建/加入/主机选举/存档同步
 * 方案 A: 使用 MC 客户端内置 "Open to LAN" + P2P 代理
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { SignalingClient } from '../services/signaling-client'
import { HostElection, type ElectionState, type HostInfo, type WorldMeta } from '../services/host-election'
import { WebRTCManager } from '../services/webrtc-manager'
import type { TransferProgress } from '../services/save-transfer'
import type { P2PPeer } from '../types'
import { useSettingsStore } from './settings'

// ========== 类型 ==========

export interface SharedWorld {
  roomCode: string
  worldName: string
  mcVersion: string
  localSavePath?: string   // 本地存档缓存路径
  lastSyncTime?: number
  createdAt: number
}

// ========== Store ==========

export const useSharedWorldStore = defineStore('shared-world', () => {
  const settings = useSettingsStore()

  // 已加入的共享世界列表
  const worlds = ref<SharedWorld[]>([])

  // 当前活跃世界
  const currentWorld = ref<SharedWorld | null>(null)

  // 选举状态
  const electionState = ref<ElectionState>('idle')

  // 主机信息
  const hostInfo = ref<HostInfo | null>(null)

  // 我的角色
  const myRole = ref<'host' | 'client' | null>(null)

  // 传输进度
  const transferProgress = ref<TransferProgress | null>(null)

  // 日志
  const logs = ref<string[]>([])

  // 错误
  const error = ref('')

  // 房间码
  const roomCode = ref('')

  // 内部对象
  let signaling: SignalingClient | null = null
  let election: HostElection | null = null
  let webrtcManager: WebRTCManager | null = null
  let cleanupFns: (() => void)[] = []

  // P2P 状态
  const peers = ref<P2PPeer[]>([])
  const mcLanPort = ref(0)
  const localPort = ref(0)

  // 当前游戏目录 (用于写 reconnect hint)
  let currentGameDir = ''

  // ========== 计算属性 ==========

  const isActive = computed(() => electionState.value !== 'idle')
  const isHost = computed(() => myRole.value === 'host')
  const isConnected = computed(() =>
    electionState.value === 'connected' || electionState.value === 'hosting'
  )

  // ========== 工具 ==========

  function addLog(msg: string) {
    const time = new Date().toLocaleTimeString()
    logs.value.push(`[${time}] ${msg}`)
    // 限制日志条数
    if (logs.value.length > 500) {
      logs.value = logs.value.slice(-300)
    }
  }

  // ========== 创建共享世界 ==========

  async function createWorld(config: {
    playerName: string
    gameDir: string
    worldName: string
    mcVersion: string
  }): Promise<string> {
    error.value = ''

    try {
      // 1. 连接信令
      signaling = new SignalingClient()
      await signaling.connect(settings.signalingServer)
      addLog('已连接到信令服务器')

      const worldMeta: WorldMeta = {
        worldName: config.worldName,
        mcVersion: config.mcVersion,
      }

      // 2. 创建选举 (LAN 模式回调)
      election = new HostElection(signaling, {
        onStateChange: (state) => { electionState.value = state },
        onHostChange: (host) => { hostInfo.value = host },
        onNeedBecomeHost: async (_meta) => {
          addLog('等待 MC 客户端开启局域网...')
          // 启动 LAN 检测器，等待用户在 MC 中点击"开启局域网"
          const port = await waitForLanPort()
          addLog(`✓ 检测到 LAN 端口: ${port}`)
          return { port }
        },
        onNeedTransferHost: async (worldName) => {
          addLog(`正在打包存档 ${worldName}...`)
          const packed = await window.api.save.pack(
            `${config.gameDir}/saves/${worldName}`
          )
          return { archivePath: packed.archivePath, size: packed.size, sha1: packed.sha1 }
        },
        onNeedReceiveSave: async (archivePath, sha1, worldName) => {
          addLog(`正在解包存档 ${worldName}...`)
          const targetDir = `${config.gameDir}/saves/${worldName}`
          await window.api.save.unpack(archivePath, targetDir, sha1)
          addLog('✓ 存档已解包')
        },
        onTransferProgress: (progress) => {
          transferProgress.value = progress
        },
        onCheckLocalSave: async (worldName) => {
          try {
            const saves = await window.api.save.list(config.gameDir)
            return saves.some(s => s.name === worldName)
          } catch {
            return false
          }
        },
        onLog: addLog,
      })

      // 3. 创建世界
      const code = await election.createWorld(config.playerName, worldMeta)
      roomCode.value = code
      myRole.value = 'host'
      currentGameDir = config.gameDir

      // 4. 启动 P2P 管线 (房主等待客人连接)
      startP2PPipeline()

      // 5. 保存到世界列表
      const world: SharedWorld = {
        roomCode: code,
        worldName: config.worldName,
        mcVersion: config.mcVersion,
        localSavePath: `${config.gameDir}/saves/${config.worldName}`,
        createdAt: Date.now(),
      }
      currentWorld.value = world
      addWorldToList(world)

      addLog(`✓ 共享世界已创建，房间码: ${code}`)
      return code
    } catch (e: any) {
      error.value = e.message
      addLog(`创建失败: ${e.message}`)
      throw e
    }
  }

  // ========== 加入共享世界 ==========

  async function joinWorld(config: {
    playerName: string
    roomCode: string
    gameDir: string
  }): Promise<void> {
    error.value = ''

    try {
      signaling = new SignalingClient()
      await signaling.connect(settings.signalingServer)
      addLog('已连接到信令服务器')

      // 先加入房间获取世界信息
      const worldMeta: WorldMeta = {
        worldName: '',
        mcVersion: '',
      }

      election = new HostElection(signaling, {
        onStateChange: (state) => { electionState.value = state },
        onHostChange: (host) => { hostInfo.value = host },
        onNeedBecomeHost: async (_meta) => {
          addLog('等待 MC 客户端开启局域网...')
          const port = await waitForLanPort()
          addLog(`✓ 检测到 LAN 端口: ${port}`)
          return { port }
        },
        onNeedTransferHost: async (worldName) => {
          const packed = await window.api.save.pack(
            `${config.gameDir}/saves/${worldName}`
          )
          return { archivePath: packed.archivePath, size: packed.size, sha1: packed.sha1 }
        },
        onNeedReceiveSave: async (archivePath, sha1, worldName) => {
          const targetDir = `${config.gameDir}/saves/${worldName}`
          await window.api.save.unpack(archivePath, targetDir, sha1)
        },
        onTransferProgress: (progress) => {
          transferProgress.value = progress
        },
        onCheckLocalSave: async (worldName) => {
          try {
            const saves = await window.api.save.list(config.gameDir)
            return saves.some(s => s.name === worldName)
          } catch {
            return false
          }
        },
        onLog: addLog,
      })

      roomCode.value = config.roomCode

      await election.joinWorld(config.roomCode, config.playerName, worldMeta)
      myRole.value = election.getRole()
      currentGameDir = config.gameDir

      // 启动 P2P 管线 (客户端向房主发起连接)
      startP2PPipeline()

      // 从选举中获取世界信息
      const meta = election.getWorldMeta()
      if (meta) {
        const world: SharedWorld = {
          roomCode: config.roomCode,
          worldName: meta.worldName,
          mcVersion: meta.mcVersion,
          createdAt: Date.now(),
        }
        currentWorld.value = world
        addWorldToList(world)
      }

      addLog(`✓ 已加入共享世界 (${config.roomCode})`)
    } catch (e: any) {
      error.value = e.message
      addLog(`加入失败: ${e.message}`)
      throw e
    }
  }

  // ========== 离开共享世界 ==========

  async function leaveWorld(): Promise<void> {
    try {
      if (election) {
        await election.leaveWorld()
        election.destroy()
        election = null
      }
      if (webrtcManager) {
        webrtcManager.destroy()
        webrtcManager = null
      }
      if (signaling) {
        signaling.disconnect()
        signaling = null
      }
      // 清理代理/广播/检测器
      window.api.p2p.destroyAllProxies()
      window.api.p2p.stopAllLanBroadcasts()
      window.api.p2p.stopLanDetector()
      if (currentGameDir) {
        window.api.reconnect.clearHint(currentGameDir).catch(() => {})
      }
      for (const fn of cleanupFns) fn()
      cleanupFns = []
    } catch (e: any) {
      addLog(`离开时出错: ${e.message}`)
    } finally {
      resetState()
      addLog('已离开共享世界')
    }
  }

  // ========== LAN 检测 ==========

  /**
   * 等待 MC 客户端开启局域网后检测到端口
   * 利用已有的 LAN 检测器 (window.api.p2p)
   */
  function waitForLanPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.api.p2p.stopLanDetector()
        reject(new Error('等待 LAN 端口超时 (120s)'))
      }, 120000)

      window.api.p2p.onLanGames((games: Array<{ port: number }>) => {
        if (games.length > 0) {
          clearTimeout(timeout)
          window.api.p2p.stopLanDetector()
          resolve(games[0].port)
        }
      })

      window.api.p2p.startLanDetector()
    })
  }

  // ========== P2P 代理 ==========

  /**
   * 初始化 WebRTC 管理器 + LAN 检测 + 代理管线
   * 在选举完成后调用
   */
  function initWebRTC() {
    if (!signaling) return

    webrtcManager = new WebRTCManager(signaling, {
      stunServers: settings.stunServers,
      turnServers: settings.turnServers,
      relayServers: settings.relayServers,
      enableIPv6: settings.enableIPv6,
      relayFallback: settings.relayFallback,
    })

    webrtcManager.setRole(myRole.value === 'host' ? 'host' : 'guest')

    webrtcManager.on('peers-updated', (peerList: P2PPeer[]) => {
      peers.value = peerList
    })

    webrtcManager.on('peer-connected', async (peerId: string) => {
      addLog(`Peer ${peerId.substring(0, 6)} 已连接`)

      if (myRole.value === 'host' && mcLanPort.value > 0) {
        // 房主: 为新连接的 peer 启动代理
        try {
          await window.api.p2p.startHostProxy(peerId, mcLanPort.value)
          addLog(`已为 ${peerId.substring(0, 6)} 启动代理 → MC:${mcLanPort.value}`)
          webrtcManager!.sendToPeer(peerId, new TextEncoder().encode('__MC_LAN_READY'))
        } catch (proxyErr: any) {
          addLog(`代理启动失败: ${proxyErr.message}`)
          webrtcManager!.sendToPeer(peerId, new TextEncoder().encode('__PROXY_FAILED'))
        }
      } else if (myRole.value === 'client') {
        // 客户端: 启动本地代理，等待 __MC_LAN_READY
        const result = await window.api.p2p.startClientProxy(peerId)
        localPort.value = result.port
        addLog(`本地代理端口: ${result.port}，等待房主开启 MC 局域网...`)
      }

      setupDataBridge(peerId)
    })

    webrtcManager.on('peer-error', (peerId: string, err: string) => {
      addLog(`连接 ${peerId.substring(0, 6)} 失败: ${err}`)
    })

    // 监听来自信令的 offer (房主接收客人的 offer)
    signaling.on('offer', (msg: any) => {
      if (msg.fromPeerId) {
        const peerName = msg.peerName || msg.fromPeerId.substring(0, 6)
        webrtcManager!.connectToPeer(msg.fromPeerId, peerName, false)
      }
    })

    // 处理来自 peer 的数据
    webrtcManager.on('data-from-peer', async (_peerId: string, data: Uint8Array) => {
      const text = new TextDecoder().decode(data)

      if (text === '__MC_LAN_READY' && myRole.value === 'client') {
        addLog('房主已开启 MC 局域网')
        if (localPort.value > 0) {
          await window.api.p2p.startLanBroadcast(_peerId, localPort.value, '共享世界')
          addLog('MC 多人游戏列表中已自动显示服务器')
        }
        // Plan C: 写入 reconnect hint 以便 mod 自动重连
        if (currentGameDir) {
          await window.api.reconnect.writeHint(currentGameDir, '127.0.0.1', localPort.value)
        }
        return
      }

      if (text === '__PROXY_FAILED' && myRole.value === 'client') {
        addLog('⚠️ 房主端代理启动失败')
        error.value = '房主端代理启动失败'
        return
      }

      // 普通数据: 转发到本地 MC
      window.api.p2p.sendToMc(_peerId, data)
    })

    // 监听信令 peer 事件
    const onPeerJoined = (msg: any) => {
      addLog(`${msg.peerName || '玩家'} 加入了房间`)
    }
    signaling.on('peer-joined', onPeerJoined)
    cleanupFns.push(() => signaling?.off('peer-joined', onPeerJoined))

    const onPeerLeft = (msg: any) => {
      addLog('玩家离开')
      webrtcManager?.disconnectPeer(msg.peerId)
      window.api.p2p.destroyProxy(msg.peerId)
    }
    signaling.on('peer-left', onPeerLeft)
    cleanupFns.push(() => signaling?.off('peer-left', onPeerLeft))

    // 房主: 持续监听 LAN 端口变化 (用户可能重新开局域网)
    if (myRole.value === 'host') {
      window.api.p2p.startLanDetector()
      const unsub = window.api.p2p.onLanGames(async (games: Array<{ port: number }>) => {
        if (games.length > 0) {
          const port = games[0].port
          if (mcLanPort.value !== port) {
            mcLanPort.value = port
            addLog(`检测到 MC LAN 端口: ${port}`)
            // 为所有已连接的 peer 启动代理
            for (const p of peers.value) {
              if (p.state === 'connected') {
                try {
                  await window.api.p2p.startHostProxy(p.id, port)
                  webrtcManager?.sendToPeer(p.id, new TextEncoder().encode('__MC_LAN_READY'))
                } catch (proxyErr: any) {
                  addLog(`为 ${p.name} 启动代理失败: ${proxyErr.message}`)
                }
              }
            }
          }
        }
      })
      cleanupFns.push(unsub)
    }
  }

  /**
   * MC ↔ WebRTC 数据桥接
   */
  function setupDataBridge(proxyId: string) {
    const unsub = window.api.p2p.onDataFromMc((id: string, data: Buffer) => {
      if (id === proxyId && webrtcManager) {
        webrtcManager.sendToPeer(proxyId, new Uint8Array(data))
      }
    })
    cleanupFns.push(unsub)
  }

  /**
   * 选举完成后启动 P2P 管线
   * - 房主: 等待客人连接
   * - 客户端: 主动连接房主
   */
  function startP2PPipeline() {
    initWebRTC()

    // 客户端主动向房主发起 WebRTC 连接
    if (myRole.value === 'client' && hostInfo.value && webrtcManager) {
      addLog(`正在与房主建立 P2P 连接...`)
      webrtcManager.connectToPeer(hostInfo.value.peerId, hostInfo.value.peerName, true)
    }
  }

  // ========== 世界列表管理 ==========

  function addWorldToList(world: SharedWorld) {
    const existing = worlds.value.findIndex(w => w.roomCode === world.roomCode)
    if (existing >= 0) {
      worlds.value[existing] = { ...worlds.value[existing], ...world }
    } else {
      worlds.value.push(world)
    }
    persistWorlds()
  }

  function removeWorldFromList(roomCode: string) {
    worlds.value = worlds.value.filter(w => w.roomCode !== roomCode)
    persistWorlds()
  }

  function persistWorlds() {
    try {
      localStorage.setItem('shared-worlds', JSON.stringify(worlds.value))
    } catch { /* ignore */ }
  }

  function loadWorlds() {
    try {
      const data = localStorage.getItem('shared-worlds')
      if (data) {
        worlds.value = JSON.parse(data)
      }
    } catch { /* ignore */ }
  }

  // ========== 内部 ==========

  function resetState() {
    electionState.value = 'idle'
    hostInfo.value = null
    myRole.value = null
    transferProgress.value = null
    currentWorld.value = null
    roomCode.value = ''
    error.value = ''
    peers.value = []
    mcLanPort.value = 0
    localPort.value = 0
    currentGameDir = ''
  }

  // 初始加载
  loadWorlds()

  return {
    // 状态
    worlds,
    currentWorld,
    electionState,
    hostInfo,
    myRole,
    transferProgress,
    logs,
    error,
    roomCode,
    peers,
    mcLanPort,
    localPort,

    // 计算属性
    isActive,
    isHost,
    isConnected,

    // 操作
    createWorld,
    joinWorld,
    leaveWorld,
    removeWorldFromList,

    // 工具
    addLog,
  }
})
