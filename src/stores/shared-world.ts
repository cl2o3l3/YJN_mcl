/**
 * Shared World Store (Pinia)
 * 管理共享世界全流程: 创建/加入/主机选举/存档同步
 * 方案 A: 使用 MC 客户端内置 "Open to LAN" + P2P 代理
 */

import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { SignalingClient } from '../services/signaling-client'
import { HostElection, type ElectionState, type HostInfo } from '../services/host-election'
import { WebRTCManager } from '../services/webrtc-manager'
import { SaveSender, SaveReceiver, type TransferProgress } from '../services/save-transfer'
import type { ModLoaderInfo, P2PPeer } from '../types'
import { useSettingsStore } from './settings'

// ========== 类型 ==========

export interface SharedWorld {
  roomCode: string
  worldName: string
  mcVersion: string
  modLoader?: ModLoaderInfo
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
  let leaveInProgress = false
  let launchExitListenerSetup = false
  let preDistributedSave = false
  let cachedPackedSave: { archivePath: string; size: number; sha1: string; worldName: string } | null = null

  // P2P 状态
  const peers = ref<P2PPeer[]>([])
  const mcLanPort = ref(0)
  const localPort = ref(0)
  let hostLanReadyPending = false
  let hostLanReadyPeerId = ''
  let hostLanActivatedPeerId = ''

  // 房间成员 (信令层级，含所有已加入玩家)
  const roomMembers = ref<{ id: string, name: string }[]>([])
  const myPeerId = ref('')

  // 当前游戏目录 (用于写 reconnect hint)
  let currentGameDir = ''

  // ========== 计算属性 ==========

  const isActive = computed(() => electionState.value !== 'idle')
  const isHost = computed(() => myRole.value === 'host')
  const isConnected = computed(() =>
    electionState.value === 'connected' || electionState.value === 'hosting'
  )

  // 当 currentWorld 变化时，同步 worldMeta 到 election + 广播给所有 peer
  watch(currentWorld, (world) => {
    if (world && election) {
      election.setWorldMeta({
        worldName: world.worldName,
        mcVersion: world.mcVersion,
        modLoader: world.modLoader,
      })
    }
    if (world && myRole.value === 'host' && webrtcManager) {
      broadcastWorldMeta(world)
    }
  })

  function broadcastWorldMeta(world: SharedWorld) {
    if (!webrtcManager) return
    const payload = JSON.stringify({
      worldName: world.worldName,
      mcVersion: world.mcVersion,
      modLoader: world.modLoader || null,
    })
    const msg = new TextEncoder().encode('__WORLD_META:' + payload)
    for (const p of peers.value) {
      if (p.state === 'connected') {
        webrtcManager.sendToPeer(p.id, msg)
      }
    }
  }

  // ========== 工具 ==========

  function addLog(msg: string) {
    const time = new Date().toLocaleTimeString()
    logs.value.push(`[${time}] ${msg}`)
    // 限制日志条数
    if (logs.value.length > 500) {
      logs.value = logs.value.slice(-300)
    }
  }

  async function activateClientLan(peerId: string, logMessage = '房主已开启 MC 局域网') {
    if (hostLanActivatedPeerId === peerId && localPort.value > 0) return

    if (localPort.value > 0) {
      hostLanActivatedPeerId = peerId
      addLog(logMessage)
      await window.api.p2p.startLanBroadcast(peerId, localPort.value, '共享世界')
      addLog('MC 多人游戏列表中已自动显示服务器')
      if (currentGameDir) {
        await window.api.reconnect.writeHint(currentGameDir, '127.0.0.1', localPort.value)
      }
    } else {
      hostLanReadyPending = true
      hostLanReadyPeerId = peerId
      addLog(`${logMessage}（等待本地代理就绪...）`)
    }
  }

