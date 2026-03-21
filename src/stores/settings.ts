import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { MirrorSource, JvmArgs, TurnServerConfig, LauncherSettings } from '../types'
import { getDefaultJvmArgs, DEFAULT_STUN_SERVERS, DEFAULT_TURN_SERVERS } from '../types'

export const useSettingsStore = defineStore('settings', () => {
  const mirrorSource = ref<MirrorSource>('bmclapi')
  const theme = ref<'light' | 'dark' | 'system'>(
    (localStorage.getItem('mc-theme') as 'light' | 'dark' | 'system') || 'dark'
  )
  const accentColor = ref<string | undefined>(undefined)
  const backgroundImage = ref<string | undefined>(undefined)
  const backgroundOpacity = ref(0.3)
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
  const curseForgeApiKey = ref('$2a$10$QBYU9O0bXbaY.Z0coFAQlOaC8ABNKWywRnQ.MKC2EvB/Ca/umVlnK')

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
      accentColor: accentColor.value,
      backgroundImage: backgroundImage.value,
      backgroundOpacity: backgroundOpacity.value,
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
      curseForgeApiKey: curseForgeApiKey.value,
      ...extra
    }
    // 用 JSON 序列化去除 Vue reactive Proxy，否则 Electron IPC structured clone 会失败
    window.api.settings.save(JSON.parse(JSON.stringify(data)))
  }

  async function init() {
    // 先从持久化存储加载
    const saved = await window.api.settings.load()
    if (saved.theme) { theme.value = saved.theme; localStorage.setItem('mc-theme', saved.theme) }
    if (saved.accentColor !== undefined) accentColor.value = saved.accentColor
    if (saved.backgroundImage !== undefined) backgroundImage.value = saved.backgroundImage
    if (saved.backgroundOpacity !== undefined) backgroundOpacity.value = saved.backgroundOpacity
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
    if (saved.curseForgeApiKey) curseForgeApiKey.value = saved.curseForgeApiKey
    // 从系统获取运行时信息
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
    applyAccentColor(accentColor.value)
  }

  function applyAccentColor(color?: string) {
    const el = document.documentElement.style
    if (color) {
      el.setProperty('--accent', color)
      el.setProperty('--accent-hover', darkenHex(color, 15))
    } else {
      el.removeProperty('--accent')
      el.removeProperty('--accent-hover')
    }
  }

  /** 将 hex 颜色降低亮度 */
  function darkenHex(hex: string, amount: number): string {
    const c = hex.replace('#', '')
    const r = Math.max(0, parseInt(c.substring(0, 2), 16) - amount)
    const g = Math.max(0, parseInt(c.substring(2, 4), 16) - amount)
    const b = Math.max(0, parseInt(c.substring(4, 6), 16) - amount)
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
  }

  function setAccentColor(color?: string) {
    accentColor.value = color
    applyAccentColor(color)
    persist()
  }

  async function chooseBackground() {
    const p = await window.api.dialog.selectFile([{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }])
    if (p) { backgroundImage.value = p; persist() }
  }

  function clearBackground() {
    backgroundImage.value = undefined
    persist()
  }

  function setBackgroundOpacity(v: number) {
    backgroundOpacity.value = v
    persist()
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
    mirrorSource, theme, accentColor, backgroundImage, backgroundOpacity,
    defaultGameDir, gameDirs, defaultJavaPath,
    manualJavaPaths, defaultJvmArgs, downloadConcurrency,
    defaultMinMemory, defaultMaxMemory, totalMemory, clientId, curseForgeApiKey,
    signalingServer, stunServers, turnServers, relayServers, enableIPv6, relayFallback,
    init, setMirrorSource, browseDefaultJava, browseDefaultGameDir,
    addGameDir, removeGameDir,
    addJavaPath, removeJavaPath, setClientIdValue, persist,
    addCustomTurn, removeCustomTurn, addRelayServer, removeRelayServer,
    setTheme, applyTheme, setAccentColor,
    chooseBackground, clearBackground, setBackgroundOpacity
  }
})
