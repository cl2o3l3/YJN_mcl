/**
 * Multiplayer Store (Pinia)
 * 管理 P2P 联机全流程: 信令连接、房间管理、WebRTC、TCP 代理
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { P2PPeer, ConnectionTier, NetworkDiagnostics } from '../types'
import { SignalingClient } from '../services/signaling-client'
import { WebRTCManager } from '../services/webrtc-manager'
import { createManualOffer, acceptManualOffer, fetchTurnCredentials } from '../services/manual-exchange'
import { encodeModList, decodeModSyncMessage, isModSyncAck, encodeModSyncAck, diffModLists, type ModSyncDiff } from '../services/mod-sync'
import { decodeP2PControl, encodeP2PControl } from '../services/p2p-control'
import type { InstalledResource } from '../types'
import { useSettingsStore } from './settings'

export type MultiplayerState = 'idle' | 'connecting' | 'in-room'

export const useMultiplayerStore = defineStore('multiplayer', () => {
  const settings = useSettingsStore()

  // 状态
  const state = ref<MultiplayerState>('idle')
  const role = ref<'host' | 'guest' | null>(null)
  const roomCode = ref('')
  const roomId = ref('')
  const peers = ref<P2PPeer[]>([])
  const connectionTier = ref<ConnectionTier>('direct')
  const localPort = ref(0)       // 客人连接 MC 的本地端口
  const mcLanPort = ref(0)       // 房主 MC LAN 端口
  const logs = ref<string[]>([])
  const error = ref('')
  const playerName = ref('Player')
  const diagnostics = ref<NetworkDiagnostics | null>(null)
  const diagnosing = ref(false)

  // 手动交换状态
  type ManualPhase = 'idle' | 'host-generating' | 'host-offer' | 'host-connecting' | 'guest-generating' | 'guest-answer' | 'guest-connecting'
  const manualPhase = ref<ManualPhase>('idle')
  const manualOfferCode = ref('')
  const manualAnswerCode = ref('')

  // Mod 同步状态
  const modSyncDiff = ref<ModSyncDiff | null>(null)
  const modSyncStatus = ref<'idle' | 'syncing' | 'done'>('idle')
  const hostModList = ref<InstalledResource[]>([])

  // 内部
  let signaling: SignalingClient | null = null
  let webrtcManager: WebRTCManager | null = null
  let manualPc: RTCPeerConnection | null = null
  let manualDc: RTCDataChannel | null = null
  let manualApplyAnswer: ((code: string) => Promise<void>) | null = null
  let manualWaitOpen: (() => Promise<void>) | null = null
  let cleanupFns: (() => void)[] = []

  const isHost = computed(() => role.value === 'host')
  const isGuest = computed(() => role.value === 'guest')
  const isInRoom = computed(() => state.value === 'in-room')

  // 最近一起玩的玩家
  interface RecentPlayer { name: string; lastSeen: number }
  const recentPlayers = ref<RecentPlayer[]>(loadRecentPlayers())

  function loadRecentPlayers(): RecentPlayer[] {
    try { return JSON.parse(localStorage.getItem('mc-recent-players') || '[]') } catch { return [] }
  }
  function saveRecentPlayers() {
    localStorage.setItem('mc-recent-players', JSON.stringify(recentPlayers.value.slice(0, 20)))
  }
  function trackPlayer(name: string) {
    const idx = recentPlayers.value.findIndex(p => p.name === name)
    if (idx >= 0) recentPlayers.value.splice(idx, 1)
    recentPlayers.value.unshift({ name, lastSeen: Date.now() })
    if (recentPlayers.value.length > 20) recentPlayers.value.length = 20
    saveRecentPlayers()
  }

  function addLog(msg: string) {
    const time = new Date().toLocaleTimeString()
    logs.value.push(`[${time}] ${msg}`)
    if (logs.value.length > 200) logs.value.splice(0, 50)
  }

  // ========== 信令连接 ==========

  function connectSignaling(): Promise<void> {
    if (!settings.signalingServer) {
      return Promise.reject(new Error('请先在设置中配置信令服务器地址'))
    }

    signaling = new SignalingClient()

    signaling.on('waking-up', () => {
      addLog('正在唤醒信令服务器（首次连接可能需要等待）...')
    })

    signaling.on('disconnected', () => {
      addLog('与信令服务器断开连接')
    })

    signaling.on('reconnecting', (attempt: number) => {
      addLog(`正在重连信令服务器 (${attempt}/3)...`)
    })

    signaling.on('reconnect-failed', () => {
      addLog('重连失败，请检查网络')
      error.value = '信令服务器连接失败'
    })

    signaling.on('error', (msg: any) => {
      addLog(`错误: ${msg.message}`)
      error.value = msg.message
    })

    return signaling.connect(settings.signalingServer)
  }

  // ========== 创建房间 (房主) ==========

  async function createRoom(name: string, gameVersion: string = ''): Promise<void> {
    error.value = ''
    state.value = 'connecting'
    playerName.value = name

    try {
      await connectSignaling()
    } catch (err: any) {
      state.value = 'idle'
      error.value = err.message
      throw err
    }

    // 等待 room-created
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('创建房间超时'))
        state.value = 'idle'
      }, 10000)

      signaling!.on('room-created', (msg: any) => {
        clearTimeout(timeout)
        roomId.value = msg.roomId
        roomCode.value = msg.roomCode
        role.value = 'host'
        state.value = 'in-room'
        signaling!.setRoomId(msg.roomId)
        addLog(`房间已创建, 房间码: ${msg.roomCode}`)
        setupHostListeners()
        resolve()
      })

      signaling!.createRoom(name, gameVersion)
    })
  }

  // ========== 加入房间 (客人) ==========

  async function joinRoom(code: string, name: string): Promise<void> {
    error.value = ''
    state.value = 'connecting'
    playerName.value = name

    try {
      await connectSignaling()
    } catch (err: any) {
      state.value = 'idle'
      error.value = err.message
      throw err
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('加入房间超时'))
        state.value = 'idle'
      }, 10000)

      signaling!.on('room-joined', async (msg: any) => {
        clearTimeout(timeout)
        roomId.value = msg.roomId
        roomCode.value = code
        role.value = 'guest'
        state.value = 'in-room'
        signaling!.setRoomId(msg.roomId)
        addLog(`已加入房间`)

        setupGuestListeners()

        // 与已有 peers 建立连接
        for (const p of msg.peers) {
          addLog(`正在连接 ${p.name}...`)
          webrtcManager!.connectToPeer(p.id, p.name, true)
        }

        resolve()
      })

      signaling!.on('error', (msg: any) => {
        clearTimeout(timeout)
        reject(new Error(msg.message))
        state.value = 'idle'
      })

      signaling!.joinRoom(code, name)
    })
  }

  // ========== 房主监听 ==========

  function setupHostListeners() {
    initWebRTC()

    const handleHostLanPortDetected = async (port: number, source: 'broadcast' | 'log' = 'broadcast') => {
      if (mcLanPort.value === port) return
      mcLanPort.value = port
      addLog(source === 'log' ? `从游戏日志识别到 MC LAN 端口: ${port}` : `检测到 MC LAN 端口: ${port}`)
      for (const p of peers.value) {
        if (p.state === 'connected') {
          try {
            await window.api.p2p.startHostProxy(p.id, port)
            addLog(`已为 ${p.name} 启动代理 → MC:${port}`)
            webrtcManager?.sendToPeer(p.id, encodeP2PControl('mc-lan-ready'))
          } catch (proxyErr: any) {
            addLog(`为 ${p.name} 启动代理失败: ${proxyErr.message}`)
            webrtcManager?.sendToPeer(p.id, encodeP2PControl('proxy-failed'))
          }
        }
      }
    }

    signaling!.on('peer-joined', (msg: any) => {
      addLog(`${msg.peerName} 加入了房间`)
      // 房主等待客人发 offer
    })

    signaling!.on('offer', () => {
      // WebRTC manager 内部处理
    })

    signaling!.on('peer-left', (msg: any) => {
      addLog(`玩家离开`)
      webrtcManager?.disconnectPeer(msg.peerId)
      window.api.p2p.destroyProxy(msg.peerId)
    })

    signaling!.on('room-closed', () => {
      addLog('房间已关闭')
      cleanup()
    })

    // 启动 LAN 检测
    window.api.p2p.startLanDetector()
    const unsub = window.api.p2p.onLanGames(async (games) => {
      if (games.length > 0) {
        await handleHostLanPortDetected(games[0].port, 'broadcast')
      }
    })
    cleanupFns.push(unsub)

    const unsubLaunchLan = window.api.launch.onLanPortDetected((port) => {
      void handleHostLanPortDetected(port, 'log')
    })
    cleanupFns.push(unsubLaunchLan)
  }

  // ========== 客人监听 ==========

  function setupGuestListeners() {
    initWebRTC()

    signaling!.on('peer-joined', (msg: any) => {
      addLog(`${msg.peerName} 加入了房间`)
    })

    signaling!.on('peer-left', (msg: any) => {
      addLog(`玩家离开`)
      webrtcManager?.disconnectPeer(msg.peerId)
    })

    signaling!.on('room-closed', (msg: any) => {
      addLog(`房间已关闭: ${msg.reason}`)
      cleanup()
    })
  }

  // ========== WebRTC 初始化 ==========

  function initWebRTC() {
    if (!signaling) return

    webrtcManager = new WebRTCManager(signaling, {
      stunServers: settings.stunServers,
      turnServers: settings.turnServers,
      relayServers: settings.relayServers,
      enableIPv6: settings.enableIPv6,
      relayFallback: settings.relayFallback
    })

    webrtcManager.setRole(role.value!)

    webrtcManager.on('peers-updated', (peerList: P2PPeer[]) => {
      peers.value = peerList
      // 推送到 overlay
      window.api.overlay.updatePeers(peerList).catch(() => {})
    })

    webrtcManager.on('peer-connected', async (peerId: string) => {
      // 显示 overlay
      window.api.overlay.show().catch(() => {})
      const peerTier = webrtcManager!.getPeerTier(peerId)
      if (peerTier) connectionTier.value = peerTier
      addLog(`已连接 (${tierLabel(peerTier || 'direct')})`)
      // 记录最近玩家
      const peer = peers.value.find(p => p.id === peerId)
      if (peer) trackPlayer(peer.name)

      // 启动 TCP 代理
      if (role.value === 'host' && mcLanPort.value > 0) {
        try {
          await window.api.p2p.startHostProxy(peerId, mcLanPort.value)
          addLog(`已为 ${peerId.substring(0, 6)} 启动代理 → MC:${mcLanPort.value}`)
          // 通知客人：MC LAN 已就绪
          webrtcManager!.sendToPeer(peerId, encodeP2PControl('mc-lan-ready'))
        } catch (proxyErr: any) {
          addLog(`代理启动失败: ${proxyErr.message}`)
          webrtcManager!.sendToPeer(peerId, encodeP2PControl('proxy-failed'))
        }
      } else if (role.value === 'guest') {
        // 先启动本地代理，但不广播 LAN
        const result = await window.api.p2p.startClientProxy(peerId)
        localPort.value = result.port
        addLog(`本地代理端口: ${result.port}，等待房主开启 MC 局域网...`)
      }

      // 桥接 TCP 代理数据 ↔ WebRTC
      setupDataBridge(peerId)
    })

    webrtcManager.on('peer-error', (peerId: string, err: string) => {
      addLog(`连接 ${peerId.substring(0, 6)} 失败: ${err}`)
    })

    // 监听来自信令的 offer (对于房主接收客人的 offer)
    signaling.on('offer', (msg: any) => {
      if (msg.fromPeerId) {
        const peerName = msg.peerName || msg.fromPeerId.substring(0, 6)
        webrtcManager!.connectToPeer(msg.fromPeerId, peerName, false)
      }
    })

    webrtcManager.on('data-from-peer', async (_peerId: string, data: Uint8Array) => {
      // 检查控制消息
      const control = decodeP2PControl(data)
      if (control?.type === 'mc-lan-ready' && role.value === 'guest') {
        addLog('房主已开启 MC 局域网')
        if (localPort.value > 0) {
          await window.api.p2p.startLanBroadcast(_peerId, localPort.value, 'P2P 联机')
          addLog('MC 多人游戏列表中已自动显示服务器')
          try {
            await navigator.clipboard.writeText(`localhost:${localPort.value}`)
            addLog('连接地址已自动复制到剪贴板')
          } catch { /* 剪贴板不可用 */ }
        }
        return
      }
      if (control?.type === 'proxy-failed' && role.value === 'guest') {
        addLog('⚠️ 房主端代理启动失败，连接可能不可用')
        error.value = '房主端代理启动失败'
        return
      }
      // Mod 同步消息
      if (control?.type === 'mod-sync') {
        // 客人端存储房主的 mod 列表，待 UI 获取 gameDir 后进行 diff
        const remoteMods = decodeModSyncMessage(data)
        if (remoteMods) {
          hostModList.value = remoteMods
          modSyncStatus.value = 'done'
          addLog(`收到房主 mod 列表 (${remoteMods.length} 个)`)
        }
        return
      }
      if (isModSyncAck(data)) {
        addLog('客人已确认收到 mod 列表')
        return
      }
      // 普通数据: 转发到本地 MC
      window.api.p2p.sendToMc(_peerId, data)
    })
  }

  function setupDataBridge(proxyId: string) {
    // MC → WebRTC: 从本地 MC 收到数据, 发给 peer
    const unsub = window.api.p2p.onDataFromMc((id: string, data: Buffer) => {
      if (id === proxyId && webrtcManager) {
        webrtcManager.sendToPeer(proxyId, new Uint8Array(data))
      }
    })
    cleanupFns.push(unsub)
  }

  // ========== 手动交换模式 ==========

  async function createManualRoom(name: string): Promise<void> {
    error.value = ''
    state.value = 'connecting'
    manualPhase.value = 'host-generating'
    playerName.value = name
    role.value = 'host'
    addLog('正在获取 TURN 凭据并生成邀请码...')

    try {
      // 并行获取 TURN 凭据
      const turnServers = await fetchTurnCredentials()
      if (turnServers.length > 0) {
        addLog('TURN 凭据已获取，校园网也能连')
      } else {
        addLog('TURN 不可用，将仅尝试直连')
      }

      const result = await createManualOffer(settings.stunServers, turnServers)
      manualPc = result.pc
      manualDc = result.dc
      manualApplyAnswer = result.applyAnswer
      manualWaitOpen = result.waitOpen
      manualOfferCode.value = result.offerCode
      manualPhase.value = 'host-offer'
      addLog(`邀请码已生成 (${result.offerCode.length} 字符)，请复制发给朋友`)
    } catch (err: any) {
      error.value = err.message
      state.value = 'idle'
      manualPhase.value = 'idle'
      role.value = null
    }
  }

  async function submitManualAnswer(answerCode: string): Promise<void> {
    if (!manualApplyAnswer || !manualWaitOpen || !manualDc) return
    error.value = ''
    manualPhase.value = 'host-connecting'
    addLog('正在建立连接...')

    try {
      await manualApplyAnswer(answerCode)
      await manualWaitOpen()
      addLog('WebRTC 直连成功！')
      connectionTier.value = 'direct'
      state.value = 'in-room'
      manualPhase.value = 'idle'

      setupManualHostBridge()
    } catch (err: any) {
      error.value = `连接失败: ${err.message}`
      addLog(`连接失败: ${err.message}`)
      manualPhase.value = 'host-offer'
    }
  }

  async function joinManualRoom(offerCode: string, name: string): Promise<void> {
    error.value = ''
    state.value = 'connecting'
    manualPhase.value = 'guest-generating'
    playerName.value = name
    role.value = 'guest'
    addLog('正在获取 TURN 凭据并解析邀请码...')

    try {
      const turnServers = await fetchTurnCredentials()
      if (turnServers.length > 0) {
        addLog('TURN 凭据已获取')
      }

      const result = await acceptManualOffer(offerCode, settings.stunServers, turnServers)
      manualPc = result.pc
      manualAnswerCode.value = result.answerCode
      manualPhase.value = 'guest-answer'
      addLog(`应答码已生成 (${result.answerCode.length} 字符)，请复制发回给房主`)

      // 等待 DC 打开 (房主粘贴应答码后连接建立)
      addLog('等待房主确认连接...')
      manualPhase.value = 'guest-answer'
      const dc = await result.dc
      manualDc = dc
      addLog('WebRTC 直连成功！')
      connectionTier.value = 'direct'
      state.value = 'in-room'
      manualPhase.value = 'idle'

      setupManualGuestBridge()
    } catch (err: any) {
      error.value = `连接失败: ${err.message}`
      addLog(`连接失败: ${err.message}`)
      state.value = 'idle'
      manualPhase.value = 'idle'
      role.value = null
    }
  }

  function setupManualHostBridge() {
    if (!manualDc) return
    const dc = manualDc
    const peerId = 'manual-peer'

    const handleManualHostLanPortDetected = async (port: number, source: 'broadcast' | 'log' = 'broadcast') => {
      if (mcLanPort.value === port) return
      mcLanPort.value = port
      addLog(source === 'log' ? `从游戏日志识别到 MC LAN 端口: ${port}` : `检测到 MC LAN 端口: ${port}`)
      await window.api.p2p.startHostProxy(peerId, port)
      addLog('已启动代理')
      if (dc.readyState === 'open') {
        dc.send(encodeP2PControl('mc-lan-ready') as unknown as ArrayBufferView<ArrayBuffer>)
      }
    }

    // 启动 LAN 检测
    window.api.p2p.startLanDetector()
    const unsub = window.api.p2p.onLanGames(async (games) => {
      if (games.length > 0) {
        await handleManualHostLanPortDetected(games[0].port, 'broadcast')
      }
    })
    cleanupFns.push(unsub)

    const unsubLaunchLan = window.api.launch.onLanPortDetected((port) => {
      void handleManualHostLanPortDetected(port, 'log')
    })
    cleanupFns.push(unsubLaunchLan)

    // DC → MC
    dc.onmessage = (e) => {
      const data = new Uint8Array(e.data as ArrayBuffer)
      if (isModSyncAck(data)) {
        addLog('客人已确认收到 mod 列表')
        return
      }
      window.api.p2p.sendToMc(peerId, data)
    }
    // MC → DC
    const unsub2 = window.api.p2p.onDataFromMc((id: string, data: Buffer) => {
      if (id === peerId && dc.readyState === 'open') {
        dc.send(new Uint8Array(data) as unknown as ArrayBufferView<ArrayBuffer>)
      }
    })
    cleanupFns.push(unsub2)
  }

  async function setupManualGuestBridge() {
    if (!manualDc) return
    const dc = manualDc
    const peerId = 'manual-peer'

    const result = await window.api.p2p.startClientProxy(peerId)
    localPort.value = result.port
    addLog(`本地代理端口: ${result.port}，等待房主开启 MC 局域网...`)

    // DC → MC (含控制消息处理)
    dc.onmessage = async (e) => {
      const data = new Uint8Array(e.data as ArrayBuffer)
      const control = decodeP2PControl(data)
      if (control?.type === 'mc-lan-ready') {
        addLog('房主已开启 MC 局域网')
        if (localPort.value > 0) {
          await window.api.p2p.startLanBroadcast(peerId, localPort.value, 'P2P 联机')
          addLog('MC 多人游戏列表中已自动显示服务器')
          try {
            await navigator.clipboard.writeText(`localhost:${localPort.value}`)
            addLog('连接地址已自动复制到剪贴板')
          } catch { /* 剪贴板不可用 */ }
        }
        return
      }
      if (control?.type === 'proxy-failed') {
        addLog('⚠️ 房主端代理启动失败，连接可能不可用')
        error.value = '房主端代理启动失败'
        return
      }
      if (control?.type === 'mod-sync') {
        const remoteMods = decodeModSyncMessage(data)
        if (remoteMods) {
          hostModList.value = remoteMods
          modSyncStatus.value = 'done'
          addLog(`收到房主 mod 列表 (${remoteMods.length} 个)`)
        }
        return
      }
      if (isModSyncAck(data)) return
      window.api.p2p.sendToMc(peerId, data)
    }
    // MC → DC
    const unsub = window.api.p2p.onDataFromMc((id: string, data: Buffer) => {
      if (id === peerId && dc.readyState === 'open') {
        dc.send(new Uint8Array(data) as unknown as ArrayBufferView<ArrayBuffer>)
      }
    })
    cleanupFns.push(unsub)
  }

  // ========== Mod 同步 ==========

  /** 房主: 发送 mod 列表给所有 peer */
  async function sendModSync(gameDir: string) {
    if (role.value !== 'host') return
    modSyncStatus.value = 'syncing'
    try {
      const mods = await window.api.resources.installed('mod', gameDir)
      hostModList.value = mods
      const encoded = encodeModList(mods)
      if (webrtcManager) {
        webrtcManager.broadcast(encoded)
      } else if (manualDc?.readyState === 'open') {
        manualDc.send(encoded as unknown as ArrayBufferView<ArrayBuffer>)
      }
      addLog(`已发送 mod 列表 (${mods.length} 个)`)
      modSyncStatus.value = 'done'
    } catch (err: any) {
      addLog(`发送 mod 列表失败: ${err.message}`)
      modSyncStatus.value = 'idle'
    }
  }

  /** 客人: 收到 mod 列表后对比本地 */
  async function handleModSyncData(data: Uint8Array, gameDir: string) {
    const remoteMods = decodeModSyncMessage(data)
    if (!remoteMods) return false

    hostModList.value = remoteMods
    modSyncStatus.value = 'syncing'
    try {
      const localMods = await window.api.resources.installed('mod', gameDir)
      modSyncDiff.value = diffModLists(remoteMods, localMods)
      modSyncStatus.value = 'done'
      addLog(`Mod 同步结果: 缺少 ${modSyncDiff.value.missing.length}, 多出 ${modSyncDiff.value.extra.length}, 匹配 ${modSyncDiff.value.matched.length}`)
      // 发送 ACK
      if (webrtcManager) {
        webrtcManager.broadcast(encodeModSyncAck())
      } else if (manualDc?.readyState === 'open') {
        manualDc.send(encodeModSyncAck() as unknown as ArrayBufferView<ArrayBuffer>)
      }
    } catch (err: any) {
      addLog(`Mod 对比失败: ${err.message}`)
      modSyncStatus.value = 'idle'
    }
    return true
  }

  // ========== 离开房间 ==========

  function leaveRoom(): void {
    signaling?.leaveRoom()
    cleanup()
  }

  function cleanup(): void {
    webrtcManager?.destroy()
    webrtcManager = null
    signaling?.disconnect()
    signaling = null

    // 手动模式清理
    manualDc?.close()
    manualPc?.close()
    manualDc = null
    manualPc = null
    manualApplyAnswer = null
    manualWaitOpen = null
    manualOfferCode.value = ''
    manualAnswerCode.value = ''
    manualPhase.value = 'idle'

    window.api.p2p.destroyAllProxies()
    window.api.p2p.stopAllLanBroadcasts()
    window.api.p2p.stopLanDetector()
    window.api.overlay.hide().catch(() => {})

    for (const fn of cleanupFns) fn()
    cleanupFns = []

    state.value = 'idle'
    role.value = null
    roomCode.value = ''
    roomId.value = ''
    peers.value = []
    localPort.value = 0
    mcLanPort.value = 0
    connectionTier.value = 'direct'
    error.value = ''
    modSyncDiff.value = null
    modSyncStatus.value = 'idle'
    hostModList.value = []
  }

  // ========== 网络诊断 ==========

  async function runDiagnostics(): Promise<void> {
    diagnosing.value = true
    error.value = ''

    try {
      // 主进程诊断 (IPv6 + 代理)
      const mainDiag = await window.api.p2p.runDiagnostics()

      // 渲染进程诊断 (STUN + TURN + 信令)
      const signalingResult = await testSignaling()
      const stunResult = await testStun()
      const turnResult = await testTurn()

      diagnostics.value = {
        signaling: signalingResult,
        stun: stunResult,
        turn: turnResult,
        ipv6: mainDiag.ipv6,
        proxy: mainDiag.proxy,
        nat: { type: stunResult.type as any || 'unknown' }
      }
    } catch (err: any) {
      error.value = `诊断失败: ${err.message}`
    } finally {
      diagnosing.value = false
    }
  }

  async function testSignaling(): Promise<{ ok: boolean; latency?: number; error?: string }> {
    if (!settings.signalingServer) return { ok: false, error: '未配置信令服务器' }
    const start = Date.now()
    try {
      const client = new SignalingClient()
      await Promise.race([
        client.connect(settings.signalingServer),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ])
      const latency = Date.now() - start
      client.disconnect()
      return { ok: true, latency }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  }

  async function testStun(): Promise<{ ok: boolean; ip?: string; type?: string; error?: string }> {
    return new Promise((resolve) => {
      const pc = new RTCPeerConnection({
        iceServers: settings.stunServers.map(url => ({ urls: url }))
      })

      const timer = setTimeout(() => {
        pc.close()
        resolve({ ok: false, error: 'STUN timeout' })
      }, 8000)

      pc.onicecandidate = (e) => {
        if (e.candidate?.type === 'srflx') {
          clearTimeout(timer)
          const ip = e.candidate.address || ''
          pc.close()
          resolve({ ok: true, ip, type: 'srflx' })
        }
      }

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer)
          pc.close()
          resolve({ ok: false, error: '未获得 STUN candidate' })
        }
      }

      // 创建一个 dummy DataChannel 来触发 ICE gathering
      pc.createDataChannel('test')
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {
        clearTimeout(timer)
        pc.close()
        resolve({ ok: false, error: 'createOffer failed' })
      })
    })
  }

  async function testTurn(): Promise<{ ok: boolean; provider?: string; error?: string }> {
    // 优先测试用户自定义 TURN
    if (settings.turnServers.length > 0) {
      const turnConfig = settings.turnServers[0]
      const localResult = await testTurnServer(turnConfig.urls, turnConfig.username, turnConfig.credential)
      if (localResult) return { ok: true, provider: turnConfig.source }
    }

    // 测试 Cloudflare TURN (通过信令服务器动态获取凭据)
    try {
      const client = new SignalingClient()
      await Promise.race([
        client.connect(settings.signalingServer),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ])
      client.requestTurnCredentials()

      const iceServers = await new Promise<any[]>((resolve) => {
        const timer = setTimeout(() => {
          client.off('turn-credentials', handler)
          resolve([])
        }, 6000)
        const handler = (msg: any) => {
          clearTimeout(timer)
          client.off('turn-credentials', handler)
          resolve(msg.iceServers || [])
        }
        client.on('turn-credentials', handler)
      })

      client.disconnect()

      if (iceServers.length > 0) {
        // 拿到了 CF TURN 凭据，验证实际连通性
        const first = iceServers[0]
        const cfResult = await testTurnServer(first.urls, first.username, first.credential)
        if (cfResult) return { ok: true, provider: 'cloudflare (自动)' }
      }
    } catch { /* CF TURN 不可用 */ }

    return { ok: false, error: '无可用 TURN (不影响大部分用户)' }
  }

  function testTurnServer(urls: string | string[], username?: string, credential?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls, username, credential }],
        iceTransportPolicy: 'relay'
      })

      const timer = setTimeout(() => {
        pc.close()
        resolve(false)
      }, 8000)

      pc.onicecandidate = (e) => {
        if (e.candidate?.type === 'relay') {
          clearTimeout(timer)
          pc.close()
          resolve(true)
        }
      }

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer)
          pc.close()
          resolve(false)
        }
      }

      pc.createDataChannel('test')
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {
        clearTimeout(timer)
        pc.close()
        resolve(false)
      })
    })
  }

  // ========== 工具 ==========

  function tierLabel(tier: ConnectionTier): string {
    switch (tier) {
      case 'direct': return '直连'
      case 'turn': return 'TURN 中继'
      case 'relay': return '服务器中继'
    }
  }

  function copyRoomCode(): void {
    if (roomCode.value) {
      navigator.clipboard.writeText(roomCode.value)
      addLog('房间码已复制')
    }
  }

  return {
    state, role, roomCode, roomId, peers, connectionTier,
    localPort, mcLanPort, logs, error, playerName,
    diagnostics, diagnosing,
    isHost, isGuest, isInRoom,
    createRoom, joinRoom, leaveRoom, copyRoomCode, runDiagnostics,
    tierLabel,
    // 最近玩家
    recentPlayers, trackPlayer,
    // 手动交换
    manualPhase, manualOfferCode, manualAnswerCode,
    createManualRoom, submitManualAnswer, joinManualRoom,
    // Mod 同步
    modSyncDiff, modSyncStatus, hostModList,
    sendModSync, handleModSyncData
  }
})