  async function prepareLatestSaveArchive() {
    if (cachedPackedSave) return cachedPackedSave
    if (!currentGameDir) throw new Error('未设置游戏目录')

    const saves = await window.api.save.list(currentGameDir)
    if (saves.length === 0) throw new Error('未找到任何存档')
    const latest = saves.sort((a: any, b: any) => b.lastModified - a.lastModified)[0]
    addLog(`正在打包存档 ${latest.name}...`)

    const packed = await window.api.save.pack(latest.path)
    cachedPackedSave = {
      archivePath: packed.archivePath,
      size: packed.size,
      sha1: packed.sha1,
      worldName: packed.worldName,
    }

    if (!currentWorld.value || currentWorld.value.worldName !== packed.worldName) {
      currentWorld.value = {
        roomCode: roomCode.value,
        worldName: packed.worldName,
        mcVersion: currentWorld.value?.mcVersion || '',
        modLoader: currentWorld.value?.modLoader,
        createdAt: currentWorld.value?.createdAt || Date.now(),
      }
    }

    return cachedPackedSave
  }

  async function distributeSaveToAllPeersOnExit() {
    if (!webrtcManager || !isHost.value) return

    const connectedPeers = peers.value.filter(p => p.state === 'connected')
    if (connectedPeers.length === 0) {
      addLog('房间内没有已连接玩家，跳过存档广播')
      return
    }

    const packed = await prepareLatestSaveArchive()
    const fileData = await window.api.save.readArchive(packed.archivePath)

    addLog(`检测到游戏退出，正在向 ${connectedPeers.length} 位玩家广播存档 (${(packed.size / 1024 / 1024).toFixed(1)} MB)...`)

    const results = await Promise.allSettled(connectedPeers.map((peer) => {
      const pc = webrtcManager?.getPeerConnection(peer.id)
      if (!pc) {
        addLog(`${peer.name || peer.id.substring(0, 6)} 无 WebRTC 连接，跳过发送`)
        return Promise.resolve(false)
      }

      return new Promise<boolean>((resolve) => {
        const sender = new SaveSender(
          (progress) => { transferProgress.value = progress },
          (success, err) => {
            transferProgress.value = null
            if (!success) {
              addLog(`发送给 ${peer.name || peer.id.substring(0, 6)} 失败: ${err}`)
            }
            resolve(success)
          }
        )
        sender.send(pc, fileData, packed.sha1, packed.worldName).catch(() => resolve(false))
      })
    }))

    const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length
    preDistributedSave = successCount > 0
    addLog(`✓ 存档广播完成: ${successCount}/${connectedPeers.length} 成功`)
  }

  function setupLaunchExitListener() {
    if (launchExitListenerSetup) return
    launchExitListenerSetup = true

    window.api.launch.onExit(async () => {
      if (!isActive.value || !isHost.value || leaveInProgress) return
      addLog('检测到 MC 已退出，正在向房间内玩家发送存档并离开共享世界...')
      try {
        await distributeSaveToAllPeersOnExit()
      } catch (e: any) {
        addLog(`退出时广播存档失败: ${e.message}`)
      }
      await leaveWorld()
    })
  }

  // ========== 创建房间 ==========

  setupLaunchExitListener()

  async function createWorld(config: {
    playerName: string
  }): Promise<string> {
    error.value = ''

    try {
      signaling = new SignalingClient()
      await signaling.connect(settings.signalingServer)
      myPeerId.value = signaling.peerId
      addLog('已连接到信令服务器')

      election = new HostElection(signaling, createElectionEvents())

      const code = await election.createWorld(config.playerName)
      roomCode.value = code
      // 房主自己就是第一个成员
      roomMembers.value = [{ id: signaling!.peerId, name: config.playerName }]

      startP2PPipeline()

      addLog(`✓ 房间已创建，房间码: ${code}`)
      return code
    } catch (e: any) {
      error.value = e.message
      addLog(`创建失败: ${e.message}`)
      await cleanupSession(false)
      throw e
    }
  }

  // ========== 加入房间 ==========

