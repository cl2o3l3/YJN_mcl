import { ipcMain, dialog, BrowserWindow, shell, net } from 'electron'
import path from 'node:path'
import { getVersionManifest, getVersionList, getVersionJson, getLocalVersions } from '../core/version-manager'
import { collectLibraryTasks, collectNativeTasks, collectClientTask, extractNatives } from '../core/library-manager'
import { collectAssetTasks } from '../core/asset-manager'
import { downloadBatch } from '../core/download'
import { scanSystemJava, validateJavaPath, selectJava } from '../core/java-manager'
import { JAVA_DISTROS, installJavaRuntime, getInstalledRuntimes, type JavaDownloadProgress } from '../core/java-downloader'
import { getAllProfiles, getProfile, createProfile, updateProfile, deleteProfile, duplicateProfile, scanGameDir } from '../core/profile-manager'
import { setMirrorSource, getMirrorSource } from '../core/mirror-manager'
import { loadSettings, saveSettings } from '../core/settings-store'
import { launchGame } from '../core/launcher'
import { getDefaultMinecraftDir, getTotalMemoryMB } from '../core/platform'
import {
  fetchFabricLoaderVersions, fetchQuiltLoaderVersions,
  fetchForgeVersions, fetchNeoForgeVersions,
  installFabricLoader, installQuiltLoader,
  installForgeLoader, installNeoForgeLoader,
  installModLoader
} from '../core/modloader-manager'
import { fullMicrosoftLogin, refreshAccountToken, ensureValidToken } from '../core/auth/login-flow'
import { getAllAccounts, saveAccount, removeAccount as removeAccountFromStore, getSelectedAccountId, setSelectedAccountId, getClientId, setClientId, getYggdrasilServers, addYggdrasilServer, removeYggdrasilServer } from '../core/auth/account-store'
import { resolveApiRoot, getServerInfo, fullYggdrasilLogin, PRESET_SERVERS } from '../core/auth/yggdrasil'
import {
  searchResources, getResourceDetail, getResourceVersions,
  installResource, getInstalledResources, removeResource, resolveDependencies,
  toggleResource
} from '../core/resource-manager'
import { setCurseForgeApiKey, isCurseForgeConfigured } from '../core/curseforge-api'
import { installModpack } from '../core/modpack-installer'
import {
  downloadServerCore, startMcServer, stopMcServer,
  sendServerCommand, getServerStatus,
  type ServerCoreConfig, type McServerConfig
} from '../core/mc-server-manager'
import { packSave, unpackSave, getSaveInfo, listSaves } from '../core/save-sync'
import type {
  DownloadProgress, MinecraftAccount, AuthProgressEvent, YggdrasilServerInfo,
  ResourceSearchParams, ResourceFile, ResourceType, ResourcePlatform, ResourceVersion,
  LauncherSettings
} from '../../src/types'

// 用于取消正在进行的 MS 登录
let msLoginAbort: AbortController | null = null

/** 统一 IPC 错误包装 — 确保 renderer 收到可读的错误消息 */
function safe<T>(fn: (...args: any[]) => T): (...args: any[]) => Promise<Awaited<T>> {
  return async (...args: any[]): Promise<Awaited<T>> => {
    try {
      return await fn(...args) as Awaited<T>
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e))
    }
  }
}

