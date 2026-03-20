// ========== 游戏实例 (Profile) ==========

export type GCType = 'G1GC' | 'AikarG1' | 'ZGC' | 'ShenandoahGC' | 'GraalVMG1' | 'ParallelGC' | 'SerialGC' | 'custom'

export interface JvmArgs {
  maxMemory: number       // MB, -Xmx
  minMemory: number       // MB, -Xms
  gcType: GCType
  gcArgs: string[]        // GC 调优参数
  extraArgs: string[]     // 用户自定义 JVM 参数
}

export interface ModLoaderInfo {
  type: 'fabric' | 'forge' | 'neoforge' | 'quilt'
  version: string
}

export interface GameProfile {
  id: string
  name: string
  gameDir: string
  versionId: string
  modLoader?: ModLoaderInfo
  javaPath: string
  jvmArgs: JvmArgs
  windowWidth: number
  windowHeight: number
  accountId: string
  createdAt: number
  lastPlayed?: number
}

// ========== 账号 ==========

export interface MinecraftAccount {
  id: string
  type: 'microsoft' | 'offline' | 'yggdrasil'
  username: string
  uuid: string
  accessToken: string
  refreshToken?: string   // 仅微软账号
  expiresAt?: number      // MC令牌过期时间戳 (ms)
  xuid?: string           // Xbox User ID
  msRefreshToken?: string // 微软 refresh_token (用于续期)
  // Yggdrasil 第三方登录
  yggdrasilServer?: string   // Yggdrasil API Root URL
  yggdrasilClientToken?: string // clientToken (用于刷新)
}

// ========== Yggdrasil 第三方认证 ==========

export interface YggdrasilServerInfo {
  url: string             // API Root URL (如 https://littleskin.cn/api/yggdrasil)
  name: string            // 服务器名称 (从 meta.serverName 获取)
  homepage?: string       // 首页链接
  register?: string       // 注册页面链接
  nonEmailLogin?: boolean // 是否支持角色名登录
}

export interface YggdrasilProfile {
  id: string              // 无符号 UUID
  name: string            // 角色名称
}

export interface YggdrasilAuthResponse {
  accessToken: string
  clientToken: string
  availableProfiles: YggdrasilProfile[]
  selectedProfile?: YggdrasilProfile
}

// ========== 微软认证 ==========

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number      // 秒
  interval: number        // 轮询间隔秒
  message: string
}

export interface MSTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  scope: string
}

export type AuthLoginState = 'idle' | 'waitingForCode' | 'polling' | 'exchanging' | 'success' | 'error'

export interface AuthProgressEvent {
  state: AuthLoginState
  userCode?: string
  verificationUri?: string
  error?: string
  account?: MinecraftAccount
}

// ========== 版本 ==========

export interface VersionManifestEntry {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  url: string
  sha1: string
  time: string
  releaseTime: string
}

export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: VersionManifestEntry[]
}

export interface VersionLibrary {
  name: string
  downloads?: {
    artifact?: LibraryArtifact
    classifiers?: Record<string, LibraryArtifact>
  }
  url?: string
  rules?: LibraryRule[]
  natives?: Record<string, string>
  extract?: { exclude?: string[] }
}

export interface LibraryArtifact {
  path: string
  sha1: string
  size: number
  url: string
}

export interface LibraryRule {
  action: 'allow' | 'disallow'
  os?: { name?: string; version?: string; arch?: string }
  features?: Record<string, boolean>
}

export interface AssetIndex {
  id: string
  sha1: string
  size: number
  totalSize: number
  url: string
}

export interface VersionJson {
  id: string
  inheritsFrom?: string
  type: string
  mainClass: string
  arguments?: {
    game: (string | ArgumentRule)[]
    jvm: (string | ArgumentRule)[]
  }
  minecraftArguments?: string  // 旧版
  libraries: VersionLibrary[]
  assetIndex?: AssetIndex
  assets?: string
  downloads?: {
    client: { sha1: string; size: number; url: string }
    server?: { sha1: string; size: number; url: string }
    client_mappings?: { sha1: string; size: number; url: string }
  }
  javaVersion?: { component: string; majorVersion: number }
  logging?: Record<string, unknown>
}

export interface ArgumentRule {
  rules: LibraryRule[]
  value: string | string[]
}

// ========== 下载 ==========

export type MirrorSource = 'official' | 'bmclapi' | 'tsinghua'

export interface DownloadTask {
  url: string
  path: string
  sha1?: string
  size?: number
}