  async function joinWorld(config: {
    playerName: string
    roomCode: string
  }): Promise<void> {
    error.value = ''

    try {
      signaling = new SignalingClient()
      await signaling.connect(settings.signalingServer)
      myPeerId.value = signaling.peerId
      addLog('已连接到信令服务器')

      election = new HostElection(signaling, createElectionEvents())

      roomCode.value = config.roomCode

      await election.joinWorld(config.roomCode, config.playerName)
      myRole.value = election.getRole()

      // 从 election 获取已有成员列表 (room-joined.peers) + 自己
      const existingPeers = election.getRoomPeers?.() || []
      roomMembers.value = [
        ...existingPeers,
        { id: signaling!.peerId, name: config.playerName },
      ]

      startP2PPipeline()

      // 从服务端获取 worldMeta
      const meta = election.getWorldMeta()
      if (meta && meta.worldName) {
        currentWorld.value = {
          roomCode: config.roomCode,
          worldName: meta.worldName,
          mcVersion: meta.mcVersion,
          modLoader: meta.modLoader,
          createdAt: Date.now(),
        }
      }

      addLog(`✓ 已加入房间 (${config.roomCode})`)
    } catch (e: any) {
      error.value = e.message
      addLog(`加入失败: ${e.message}`)
      await cleanupSession(false)
      throw e
    }
  }

  /**
   * 设置游戏目录（进入房间后选择实例时调用）
   */
  function setGameDir(gameDir: string) {
    currentGameDir = gameDir
    addLog(`已设置游戏目录: ${gameDir}`)
  }

  /**
   * 创建公共选举事件回调
   */
  function createElectionEvents() {
    return {
      onStateChange: (state: ElectionState) => { electionState.value = state },
      onHostChange: (host: HostInfo | null) => {
        hostInfo.value = host
        if (election) myRole.value = election.getRole()
      },
      onNeedTransferHost: async (_suggestedName: string) => {
        return prepareLatestSaveArchive()
      },
      onNeedReceiveSave: async (archivePath: string, sha1: string, worldName: string) => {
        addLog(`正在解包存档 ${worldName}...`)
        if (!currentGameDir) throw new Error('未设置游戏目录')
        const targetDir = `${currentGameDir}/saves/${worldName}`
        await window.api.save.unpack(archivePath, targetDir, sha1)
        addLog('✓ 存档已解包')
      },
      onTransferProgress: (progress: TransferProgress) => {
        transferProgress.value = progress
      },
      onTransferSaveToPeer: async (candidatePeerId: string, archivePath: string, sha1: string, _size: number, worldName: string) => {
        if (preDistributedSave) {
          addLog('存档已在退出时广播给房间内玩家，跳过候选人定向传输')
          return true
        }

        const pc = webrtcManager?.getPeerConnection(candidatePeerId)
        if (!pc) {
          addLog('候选人无 WebRTC 连接，无法传输存档')
          return false
        }

        // 读取打包好的存档到内存
        const fileData = await window.api.save.readArchive(archivePath)

        return new Promise<boolean>((resolve) => {
          const sender = new SaveSender(
            (progress) => { transferProgress.value = progress },
            (success, err) => {
              transferProgress.value = null
              if (success) {
                addLog('✓ 存档通过 WebRTC 传输完成')
                resolve(true)
              } else {
                addLog(`存档传输失败: ${err}`)
                resolve(false)
              }
            }
          )
          sender.send(pc, fileData, sha1, worldName).catch(() => resolve(false))
        })
      },
      onCheckLocalSave: async (worldName: string) => {
        if (!currentGameDir) return false
        try {
          const saves = await window.api.save.list(currentGameDir)
          return saves.some((s: any) => s.name === worldName)
        } catch {
          return false
        }
      },
      onLog: addLog,
    }
  }

  // ========== 离开共享世界 ==========

  async function leaveWorld(): Promise<void> {
    if (leaveInProgress) return
    leaveInProgress = true

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
      await cleanupSession(false)
    } catch (e: any) {
      addLog(`离开时出错: ${e.message}`)
    } finally {
      resetState()
      leaveInProgress = false
      addLog('已离开共享世界')
    }
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

        // 监听来自主机的存档传输 (主机迁移时触发)
        const pc = webrtcManager?.getPeerConnection(peerId)
        if (pc) {
          setupSaveReceiver(pc)
        }

        if (hostLanReadyPending && localPort.value > 0) {
          hostLanReadyPending = false
          await activateClientLan(hostLanReadyPeerId || peerId)
        }

