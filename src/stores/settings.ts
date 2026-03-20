import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { MirrorSource, JvmArgs, TurnServerConfig, LauncherSettings } from '../types'
import { getDefaultJvmArgs, DEFAULT_STUN_SERVERS, DEFAULT_TURN_SERVERS } from '../types'

export const useSettingsStore = defineStore('settings', () => {
  const mirrorSource = ref<MirrorSource>('bmclapi')
  const theme = ref<'light' | 'dark' | 'system'>(
    (localStorage.getItem('mc-theme') as 'light' | 'dark' | 'system') || 'dark'
  )
  const defaultGameDir = ref('')
  const gameDirs = ref<string[]>([])
  const defaultJavaPath = ref('')
  const manualJavaPaths = ref<string[]>([])
  const defaultJvmArgs = ref<JvmArgs>(getDefaultJvmArgs())
  const downloadConcurrency = ref(8)
  const defaultMinMemory = ref(512)
  const defaultMaxMemory = ref(4096)
  const totalMemory = ref(8192)
  const clientId = ref('')

  // P2P
  const signalingServer = ref('wss://mc-signaling.onrender.com')
  const stunServers = ref<string[]>([...DEFAULT_STUN_SERVERS])
  const turnServers = ref<TurnServerConfig[]>([...DEFAULT_TURN_SERVERS])
  const relayServers = ref<string[]>([])
  const enableIPv6 = ref(true)
  const relayFallback = ref(true)

  /** 将需要持久化的字段写入 electron-store */
  function persist(extra?: Partial<LauncherSettings>) {
    const data: Partial<LauncherSettings> = {
      theme: theme.value,
      defaultGameDir: defaultGameDir.value,
      gameDirs: gameDirs.value,
      defaultJavaPath: defaultJavaPath.value,
      manualJavaPaths: manualJavaPaths.value,
      defaultJvmArgs: defaultJvmArgs.value,
      maxConcurrentDownloads: downloadConcurrency.value,
      defaultMinMemory: defaultMinMemory.value,
      defaultMaxMemory: defaultMaxMemory.value,
      signalingServer: signalingServer.value,
      stunServers: stunServers.value,
      turnServers: turnServers.value,
      relayServers: relayServers.value,
      enableIPv6: enableIPv6.value,
      relayFallback: relayFallback.value,
      ...extra
    }
    window.api.settings.save(data)
  }

  async function init() {
    // 先从持久化存储加载
    const saved = await window.api.settings.load()
    if (saved.theme) { theme.value = saved.theme; localStorage.setItem('mc-theme', saved.theme) }
    if (saved.defaultGameDir) defaultGameDir.value = saved.defaultGameDir
    if (saved.gameDirs?.length) gameDirs.value = saved.gameDirs
    if (saved.defaultJavaPath) defaultJavaPath.value = saved.defaultJavaPath
    if (saved.manualJavaPaths?.length) manualJavaPaths.value = saved.manualJavaPaths
    if (saved.defaultJvmArgs) defaultJvmArgs.value = saved.defaultJvmArgs
    if (saved.maxConcurrentDownloads) downloadConcurrency.value = saved.maxConcurrentDownloads
    if (saved.defaultMinMemory) defaultMinMemory.value = saved.defaultMinMemory
    if (saved.defaultMaxMemory) defaultMaxMemory.value = saved.defaultMaxMemory
    if (saved.signalingServer) signalingServer.value = saved.signalingServer
    if (saved.stunServers?.length) stunServers.value = saved.stunServers
    if (saved.turnServers?.length) turnServers.value = saved.turnServers
    if (saved.relayServers?.length) relayServers.value = saved.relayServers
    if (saved.enableIPv6 !== undefined) enableIPv6.value = saved.enableIPv6
    if (saved.relayFallback !== undefined) relayFallback.value = saved.relayFallback

    // 再从系统获取运行时信息
    mirrorSource.value = await window.api.mirror.get()
    if (!defaultGameDir.value) defaultGameDir.value = await window.api.system.defaultGameDir()
    totalMemory.value = await window.api.system.totalMemory()
    clientId.value = await window.api.auth.getClientId()
    // 确保默认目录在列表中
    if (!gameDirs.value.includes(defaultGameDir.value)) {
      gameDirs.value.push(defaultGameDir.value)
    }
    applyTheme(theme.value)
  }

  async function setMirrorSource(source: MirrorSource) {
    await window.api.mirror.set(source)
    mirrorSource.value = source
  }

  async function browseDefaultJava() {
    const p = await window.api.dialog.selectFile()
    if (p) { defaultJavaPath.value = p; persist() }
  }

  async function browseDefaultGameDir() {
    const p = await window.api.dialog.selectDirectory()
    if (p) { defaultGameDir.value = p; persist() }
  }

  async function addGameDir(): Promise<string | null> {
    const p = await window.api.dialog.selectDirectory()
    if (p && !gameDirs.value.includes(p)) {
      gameDirs.value.push(p)
      persist()
      return p
    }
    return p && gameDirs.value.includes(p) ? p : null
  }

  function removeGameDir(dir: string) {
    if (dir === defaultGameDir.value) return   // 不允许移除默认目录
    gameDirs.value = gameDirs.value.filter(d => d !== dir)
    persist()
  }

  function addJavaPath(path: string) {
    if (!manualJavaPaths.value.includes(path)) {
      manualJavaPaths.value.push(path)
      persist()
    }
  }

  function removeJavaPath(path: string) {
    manualJavaPaths.value = manualJavaPaths.value.filter(p => p !== path)
    persist()
  }

  async function setClientIdValue(id: string) {
    await window.api.auth.setClientId(id)
    clientId.value = id
  }

  function addCustomTurn(url: string, username?: string, credential?: string) {
    turnServers.value.push({ urls: url, username, credential, source: 'custom' })
    persist()
  }

  function removeCustomTurn(index: number) {
    if (turnServers.value[index]?.source === 'custom') {
      turnServers.value.splice(index, 1)
      persist()
    }
  }

  function setTheme(t: 'light' | 'dark' | 'system') {
    theme.value = t
    localStorage.setItem('mc-theme', t)
    applyTheme(t)
    persist()
  }

  function applyTheme(t: 'light' | 'dark' | 'system') {
    let resolved = t
    if (t === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    document.documentElement.setAttribute('data-theme', resolved)
  }

  function addRelayServer(url: string) {
    if (url && !relayServers.value.includes(url)) {
      relayServers.value.push(url)
      persist()
    }
  }

  function removeRelayServer(index: number) {
    relayServers.value.splice(index, 1)
    persist()
  }

  return {
    mirrorSource, theme, defaultGameDir, gameDirs, defaultJavaPath,
    manualJavaPaths, defaultJvmArgs, downloadConcurrency,
    defaultMinMemory, defaultMaxMemory, totalMemory, clientId,
    signalingServer, stunServers, turnServers, relayServers, enableIPv6, relayFallback,
    init, setMirrorSource, browseDefaultJava, browseDefaultGameDir,
    addGameDir, removeGameDir,
    addJavaPath, removeJavaPath, setClientIdValue, persist,
    addCustomTurn, removeCustomTurn, addRelayServer, removeRelayServer,
    setTheme, applyTheme
  }
})