export interface DownloadProgress {
  total: number
  completed: number
  failed: number
  speed: number           // bytes/s
  currentFile?: string
}

// ========== Java ==========

export interface JavaInstallation {
  path: string            // java.exe / java 二进制路径
  version: string         // "17.0.8" 等
  majorVersion: number    // 17, 21 等
  arch: string            // "x64", "aarch64"
  vendor?: string         // "Eclipse Adoptium", "Oracle" 等
  isManual: boolean       // 是否手动添加
}

// ========== 设置 ==========

export interface LauncherSettings {
  locale: string
  mirrorSource: MirrorSource
  defaultJvmArgs: JvmArgs
  defaultGameDir: string
  defaultJavaPath: string
  manualJavaPaths: string[]  // 手动添加的Java路径
  gameDirs: string[]         // 多游戏目录
  theme: 'light' | 'dark' | 'system'
  maxConcurrentDownloads: number
  defaultMinMemory: number
  defaultMaxMemory: number
  // P2P
  signalingServer: string
  stunServers: string[]
  turnServers: TurnServerConfig[]
  relayServers: string[]    // 独立中继端点 (WS), 按顺序尝试
  enableIPv6: boolean
  relayFallback: boolean
}

// ========== 资源下载中心 (Mod/光影/资源包) ==========

export type ResourceType = 'mod' | 'shader' | 'resourcepack' | 'modpack'
export type ResourcePlatform = 'modrinth' | 'curseforge'
export type ResourceSortBy = 'relevance' | 'downloads' | 'updated' | 'newest' | 'follows'

export interface ResourceSearchParams {
  query: string
  type?: ResourceType
  gameVersion?: string
  loader?: string
  categories?: string[]        // Modrinth tag filter
  sortBy?: ResourceSortBy
  page?: number               // 0-based
  pageSize?: number            // default 20
  platform?: ResourcePlatform  // default 'modrinth'
}

export interface ResourceProject {
  id: string
  platform: ResourcePlatform
  type: ResourceType
  title: string
  description: string
  author: string
  iconUrl: string
  downloads: number
  follows: number
  lastUpdated: string
  slug: string
  categories: string[]
  gameVersions: string[]
  loaders: string[]
}

export interface ResourceVersion {
  id: string
  projectId: string
  name: string
  versionNumber: string
  gameVersions: string[]
  loaders: string[]
  releaseType: 'release' | 'beta' | 'alpha'
  files: ResourceFile[]
  dependencies: ResourceDependency[]
  datePublished: string
  downloads: number
}

export interface ResourceFile {
  url: string
  filename: string
  size: number
  sha1?: string
  sha512?: string
  primary: boolean
}

export interface ResourceDependency {
  projectId: string
  versionId?: string
  dependencyType: 'required' | 'optional' | 'incompatible' | 'embedded'
}

export interface InstalledResource {
  projectId: string
  platform: ResourcePlatform
  type: ResourceType
  versionId: string
  versionNumber: string
  filename: string
  title: string
  installedAt: number
}

export interface ResourceSearchResult {
  hits: ResourceProject[]
  total: number
  page: number
  pageSize: number
}

// ========== Mod Loader 版本查询 ==========

export interface ModLoaderVersionEntry {
  version: string
  stable: boolean
}

export interface ForgeVersionEntry {
  version: string
  mcversion: string
  modified: string
}

export type ModLoaderType = 'fabric' | 'forge' | 'neoforge' | 'quilt'

// ========== P2P ==========

export type ConnectionTier = 'direct' | 'turn' | 'relay'

export type TurnServerSource = 'openrelay' | 'cloudflare' | 'custom'

export interface TurnServerConfig {
  urls: string | string[]
  username?: string
  credential?: string
  source: TurnServerSource
}

export interface P2PRoom {
  roomId: string
  hostName: string
  playerCount: number
  maxPlayers: number
  gameVersion: string
  motd?: string
}

export interface P2PPeer {
  id: string
  name: string
  rtt: number             // 延迟 ms
  state: 'connecting' | 'connected' | 'disconnected'
  connectionTier?: ConnectionTier
  ipVersion?: 4 | 6
  dataChannelState?: RTCDataChannelState
}

export interface P2PSession {
  role: 'host' | 'guest'
  roomId: string
  roomCode: string
  connectionTier: ConnectionTier
  ipVersion: 4 | 6
  localPort?: number       // 客人: MC 连接的本地端口
  mcLanPort?: number       // 房主: MC 局域网端口
  peers: P2PPeer[]
}

// ========== 信令消息 ==========