        // 兜底: 如果从信令已知主机正在托管 LAN，则不必只依赖单次 __MC_LAN_READY 消息
        if (hostInfo.value?.peerId === peerId && (hostInfo.value.mcPort || 0) > 0) {
          await activateClientLan(peerId, '根据房间状态检测到主机已开启 MC 局域网')
        }

        webrtcManager!.sendToPeer(peerId, new TextEncoder().encode('__CLIENT_READY'))
      }

      setupDataBridge(peerId)

      if (myRole.value === 'host' && currentWorld.value) {
        const payload = JSON.stringify({
          worldName: currentWorld.value.worldName,
          mcVersion: currentWorld.value.mcVersion,
          modLoader: currentWorld.value.modLoader || null,
        })
        webrtcManager!.sendToPeer(peerId, new TextEncoder().encode('__WORLD_META:' + payload))
      }
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

      if (text.startsWith('__WORLD_META:') && myRole.value === 'client') {
        try {
          const meta = JSON.parse(text.slice('__WORLD_META:'.length))
          currentWorld.value = {
            roomCode: roomCode.value,
            worldName: meta.worldName || currentWorld.value?.worldName || '共享房间',
            mcVersion: meta.mcVersion || '',
            modLoader: meta.modLoader || undefined,
            createdAt: currentWorld.value?.createdAt || Date.now(),
          }
          addLog(`主机版本: ${meta.mcVersion || '未知'}${meta.modLoader ? ' · ' + meta.modLoader.type + ' ' + meta.modLoader.version : ''}`)
        } catch {
          // ignore parse errors
        }
        return
      }

      if (text === '__CLIENT_READY' && myRole.value === 'host' && mcLanPort.value > 0) {
        webrtcManager?.sendToPeer(_peerId, new TextEncoder().encode('__MC_LAN_READY'))
        return
      }

      if (text === '__MC_LAN_READY' && myRole.value === 'client') {
        await activateClientLan(_peerId)
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
      const name = msg.peerName || '玩家'
      addLog(`${name} 加入了房间`)
      // 更新房间成员列表
      if (!roomMembers.value.some(m => m.id === msg.peerId)) {
        roomMembers.value = [...roomMembers.value, { id: msg.peerId, name }]
      }
    }
    signaling.on('peer-joined', onPeerJoined)
    cleanupFns.push(() => signaling?.off('peer-joined', onPeerJoined))

    const onPeerLeft = (msg: any) => {
      addLog('玩家离开')
      roomMembers.value = roomMembers.value.filter(m => m.id !== msg.peerId)
      webrtcManager?.disconnectPeer(msg.peerId)
      window.api.p2p.destroyProxy(msg.peerId)
    }
    signaling.on('peer-left', onPeerLeft)
    cleanupFns.push(() => signaling?.off('peer-left', onPeerLeft))

    // 被动 LAN 检测: 任何人在 MC 中开启局域网 → 自动竞选主机
    window.api.p2p.startLanDetector()
    const unsubLan = window.api.p2p.onLanGames(async (games: Array<{ port: number }>) => {
      if (games.length === 0) return
      const port = games[0].port
      if (mcLanPort.value === port) return

      mcLanPort.value = port
      addLog(`检测到 MC LAN 端口: ${port}`)

      if (myRole.value !== 'host') {
        // 尚未成为主机 → 尝试注册为主机
        if (election) {
          try {
            await election.becomeHost(port)
            myRole.value = election.getRole()
            if (myRole.value === 'host') {
              // 为已连接的 peer 启动代理
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
          } catch {
            // becomeHost 失败 (host-conflict), election 已处理状态
          }
        }
      } else {
        // 已经是主机，LAN 端口变更 → 更新代理
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
    })
    cleanupFns.push(unsubLan)

    // 监听 host-changed: 当新主机出现时，非主机 peer 自动发起 WebRTC 连接
    const onHostChangedP2P = (msg: any) => {
      if (msg.hostId && msg.hostId !== signaling!.peerId && webrtcManager) {
        // 同步角色（joinWorld 时可能无主机导致 myRole 为 null）
        if (!myRole.value && election) myRole.value = election.getRole()
        addLog('正在与主机建立 P2P 连接...')
        webrtcManager.connectToPeer(msg.hostId, msg.hostName || '主机', true)
      }
    }
    signaling.on('host-changed', onHostChangedP2P)
    cleanupFns.push(() => signaling?.off('host-changed', onHostChangedP2P))
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
   * 客户端: 监听来自主机的存档传输
   * 当主机迁移离开时，会通过 WebRTC DataChannel 发送存档
   */
  function setupSaveReceiver(pc: RTCPeerConnection) {
    const receiver = new SaveReceiver(
      (progress) => { transferProgress.value = progress },
      (success, err) => {
        transferProgress.value = null
        if (!success) addLog(`存档接收失败: ${err}`)
      }
    )

    receiver.listen(pc).then(async ({ data, worldName: receivedWorldName }) => {
      addLog('✓ 存档接收完成，正在解包...')
      if (!currentGameDir) {
        addLog('⚠️ 未设置游戏目录，无法解包存档')
        return
      }
      const worldName = receivedWorldName || currentWorld.value?.worldName || 'shared-world'
      try {
        await window.api.save.unpackBuffer(data, currentGameDir, worldName)
        addLog(`✓ 存档已解包到 saves/${worldName}`)
        // 更新 worldMeta 以便 tryAutoElection 能找到这个存档
        if (election) election.setWorldMeta({
          worldName,
          mcVersion: currentWorld.value?.mcVersion || '',
          modLoader: currentWorld.value?.modLoader,
        })
        addLog('请在 MC 中加载该存档并开启「对局域网开放」以成为新主机')
      } catch (e: any) {
        addLog(`解包失败: ${e.message}`)
      }
    }).catch((err) => {
      // 连接关闭或传输取消时可能触发，非致命
      if (electionState.value !== 'idle') {
        addLog(`存档监听中断: ${err.message}`)
      }
    })
  }

  /**
   * 启动 P2P 管线 + 被动 LAN 检测
   * 创建/加入房间后立即调用，不依赖主机是否已选举
   */
  function startP2PPipeline() {
    initWebRTC()

    // 如果已有主机，主动发起 WebRTC 连接
    if (myRole.value === 'client' && hostInfo.value && webrtcManager) {
      addLog('正在与房主建立 P2P 连接...')
      webrtcManager.connectToPeer(hostInfo.value.peerId, hostInfo.value.peerName, true)
    }
  }

  async function cleanupSession(resetLogs = false) {
    try {
      window.api.p2p.destroyAllProxies().catch(() => {})
      window.api.p2p.stopAllLanBroadcasts().catch(() => {})
      window.api.p2p.stopLanDetector().catch(() => {})
      if (currentGameDir) {
        window.api.reconnect.clearHint(currentGameDir).catch(() => {})
      }
    } finally {
      for (const fn of cleanupFns) fn()
      cleanupFns = []
      webrtcManager?.destroy()
      webrtcManager = null
      election?.destroy()
      election = null
      signaling?.disconnect()
      signaling = null
      electionState.value = 'idle'
      hostInfo.value = null
      myRole.value = null
      transferProgress.value = null
      currentWorld.value = null
      roomCode.value = ''
      peers.value = []
      roomMembers.value = []
      myPeerId.value = ''
      mcLanPort.value = 0
      localPort.value = 0
      hostLanReadyPending = false
      hostLanReadyPeerId = ''
      hostLanActivatedPeerId = ''
      preDistributedSave = false
      cachedPackedSave = null
      currentGameDir = ''
      if (resetLogs) {
        logs.value = []
      }
    }
  }

  // ========== 世界列表管理 ==========

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
    roomMembers.value = []
    myPeerId.value = ''
    mcLanPort.value = 0
    localPort.value = 0
    hostLanReadyPending = false
    hostLanReadyPeerId = ''
    hostLanActivatedPeerId = ''
    preDistributedSave = false
    cachedPackedSave = null
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
    roomMembers,
    myPeerId,
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
    setGameDir,
    removeWorldFromList,

    // 工具
    addLog,
  }
})