export function registerIpcHandlers() {
  // ========== 设置持久化 ==========
  ipcMain.handle('settings:load', safe(() => loadSettings()))
  ipcMain.handle('settings:save', safe((_, partial: Partial<LauncherSettings>) => {
    saveSettings(partial)
    // 如果保存了 CurseForge API Key，立即同步到运行时
    if (partial.curseForgeApiKey !== undefined) {
      setCurseForgeApiKey(partial.curseForgeApiKey)
    }
  }))

  // 启动时从持久化设置加载 CurseForge API Key
  const savedSettings = loadSettings()
  if (savedSettings.curseForgeApiKey) {
    setCurseForgeApiKey(savedSettings.curseForgeApiKey)
  }

  // CurseForge 配置状态
  ipcMain.handle('curseforge:isConfigured', safe(() => isCurseForgeConfigured()))

  // ========== 版本 ==========
  ipcMain.handle('versions:getManifest', safe((_, forceRefresh?: boolean) =>
    getVersionManifest(forceRefresh)))

  ipcMain.handle('versions:getList', safe((_, type?: 'release' | 'snapshot') =>
    getVersionList(type)))

  ipcMain.handle('versions:getLocal', safe((_, gameDir: string) =>
    getLocalVersions(gameDir)))

  // ========== 下载 & 安装 ==========
  ipcMain.handle('download:installVersion', async (event, versionId: string, gameDir: string) => {
    try {
      const sendProgress = (p: DownloadProgress) => {
        try {
          event.sender.send('download:progress', {
            total: p.total,
            completed: p.completed,
            failed: p.failed,
            speed: p.speed,
            currentFile: p.currentFile || ''
          })
        } catch { /* ignore progress send failures */ }
      }

      const versionJson = await getVersionJson(versionId, gameDir)
      const librariesDir = path.join(gameDir, 'libraries')

      // 1. 库文件
      const libTasks = collectLibraryTasks(versionJson, librariesDir)
      const nativeTasks = collectNativeTasks(versionJson, librariesDir)
      const clientTask = collectClientTask(versionJson, path.join(gameDir, 'versions'))

      const allTasks = [...libTasks, ...nativeTasks]
      if (clientTask) allTasks.push(clientTask)

      // 2. 资源文件
      const assetTasks = await collectAssetTasks(versionJson, gameDir)
      allTasks.push(...assetTasks)

      // 3. 批量下载
      const result = await downloadBatch(allTasks, 8, sendProgress)

      // 4. 提取 natives
      const nativesDir = path.join(gameDir, 'versions', versionId, 'natives')
      await extractNatives(versionJson, librariesDir, nativesDir)

      return { success: result.success, failed: result.failed }
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e))
    }
  })

  // ========== Java ==========
  ipcMain.handle('java:scan', safe(() => scanSystemJava()))

  ipcMain.handle('java:validate', safe((_, javaPath: string) =>
    validateJavaPath(javaPath)))

  ipcMain.handle('java:distros', safe(() => JAVA_DISTROS))

  ipcMain.handle('java:installedRuntimes', safe(() => getInstalledRuntimes()))

  ipcMain.handle('java:install', async (event, distroId: string, majorVersion: number) => {
    const javaPath = await installJavaRuntime(distroId, majorVersion, (p: JavaDownloadProgress) => {
      event.sender.send('java:installProgress', p)
    })
    return javaPath
  })

  // ========== Profile ==========
  ipcMain.handle('profiles:getAll', safe(() => getAllProfiles()))
  ipcMain.handle('profiles:get', safe((_, id: string) => getProfile(id)))
  ipcMain.handle('profiles:create', safe((_, opts) => createProfile(opts)))
  ipcMain.handle('profiles:update', safe((_, id: string, updates) => updateProfile(id, updates)))
  ipcMain.handle('profiles:delete', safe((_, id: string) => deleteProfile(id)))
  ipcMain.handle('profiles:duplicate', safe((_, id: string) => duplicateProfile(id)))
  ipcMain.handle('profiles:scanDir', safe((_, gameDir: string) => scanGameDir(gameDir)))

  // ========== 启动游戏 ==========
  ipcMain.handle('launch:start', async (event, profileId: string, account: MinecraftAccount) => {
    const profile = getProfile(profileId)
    if (!profile) throw new Error('实例不存在')

    // 如果是微软/Yggdrasil账号，确保 token 有效
    let validAccount = account
    if (account.type === 'microsoft' || account.type === 'yggdrasil') {
      validAccount = await ensureValidToken(account)
    }

    const gameDir = profile.gameDir

    // 确定实际版本 ID（如果有 Mod Loader 则使用 loader 版本）
    let actualVersionId = profile.versionId
    if (profile.modLoader) {
      try {
        actualVersionId = await installModLoader(profile.modLoader, profile.versionId, gameDir, profile.javaPath || undefined)
      } catch {
        // 如果安装失败但 loader 版本 JSON 已存在，尝试继续
      }
    }

    const versionJson = await getVersionJson(actualVersionId, gameDir)

    // 选择 Java
    let javaPath = profile.javaPath
    if (!javaPath) {
      const javas = await scanSystemJava()
      const required = versionJson.javaVersion?.majorVersion || 17
      const selected = selectJava(javas, required)
      if (!selected) throw new Error(`未找到 Java ${required}+，请在实例设置中手动指定JVM路径`)
      javaPath = selected.path
    }

    const resolvedProfile = { ...profile, javaPath }

    const child = launchGame(resolvedProfile, versionJson, validAccount, gameDir)

    child.stdout?.on('data', (data: Buffer) => {
      event.sender.send('launch:log', data.toString())
    })
    child.stderr?.on('data', (data: Buffer) => {
      event.sender.send('launch:log', data.toString())
    })
    child.on('exit', (code) => {
      event.sender.send('launch:exit', code)
    })

    // 更新 lastPlayed
    updateProfile(profileId, { lastPlayed: Date.now() })

    return { pid: child.pid }
  })

  // ========== Mod Loader ==========
  ipcMain.handle('modloader:fabricVersions', safe((_, mcVersion: string) =>
    fetchFabricLoaderVersions(mcVersion)))
  ipcMain.handle('modloader:quiltVersions', safe((_, mcVersion: string) =>
    fetchQuiltLoaderVersions(mcVersion)))
  ipcMain.handle('modloader:forgeVersions', safe((_, mcVersion: string) =>
    fetchForgeVersions(mcVersion)))
  ipcMain.handle('modloader:neoforgeVersions', safe((_, mcVersion: string) =>
    fetchNeoForgeVersions(mcVersion)))
  ipcMain.handle('modloader:installFabric', safe((_, mcVersion: string, loaderVersion: string, gameDir: string) =>
    installFabricLoader(mcVersion, loaderVersion, gameDir)))
  ipcMain.handle('modloader:installQuilt', safe((_, mcVersion: string, loaderVersion: string, gameDir: string) =>
    installQuiltLoader(mcVersion, loaderVersion, gameDir)))
  ipcMain.handle('modloader:installForge', safe((_, mcVersion: string, forgeVersion: string, gameDir: string, javaPath?: string) =>
    installForgeLoader(mcVersion, forgeVersion, gameDir, javaPath)))
  ipcMain.handle('modloader:installNeoForge', safe((_, mcVersion: string, nfVersion: string, gameDir: string, javaPath?: string) =>
    installNeoForgeLoader(mcVersion, nfVersion, gameDir, javaPath)))

  // ========== 镜像源 ==========
  ipcMain.handle('mirror:get', safe(() => getMirrorSource()))
  ipcMain.handle('mirror:set', safe((_, source) => setMirrorSource(source)))

  // ========== 系统对话框 ==========
  ipcMain.handle('dialog:selectDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:selectDirectoryAt', async (_, defaultPath?: string) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      defaultPath: defaultPath || undefined
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:selectFile', async (_, filters?: Electron.FileFilter[]) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: filters || [{ name: 'Java', extensions: ['exe'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ========== 系统信息 ==========
  ipcMain.handle('system:totalMemory', safe(() => getTotalMemoryMB()))
  ipcMain.handle('system:defaultGameDir', safe(() => getDefaultMinecraftDir()))
  ipcMain.handle('system:platform', safe(() => process.platform))
  ipcMain.handle('system:openFolder', safe((_, folderPath: string) => shell.openPath(folderPath)))

  // ========== 微软认证 ==========
  ipcMain.handle('auth:startMsLogin', async (event) => {
    if (msLoginAbort) msLoginAbort.abort()
    msLoginAbort = new AbortController()

    const sendProgress = (p: AuthProgressEvent) => {
      event.sender.send('auth:loginProgress', p)
    }

    try {
      const account = await fullMicrosoftLogin(sendProgress, msLoginAbort.signal)
      msLoginAbort = null
      return account
    } catch (err: unknown) {
      msLoginAbort = null
      const msg = err instanceof Error ? err.message : String(err)
      sendProgress({ state: 'error', error: msg })
      throw err
    }
  })

  ipcMain.handle('auth:cancelMsLogin', () => {
    if (msLoginAbort) {
      msLoginAbort.abort()
      msLoginAbort = null
    }
  })

  ipcMain.handle('auth:refreshToken', safe(async (_, accountId: string) => {
    const accounts = getAllAccounts()
    const account = accounts.find(a => a.id === accountId)
    if (!account) throw new Error('账号不存在')
    return refreshAccountToken(account)
  }))

  ipcMain.handle('auth:getAccounts', safe(() => ({
    accounts: getAllAccounts(),
    selectedId: getSelectedAccountId()
  })))

  ipcMain.handle('auth:saveAccount', safe((_, account: MinecraftAccount) => {
    saveAccount(account)
  }))

  ipcMain.handle('auth:removeAccount', safe((_, id: string) => {
    removeAccountFromStore(id)
  }))

  ipcMain.handle('auth:setSelectedId', safe((_, id: string) => {
    setSelectedAccountId(id)
  }))

  ipcMain.handle('auth:ensureValidToken', safe(async (_, account: MinecraftAccount) => {
    return ensureValidToken(account)
  }))

  ipcMain.handle('auth:openUrl', safe((_, url: string) => {
    shell.openExternal(url)
  }))

  ipcMain.handle('auth:getClientId', safe(() => getClientId()))

  ipcMain.handle('auth:setClientId', safe((_, id: string) => {
    setClientId(id)
  }))

  // ========== Yggdrasil 第三方认证 ==========
  ipcMain.handle('auth:yggdrasilResolveApi', safe(async (_, inputUrl: string) => {
    return resolveApiRoot(inputUrl)
  }))

  ipcMain.handle('auth:yggdrasilServerInfo', safe(async (_, apiRoot: string) => {
    return getServerInfo(apiRoot)
  }))

  ipcMain.handle('auth:yggdrasilLogin', safe(async (_, apiRoot: string, username: string, password: string) => {
    const { account } = await fullYggdrasilLogin(apiRoot, username, password)
    saveAccount(account)
    return account
  }))

  ipcMain.handle('auth:yggdrasilGetServers', safe(() => getYggdrasilServers()))
  ipcMain.handle('auth:yggdrasilPresetServers', safe(() => PRESET_SERVERS))

  ipcMain.handle('auth:yggdrasilAddServer', safe((_, server: YggdrasilServerInfo) => {
    addYggdrasilServer(server)
  }))

  ipcMain.handle('auth:yggdrasilRemoveServer', safe((_, url: string) => {
    removeYggdrasilServer(url)
  }))

  // ========== 头像代理 ==========
  ipcMain.handle('auth:fetchAvatar', async (_, url: string): Promise<string> => {
    try {
      const resp = await net.fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!resp.ok) return ''
      const buf = Buffer.from(await resp.arrayBuffer())
      const mime = resp.headers.get('content-type') || 'image/png'
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch {
      return ''
    }
  })

  // ========== 资源下载中心 ==========
  ipcMain.handle('resources:search', safe((_, params: ResourceSearchParams) =>
    searchResources(params)))

  ipcMain.handle('resources:detail', safe((_, platform: ResourcePlatform, id: string) =>
    getResourceDetail(platform, id)))

  ipcMain.handle('resources:versions', safe((_, platform: ResourcePlatform, projectId: string, loaders?: string[], gameVersions?: string[]) =>
    getResourceVersions(platform, projectId, loaders, gameVersions)))

  ipcMain.handle('resources:install', async (event, file: ResourceFile, type: ResourceType, gameDir: string, meta: { projectId: string; platform: ResourcePlatform; versionId: string; versionNumber: string; title: string }) => {
    event.sender.send('resources:installProgress', { status: 'downloading', filename: file.filename })
    try {
      const result = await installResource(file, type, gameDir, meta)
      event.sender.send('resources:installProgress', { status: 'done', filename: file.filename })
      return result
    } catch (err) {
      event.sender.send('resources:installProgress', { status: 'error', filename: file.filename, error: String(err) })
      throw err
    }
  })

  ipcMain.handle('resources:installed', safe((_, type: ResourceType, gameDir: string) =>
    getInstalledResources(type, gameDir)))

  ipcMain.handle('resources:remove', safe((_, type: ResourceType, gameDir: string, filename: string) =>
    removeResource(type, gameDir, filename)))

  ipcMain.handle('resources:toggle', safe((_, type: ResourceType, gameDir: string, filename: string, enabled: boolean) =>
    toggleResource(type, gameDir, filename, enabled)))

  ipcMain.handle('resources:dependencies', safe((_, version: ResourceVersion, platform: ResourcePlatform) =>
    resolveDependencies(version, platform)))

  // ========== 整合包安装 ==========
  ipcMain.handle('modpack:install', async (event, source: string, mrpackFilename: string, gameDir: string, profileName: string) => {
    try {
      const result = await installModpack(source, mrpackFilename, gameDir, profileName, (p) => {
        try {
          event.sender.send('modpack:installProgress', {
            stage: p.stage,
            message: p.message,
            fileProgress: p.fileProgress ? {
              total: p.fileProgress.total,
              completed: p.fileProgress.completed,
              failed: p.fileProgress.failed,
              speed: p.fileProgress.speed
            } : undefined
          })
        } catch { /* ignore */ }
      })
      return result
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e))
    }
  })

  ipcMain.handle('modpack:importLocal', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('无法获取窗口')
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Modpack', extensions: ['mrpack', 'zip'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null

    const filePath = result.filePaths[0]
    const filename = path.basename(filePath)
    return { filePath, filename }
  })

  // ========== MC Server 管理 ==========
  ipcMain.handle('server:downloadCore', safe(async (_, config: ServerCoreConfig, gameDir: string, javaPath?: string) => {
    return downloadServerCore(config, gameDir, javaPath)
  }))

  ipcMain.handle('server:start', safe(async (_, config: McServerConfig) => {
    return startMcServer(config)
  }))

  ipcMain.handle('server:stop', safe(async () => {
    return stopMcServer()
  }))

  ipcMain.handle('server:command', safe((_, command: string) => {
    sendServerCommand(command)
  }))

  ipcMain.handle('server:status', safe(() => {
    return getServerStatus()
  }))

  // ========== 存档管理 ==========
  ipcMain.handle('save:pack', safe(async (_, worldDir: string) => {
    return packSave(worldDir)
  }))

  ipcMain.handle('save:unpack', safe(async (_, archivePath: string, targetDir: string, expectedSha1?: string) => {
    return unpackSave(archivePath, targetDir, expectedSha1)
  }))

  ipcMain.handle('save:info', safe(async (_, worldDir: string) => {
    return getSaveInfo(worldDir)
  }))

  ipcMain.handle('save:list', safe(async (_, gameDir: string) => {
    return listSaves(gameDir)
  }))

  // ========== 自动重连提示 (Plan C) ==========
  ipcMain.handle('reconnect:writeHint', safe(async (_, gameDir: string, host: string, port: number) => {
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const filePath = path.join(gameDir, '.mc-reconnect.json')
    await fsp.writeFile(filePath, JSON.stringify({
      action: 'reconnect',
      host,
      port,
      timestamp: Date.now(),
    }), 'utf-8')
  }))

  ipcMain.handle('reconnect:clearHint', safe(async (_, gameDir: string) => {
    const fsp = await import('node:fs/promises')
    const path = await import('node:path')
    const filePath = path.join(gameDir, '.mc-reconnect.json')
    try { await fsp.unlink(filePath) } catch { /* ignore */ }
  }))

  // ========== 窗口控制 ==========
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      win.isMaximized() ? win.unmaximize() : win.maximize()
    }
  })
  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}