export type SignalingMessage =
  | { type: 'create-room'; playerName: string; gameVersion: string }
  | { type: 'room-created'; roomId: string; roomCode: string }
  | { type: 'join-room'; roomCode: string; playerName: string }
  | { type: 'room-joined'; roomId: string; peers: { id: string; name: string }[] }
  | { type: 'peer-joined'; peerId: string; peerName: string }
  | { type: 'peer-left'; peerId: string }
  | { type: 'room-closed'; reason: string }
  | { type: 'offer'; targetPeerId: string; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; targetPeerId: string; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; targetPeerId: string; candidate: RTCIceCandidateInit }
  | { type: 'relay-start'; targetPeerId: string }
  | { type: 'relay-stop'; targetPeerId: string }
  | { type: 'relay-data'; targetPeerId: string; data: string }
  | { type: 'connection-tier'; tier: ConnectionTier }
  | { type: 'request-turn-credentials' }
  | { type: 'turn-credentials'; iceServers: RTCIceServer[] }
  | { type: 'error'; message: string }

// ========== 网络诊断 ==========

export interface NetworkDiagnostics {
  signaling: { ok: boolean; latency?: number; error?: string }
  stun: { ok: boolean; ip?: string; type?: string; error?: string }
  turn: { ok: boolean; provider?: string; error?: string }
  ipv6: { ok: boolean; error?: string }
  proxy: { detected: boolean; url?: string }
  nat: { type: 'full-cone' | 'restricted' | 'port-restricted' | 'symmetric' | 'unknown' }
}

// ========== GC 预设模板 ==========

export const GC_PRESETS: Record<Exclude<GCType, 'custom'>, string[]> = {
  G1GC: [
    '-XX:+UseG1GC',
    '-XX:G1HeapRegionSize=16M',
    '-XX:G1ReservePercent=20',
    '-XX:MaxGCPauseMillis=50',
    '-XX:+ParallelRefProcEnabled',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:SurvivorRatio=32'
  ],
  AikarG1: [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true'
  ],
  ZGC: [
    '-XX:+UseZGC',
    '-XX:+ZGenerational',
    '-XX:+AlwaysPreTouch',
    '-XX:+DisableExplicitGC'
  ],
  ShenandoahGC: [
    '-XX:+UseShenandoahGC',
    '-XX:ShenandoahGCHeuristics=compact',
    '-XX:+AlwaysPreTouch',
    '-XX:+DisableExplicitGC'
  ],
  GraalVMG1: [
    '-XX:+UseG1GC',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+UnlockDiagnosticVMOptions',
    '-XX:+AlwaysPreTouch',
    '-XX:+DisableExplicitGC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=16M',
    '-XX:G1ReservePercent=20',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:SurvivorRatio=32',
    '-XX:+EnableJVMCI',
    '-XX:+UseJVMCICompiler'
  ],
  ParallelGC: [
    '-XX:+UseParallelGC',
    '-XX:ParallelGCThreads=4',
    '-XX:+AlwaysPreTouch'
  ],
  SerialGC: [
    '-XX:+UseSerialGC'
  ]
}

// ========== 默认设置 ==========

export function getDefaultJvmArgs(): JvmArgs {
  return {
    maxMemory: 4096,
    minMemory: 1024,
    gcType: 'G1GC',
    gcArgs: [...GC_PRESETS.G1GC],
    extraArgs: [
      '-Dlog4j2.formatMsgNoLookups=true',
      '-Dfml.ignoreInvalidMinecraftCertificates=true'
    ]
  }
}

export const DEFAULT_STUN_SERVERS = [
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.hitv.com:3478',
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
]

export const DEFAULT_TURN_SERVERS: TurnServerConfig[] = []

export function getDefaultSettings(): LauncherSettings {
  return {
    locale: 'zh-CN',
    mirrorSource: 'bmclapi',
    defaultJvmArgs: getDefaultJvmArgs(),
    defaultGameDir: '',    // 运行时根据平台计算
    defaultJavaPath: '',   // 运行时自动检测
    manualJavaPaths: [],
    gameDirs: [],
    theme: 'dark',
    maxConcurrentDownloads: 8,
    defaultMinMemory: 512,
    defaultMaxMemory: 4096,
    signalingServer: 'wss://mc-signaling.onrender.com',
    stunServers: [...DEFAULT_STUN_SERVERS],
    turnServers: [...DEFAULT_TURN_SERVERS],
    relayServers: [],
    enableIPv6: true,
    relayFallback: true,
  }
}
