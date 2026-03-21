import { ipcRenderer, contextBridge } from 'electron'
import type {
  GameProfile, MinecraftAccount, MirrorSource, LauncherSettings,
  VersionManifest, VersionManifestEntry, JavaInstallation, DownloadProgress,
  AuthProgressEvent, YggdrasilServerInfo,
  ResourceSearchParams, ResourceSearchResult, ResourceProject,
  ResourceVersion, ResourceFile, ResourceType, ResourcePlatform,
  InstalledResource
} from '../src/types'

import type { LanGame } from './core/lan-detector'
import type { NetworkDiagnostics } from '../src/types'

// 类型安全的 API 暴露给渲染进程
const api = {
  // ========== 设置持久化 ==========
  settings: {
    load: () => ipcRenderer.invoke('settings:load') as Promise<LauncherSettings>,
    save: (partial: Partial<LauncherSettings>) => ipcRenderer.invoke('settings:save', partial) as Promise<void>,
  },

  // ========== CurseForge ==========
  curseforge: {
    isConfigured: () => ipcRenderer.invoke('curseforge:isConfigured') as Promise<boolean>,
  },

  // ========== 版本 ==========
  versions: {
    getManifest: (forceRefresh?: boolean) =>
      ipcRenderer.invoke('versions:getManifest', forceRefresh) as Promise<VersionManifest>,
    getList: (type?: 'release' | 'snapshot') =>
      ipcRenderer.invoke('versions:getList', type) as Promise<VersionManifestEntry[]>,
    getLocal: (gameDir: string) =>
      ipcRenderer.invoke('versions:getLocal', gameDir) as Promise<string[]>,
  },

  // ========== 下载 ==========
  download: {
    installVersion: (versionId: string, gameDir: string) =>
      ipcRenderer.invoke('download:installVersion', versionId, gameDir),
    onProgress: (callback: (progress: DownloadProgress) => void) => {
      const handler = (_: unknown, p: DownloadProgress) => callback(p)
      ipcRenderer.on('download:progress', handler)
      return () => ipcRenderer.off('download:progress', handler)
    },
  },

  // ========== Java ==========
  java: {
    scan: () => ipcRenderer.invoke('java:scan') as Promise<JavaInstallation[]>,
    validate: (javaPath: string) =>
      ipcRenderer.invoke('java:validate', javaPath) as Promise<JavaInstallation | null>,
    distros: () => ipcRenderer.invoke('java:distros') as Promise<Array<{ id: string; name: string; description: string; versions: number[] }>>,
    installedRuntimes: () => ipcRenderer.invoke('java:installedRuntimes') as Promise<Array<{ distro: string; majorVersion: number; javaPath: string }>>,
    install: (distroId: string, majorVersion: number) =>
      ipcRenderer.invoke('java:install', distroId, majorVersion) as Promise<string>,
    onInstallProgress: (callback: (p: { distro: string; version: number; status: string; percent: number; message: string }) => void) => {
      const handler = (_: unknown, p: { distro: string; version: number; status: string; percent: number; message: string }) => callback(p)
      ipcRenderer.on('java:installProgress', handler)
      return () => ipcRenderer.off('java:installProgress', handler)
    },
  },

  // ========== Profile ==========
  profiles: {
    getAll: () => ipcRenderer.invoke('profiles:getAll') as Promise<GameProfile[]>,
    get: (id: string) => ipcRenderer.invoke('profiles:get', id) as Promise<GameProfile | undefined>,
    create: (opts: Partial<GameProfile>) => ipcRenderer.invoke('profiles:create', opts) as Promise<GameProfile>,
    update: (id: string, updates: Partial<GameProfile>) =>
      ipcRenderer.invoke('profiles:update', id, updates) as Promise<GameProfile | null>,
    delete: (id: string) => ipcRenderer.invoke('profiles:delete', id) as Promise<boolean>,
    duplicate: (id: string) => ipcRenderer.invoke('profiles:duplicate', id) as Promise<GameProfile | null>,
    scanDir: (gameDir: string) => ipcRenderer.invoke('profiles:scanDir', gameDir) as Promise<GameProfile[]>,
  },

  // ========== 启动 ==========
  launch: {
    start: (profileId: string, account: MinecraftAccount) =>
      ipcRenderer.invoke('launch:start', profileId, account),
    onLog: (callback: (log: string) => void) => {
      const handler = (_: unknown, log: string) => callback(log)
      ipcRenderer.on('launch:log', handler)
      return () => ipcRenderer.off('launch:log', handler)
    },
    onExit: (callback: (code: number | null) => void) => {
      const handler = (_: unknown, code: number | null) => callback(code)
      ipcRenderer.on('launch:exit', handler)
      return () => ipcRenderer.off('launch:exit', handler)
    },
  },

  // ========== 镜像源 ==========
  mirror: {
    get: () => ipcRenderer.invoke('mirror:get') as Promise<MirrorSource>,
    set: (source: MirrorSource) => ipcRenderer.invoke('mirror:set', source),
  },

  // ========== 系统对话框 ==========
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory') as Promise<string | null>,
    selectDirectoryAt: (defaultPath?: string) => ipcRenderer.invoke('dialog:selectDirectoryAt', defaultPath) as Promise<string | null>,
    selectFile: (filters?: { name: string; extensions: string[] }[]) =>
      ipcRenderer.invoke('dialog:selectFile', filters) as Promise<string | null>,
  },

  // ========== 系统信息 ==========
  system: {
    totalMemory: () => ipcRenderer.invoke('system:totalMemory') as Promise<number>,
    defaultGameDir: () => ipcRenderer.invoke('system:defaultGameDir') as Promise<string>,
    platform: () => ipcRenderer.invoke('system:platform') as Promise<string>,
    openFolder: (folderPath: string) => ipcRenderer.invoke('system:openFolder', folderPath) as Promise<string>,
  },

  // ========== 窗口控制 ==========
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },

  // ========== 资源下载中心 ==========
  resources: {
    search: (params: ResourceSearchParams) =>
      ipcRenderer.invoke('resources:search', params) as Promise<ResourceSearchResult>,
    detail: (platform: ResourcePlatform, id: string) =>
      ipcRenderer.invoke('resources:detail', platform, id) as Promise<ResourceProject>,
    versions: (platform: ResourcePlatform, projectId: string, loaders?: string[], gameVersions?: string[]) =>
      ipcRenderer.invoke('resources:versions', platform, projectId, loaders, gameVersions) as Promise<ResourceVersion[]>,
    install: (file: ResourceFile, type: ResourceType, gameDir: string, meta: { projectId: string; platform: ResourcePlatform; versionId: string; versionNumber: string; title: string }) =>
      ipcRenderer.invoke('resources:install', file, type, gameDir, meta) as Promise<string>,
    installed: (type: ResourceType, gameDir: string) =>
      ipcRenderer.invoke('resources:installed', type, gameDir) as Promise<InstalledResource[]>,
    remove: (type: ResourceType, gameDir: string, filename: string) =>
      ipcRenderer.invoke('resources:remove', type, gameDir, filename) as Promise<boolean>,
    dependencies: (version: ResourceVersion, platform: ResourcePlatform) =>
      ipcRenderer.invoke('resources:dependencies', version, platform) as Promise<{ required: ResourceProject[]; optional: ResourceProject[] }>,
    onInstallProgress: (callback: (event: { status: string; filename: string; error?: string }) => void) => {
      const handler = (_: unknown, e: { status: string; filename: string; error?: string }) => callback(e)
      ipcRenderer.on('resources:installProgress', handler)
      return () => ipcRenderer.off('resources:installProgress', handler)
    },
  },

  // ========== 整合包 ==========
  modpack: {
    install: (mrpackUrl: string, mrpackFilename: string, gameDir: string, profileName: string) =>
      ipcRenderer.invoke('modpack:install', mrpackUrl, mrpackFilename, gameDir, profileName) as Promise<{
        name: string; mcVersion: string; modLoader?: { type: string; version: string }; instanceDir: string
      }>,
    onInstallProgress: (callback: (event: { stage: string; message: string; fileProgress?: { total: number; completed: number; failed: number; speed: number } }) => void) => {
      const handler = (_: unknown, e: { stage: string; message: string; fileProgress?: { total: number; completed: number; failed: number; speed: number } }) => callback(e)
      ipcRenderer.on('modpack:installProgress', handler)
      return () => ipcRenderer.off('modpack:installProgress', handler)
    },
  },

  // ========== Mod Loader ==========
  modloader: {
    fabricVersions: (mcVersion: string) =>
      ipcRenderer.invoke('modloader:fabricVersions', mcVersion) as Promise<{ version: string; stable: boolean }[]>,
    quiltVersions: (mcVersion: string) =>
      ipcRenderer.invoke('modloader:quiltVersions', mcVersion) as Promise<{ version: string; stable: boolean }[]>,
    forgeVersions: (mcVersion: string) =>
      ipcRenderer.invoke('modloader:forgeVersions', mcVersion) as Promise<{ version: string; mcversion: string; modified: string }[]>,
    neoforgeVersions: (mcVersion: string) =>
      ipcRenderer.invoke('modloader:neoforgeVersions', mcVersion) as Promise<{ version: string; stable: boolean }[]>,
    installFabric: (mcVersion: string, loaderVersion: string, gameDir: string) =>
      ipcRenderer.invoke('modloader:installFabric', mcVersion, loaderVersion, gameDir) as Promise<string>,
    installQuilt: (mcVersion: string, loaderVersion: string, gameDir: string) =>
      ipcRenderer.invoke('modloader:installQuilt', mcVersion, loaderVersion, gameDir) as Promise<string>,
    installForge: (mcVersion: string, forgeVersion: string, gameDir: string, javaPath?: string) =>
      ipcRenderer.invoke('modloader:installForge', mcVersion, forgeVersion, gameDir, javaPath) as Promise<string>,
    installNeoForge: (mcVersion: string, nfVersion: string, gameDir: string, javaPath?: string) =>
      ipcRenderer.invoke('modloader:installNeoForge', mcVersion, nfVersion, gameDir, javaPath) as Promise<string>,
    onInstallerLog: (callback: (message: string) => void) => {
      const handler = (_: unknown, msg: string) => callback(msg)
      ipcRenderer.on('modloader:installerLog', handler)
      return () => ipcRenderer.off('modloader:installerLog', handler)
    },
  },

  // ========== 微软认证 ==========
  auth: {
    startMsLogin: () =>
      ipcRenderer.invoke('auth:startMsLogin') as Promise<MinecraftAccount>,
    cancelMsLogin: () =>
      ipcRenderer.invoke('auth:cancelMsLogin') as Promise<void>,
    refreshToken: (accountId: string) =>
      ipcRenderer.invoke('auth:refreshToken', accountId) as Promise<MinecraftAccount>,
    getAccounts: () =>
      ipcRenderer.invoke('auth:getAccounts') as Promise<{ accounts: MinecraftAccount[]; selectedId: string }>,
    saveAccount: (account: MinecraftAccount) =>
      ipcRenderer.invoke('auth:saveAccount', account) as Promise<void>,
    removeAccount: (id: string) =>
      ipcRenderer.invoke('auth:removeAccount', id) as Promise<void>,
    setSelectedId: (id: string) =>
      ipcRenderer.invoke('auth:setSelectedId', id) as Promise<void>,
    ensureValidToken: (account: MinecraftAccount) =>
      ipcRenderer.invoke('auth:ensureValidToken', account) as Promise<MinecraftAccount>,
    openUrl: (url: string) =>
      ipcRenderer.invoke('auth:openUrl', url) as Promise<void>,
    getClientId: () =>
      ipcRenderer.invoke('auth:getClientId') as Promise<string>,
    setClientId: (id: string) =>
      ipcRenderer.invoke('auth:setClientId', id) as Promise<void>,
    fetchAvatar: (url: string) =>
      ipcRenderer.invoke('auth:fetchAvatar', url) as Promise<string>,
    onLoginProgress: (callback: (event: AuthProgressEvent) => void) => {
      const handler = (_: unknown, e: AuthProgressEvent) => callback(e)
      ipcRenderer.on('auth:loginProgress', handler)
      return () => ipcRenderer.off('auth:loginProgress', handler)
    },
    // Yggdrasil 第三方认证
    yggdrasilResolveApi: (inputUrl: string) =>
      ipcRenderer.invoke('auth:yggdrasilResolveApi', inputUrl) as Promise<string>,
    yggdrasilServerInfo: (apiRoot: string) =>
      ipcRenderer.invoke('auth:yggdrasilServerInfo', apiRoot) as Promise<YggdrasilServerInfo>,
    yggdrasilLogin: (apiRoot: string, username: string, password: string) =>
      ipcRenderer.invoke('auth:yggdrasilLogin', apiRoot, username, password) as Promise<MinecraftAccount>,
    yggdrasilGetServers: () =>
      ipcRenderer.invoke('auth:yggdrasilGetServers') as Promise<YggdrasilServerInfo[]>,
    yggdrasilPresetServers: () =>
      ipcRenderer.invoke('auth:yggdrasilPresetServers') as Promise<{ name: string; url: string; homepage?: string; register?: string }[]>,
    yggdrasilAddServer: (server: YggdrasilServerInfo) =>
      ipcRenderer.invoke('auth:yggdrasilAddServer', server) as Promise<void>,
    yggdrasilRemoveServer: (url: string) =>
      ipcRenderer.invoke('auth:yggdrasilRemoveServer', url) as Promise<void>,
  },

  // ========== P2P 联机 ==========
  p2p: {
    startHostProxy: (proxyId: string, mcLanPort: number) =>
      ipcRenderer.invoke('p2p:startHostProxy', proxyId, mcLanPort) as Promise<{ proxyId: string }>,
    startClientProxy: (proxyId: string) =>
      ipcRenderer.invoke('p2p:startClientProxy', proxyId) as Promise<{ proxyId: string; port: number }>,
    sendToMc: (proxyId: string, data: Uint8Array) =>
      ipcRenderer.invoke('p2p:sendToMc', proxyId, data) as Promise<void>,
    destroyProxy: (proxyId: string) =>
      ipcRenderer.invoke('p2p:destroyProxy', proxyId) as Promise<void>,
    destroyAllProxies: () =>
      ipcRenderer.invoke('p2p:destroyAllProxies') as Promise<void>,
    startLanBroadcast: (id: string, port: number, motd: string) =>
      ipcRenderer.invoke('p2p:startLanBroadcast', id, port, motd) as Promise<void>,
    stopLanBroadcast: (id: string) =>
      ipcRenderer.invoke('p2p:stopLanBroadcast', id) as Promise<void>,
    stopAllLanBroadcasts: () =>
      ipcRenderer.invoke('p2p:stopAllLanBroadcasts') as Promise<void>,
    startLanDetector: () =>
      ipcRenderer.invoke('p2p:startLanDetector') as Promise<void>,
    stopLanDetector: () =>
      ipcRenderer.invoke('p2p:stopLanDetector') as Promise<void>,
    parseLanPort: (logLine: string) =>
      ipcRenderer.invoke('p2p:parseLanPort', logLine) as Promise<number | null>,
    runDiagnostics: () =>
      ipcRenderer.invoke('p2p:runDiagnostics') as Promise<Pick<NetworkDiagnostics, 'ipv6' | 'proxy'>>,
    onDataFromMc: (callback: (proxyId: string, data: Buffer) => void) => {
      const handler = (_: unknown, proxyId: string, data: Buffer) => callback(proxyId, data)
      ipcRenderer.on('p2p:dataFromMc', handler)
      return () => ipcRenderer.off('p2p:dataFromMc', handler)
    },
    onLanGames: (callback: (games: LanGame[]) => void) => {
      const handler = (_: unknown, games: LanGame[]) => callback(games)
      ipcRenderer.on('p2p:lanGames', handler)
      return () => ipcRenderer.off('p2p:lanGames', handler)
    },
    onMcConnected: (callback: (proxyId: string) => void) => {
      const handler = (_: unknown, proxyId: string) => callback(proxyId)
      ipcRenderer.on('p2p:mcConnected', handler)
      return () => ipcRenderer.off('p2p:mcConnected', handler)
    },
    onMcDisconnected: (callback: (proxyId: string) => void) => {
      const handler = (_: unknown, proxyId: string) => callback(proxyId)
      ipcRenderer.on('p2p:mcDisconnected', handler)
      return () => ipcRenderer.off('p2p:mcDisconnected', handler)
    },
  },

  // ========== 自动更新 ==========
  updater: {
    check: () => ipcRenderer.invoke('updater:check') as Promise<void>,
    download: () => ipcRenderer.invoke('updater:download') as Promise<void>,
    install: () => ipcRenderer.invoke('updater:install') as Promise<void>,
    openRelease: () => ipcRenderer.invoke('updater:openRelease') as Promise<void>,
    isPortable: () => ipcRenderer.invoke('updater:isPortable') as Promise<boolean>,
    onStatus: (callback: (status: any) => void) => {
      const handler = (_: unknown, status: any) => callback(status)
      ipcRenderer.on('updater:status', handler)
      return () => ipcRenderer.off('updater:status', handler)
    },
  },

  // ========== 游戏内覆盖层 ==========
  overlay: {
    show: () => ipcRenderer.invoke('overlay:show') as Promise<void>,
    hide: () => ipcRenderer.invoke('overlay:hide') as Promise<void>,
    updatePeers: (peers: any[]) => ipcRenderer.invoke('overlay:update', peers) as Promise<void>,
  },
}

contextBridge.exposeInMainWorld('api', api)

// 类型声明
export type Api = typeof api
