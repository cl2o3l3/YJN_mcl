import fsp from 'node:fs/promises'
import path from 'node:path'
import unzipper from 'unzipper'
import { downloadFile, downloadBatch } from './download'
import { installModLoader } from './modloader-manager'
import { getFileInfoBatch } from './curseforge-api'
import { getVersionJson } from './version-manager'
import { collectLibraryTasks, collectNativeTasks, collectClientTask, extractNatives } from './library-manager'
import { collectAssetTasks } from './asset-manager'
import type { ModLoaderInfo, DownloadTask } from '../../src/types'

// ========== Modrinth .mrpack 格式类型 ==========

interface MrpackIndex {
  formatVersion: number
  game: string
  versionId: string
  name: string
  summary?: string
  files: MrpackFile[]
  dependencies: Record<string, string>
}

interface MrpackFile {
  path: string
  hashes: { sha1?: string; sha512?: string }
  env?: { client?: string; server?: string }
  downloads: string[]
  fileSize: number
}

interface CurseForgeManifest {
  minecraft: {
    version: string
    modLoaders?: Array<{ id: string; primary?: boolean }>
  }
  manifestType: string
  manifestVersion: number
  name: string
  version: string
  author?: string
  files: CurseForgeManifestFile[]
  overrides?: string
}

interface CurseForgeManifestFile {
  projectID: number
  fileID: number
  required?: boolean
}

interface ResolvedModpack {
  name: string
  mcVersion: string
  modLoader?: ModLoaderInfo
  downloadTasks: DownloadTask[]
  overridesDirs: string[]
  format: 'modrinth' | 'curseforge'
}

// ========== 进度回调 ==========

export interface ModpackInstallProgress {
  stage: 'downloading-pack' | 'parsing' | 'installing-game' | 'installing-loader' | 'downloading-files' | 'extracting-overrides' | 'done' | 'error'
  message: string
  fileProgress?: { total: number; completed: number; failed: number; speed: number }
}

// ========== 核心安装逻辑 ==========

export async function installModpack(
  source: string,
  mrpackFilename: string,
  gameDir: string,
  profileName: string,
  onProgress?: (progress: ModpackInstallProgress) => void
): Promise<{
  name: string
  mcVersion: string
  modLoader?: ModLoaderInfo
  instanceDir: string
  iconPath?: string
}> {
  // 1. 创建整合包实例目录
  const instanceDir = path.join(gameDir, 'instances', sanitizeDirName(profileName))
  await fsp.mkdir(instanceDir, { recursive: true })

  // 2. 获取整合包压缩包（URL 则下载，本地路径则复制）
  const isUrl = /^https?:\/\//i.test(source)
  const mrpackPath = path.join(instanceDir, mrpackFilename)
  if (isUrl) {
    onProgress?.({ stage: 'downloading-pack', message: `正在下载整合包: ${mrpackFilename}` })
    await downloadFile(source, mrpackPath)
  } else {
    onProgress?.({ stage: 'downloading-pack', message: `正在复制整合包文件...` })
    await fsp.copyFile(source, mrpackPath)
  }

  // 3. 解析整合包元数据
  onProgress?.({ stage: 'parsing', message: '正在解析整合包...' })
  const pack = await parsePackArchive(mrpackPath)

  // 4. 提取 MC 版本和 Mod Loader 信息
  const mcVersion = pack.mcVersion
  const modLoader = pack.modLoader

  // 5. 安装基础游戏版本 (libraries + assets + client + natives)
  onProgress?.({ stage: 'installing-game', message: `正在安装 Minecraft ${mcVersion}...` })
  const versionJson = await getVersionJson(mcVersion, gameDir)
  const librariesDir = path.join(gameDir, 'libraries')
  const libTasks = collectLibraryTasks(versionJson, librariesDir)
  const nativeTasks = collectNativeTasks(versionJson, librariesDir)
  const clientTask = collectClientTask(versionJson, path.join(gameDir, 'versions'))
  const gameTasks = [...libTasks, ...nativeTasks]
  if (clientTask) gameTasks.push(clientTask)
  const assetTasks = await collectAssetTasks(versionJson, gameDir)
  gameTasks.push(...assetTasks)
  await downloadBatch(gameTasks, 8)
  const nativesDir = path.join(gameDir, 'versions', mcVersion, 'natives')
  await extractNatives(versionJson, librariesDir, nativesDir)

  // 6. 安装 Mod Loader
  if (modLoader) {
    onProgress?.({ stage: 'installing-loader', message: `正在安装 ${modLoader.type} ${modLoader.version}...` })
    await installModLoader(modLoader, mcVersion, gameDir)
  }

  // 7. 下载所有 mod 文件
  if (pack.downloadTasks.length > 0) {
    onProgress?.({ stage: 'downloading-files', message: `正在下载 ${pack.downloadTasks.length} 个文件...` })

    const downloadTasks = pack.downloadTasks.map(task => ({
      ...task,
      path: path.isAbsolute(task.path) ? task.path : path.join(instanceDir, task.path)
    }))

    await downloadBatch(downloadTasks, 32, (p) => {
      onProgress?.({
        stage: 'downloading-files',
        message: `正在下载文件 (${p.completed}/${p.total})`,
        fileProgress: { total: p.total, completed: p.completed, failed: p.failed, speed: p.speed }
      })
    })
  }

  // 8. 提取 overrides 目录
  onProgress?.({ stage: 'extracting-overrides', message: '正在提取配置文件...' })
  await extractOverrides(mrpackPath, instanceDir, pack.overridesDirs)

  // 9. 提取图标
  const iconPath = await extractIcon(mrpackPath, instanceDir)

  // 10. 清理 .mrpack 文件
  await fsp.rm(mrpackPath, { force: true }).catch(() => {})

  onProgress?.({ stage: 'done', message: '整合包安装完成!' })

  return {
    name: pack.name || profileName,
    mcVersion,
    modLoader,
    instanceDir,
    iconPath
  }
}

// ========== 内部函数 ==========

async function parsePackArchive(archivePath: string): Promise<ResolvedModpack> {
  const directory = await unzipper.Open.file(archivePath)
  const mrpackEntry = directory.files.find(f => f.path === 'modrinth.index.json')
  if (mrpackEntry) {
    const content = await mrpackEntry.buffer()
    const index = JSON.parse(content.toString('utf-8')) as MrpackIndex
    return buildResolvedMrpack(index, archivePath)
  }

  const manifestEntry = directory.files.find(f => f.path === 'manifest.json')
  if (manifestEntry) {
    const content = await manifestEntry.buffer()
    const manifest = JSON.parse(content.toString('utf-8')) as CurseForgeManifest
    return buildResolvedCurseForgePack(manifest)
  }

  throw new Error('无法识别整合包格式: 缺少 modrinth.index.json 或 manifest.json')
}

function buildResolvedMrpack(index: MrpackIndex, archivePath: string): ResolvedModpack {
  const mcVersion = index.dependencies['minecraft']
  if (!mcVersion) throw new Error('整合包未指定 Minecraft 版本')

  const clientFiles = index.files.filter(f => {
    if (!f.env) return true
    return f.env.client !== 'unsupported'
  })

  const downloadTasks: DownloadTask[] = clientFiles.map(f => ({
    url: f.downloads[0],
    path: path.join(path.dirname(archivePath), f.path),
    sha1: f.hashes.sha1,
    size: f.fileSize
  }))

  return {
    name: index.name,
    mcVersion,
    modLoader: resolveModLoader(index.dependencies),
    downloadTasks,
    overridesDirs: ['overrides/', 'client-overrides/'],
    format: 'modrinth'
  }
}

async function buildResolvedCurseForgePack(manifest: CurseForgeManifest): Promise<ResolvedModpack> {
  const mcVersion = manifest.minecraft?.version
  if (!mcVersion) throw new Error('CurseForge 整合包未指定 Minecraft 版本')

  const fileEntries = manifest.files.filter(file => file.required !== false)
  const fileIds = fileEntries.map(f => f.fileID)

  let fileInfos: Awaited<ReturnType<typeof getFileInfoBatch>>
  try {
    fileInfos = await getFileInfoBatch(fileIds)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`批量解析 CurseForge 文件失败: ${message}`)
  }

  const downloadTasks: DownloadTask[] = fileInfos.map(file => {
    if (!file.downloadUrl) {
      throw new Error(`无法获取 CurseForge 文件下载地址: ${file.modId}/${file.id}`)
    }
    return {
      url: file.downloadUrl,
      path: path.join('mods', file.fileName),
      sha1: file.sha1,
      size: file.fileLength
    }
  })

  return {
    name: manifest.name,
    mcVersion,
    modLoader: resolveCurseForgeModLoader(manifest.minecraft.modLoaders || []),
    downloadTasks,
    overridesDirs: [((manifest.overrides || 'overrides').replace(/\\/g, '/').replace(/\/?$/, '/'))],
    format: 'curseforge'
  }
}

/** 从 dependencies 中提取 Mod Loader 信息 */
function resolveModLoader(deps: Record<string, string>): ModLoaderInfo | undefined {
  if (deps['fabric-loader']) {
    return { type: 'fabric', version: deps['fabric-loader'] }
  }
  if (deps['quilt-loader']) {
    return { type: 'quilt', version: deps['quilt-loader'] }
  }
  if (deps['forge']) {
    return { type: 'forge', version: deps['forge'] }
  }
  if (deps['neoforge']) {
    return { type: 'neoforge', version: deps['neoforge'] }
  }
  return undefined
}

function resolveCurseForgeModLoader(loaders: Array<{ id: string; primary?: boolean }>): ModLoaderInfo | undefined {
  const primary = loaders.find(loader => loader.primary) || loaders[0]
  if (!primary?.id) return undefined

  const raw = primary.id.toLowerCase()
  const prefixes: Array<ModLoaderInfo['type']> = ['fabric', 'forge', 'quilt', 'neoforge']
  for (const prefix of prefixes) {
    if (raw.startsWith(prefix + '-')) {
      return { type: prefix, version: primary.id.slice(prefix.length + 1) }
    }
  }

  if (raw.startsWith('neo-forge-')) {
    return { type: 'neoforge', version: primary.id.slice('neo-forge-'.length) }
  }

  return undefined
}

/** 从整合包中提取 overrides 目录到实例目录 */
async function extractOverrides(archivePath: string, instanceDir: string, roots: string[]): Promise<void> {
  const directory = await unzipper.Open.file(archivePath)

  for (const entry of directory.files) {
    let relativePath: string | null = null

    for (const root of roots) {
      if (entry.path.startsWith(root)) {
        relativePath = entry.path.slice(root.length)
        break
      }
    }

    if (!relativePath || relativePath === '') continue

    // 安全检查: 防止路径遍历
    const resolved = path.resolve(instanceDir, relativePath)
    if (!resolved.startsWith(instanceDir)) continue

    if (entry.type === 'Directory') {
      await fsp.mkdir(resolved, { recursive: true })
    } else {
      await fsp.mkdir(path.dirname(resolved), { recursive: true })
      const content = await entry.buffer()
      await fsp.writeFile(resolved, content)
    }
  }
}

/** 清理文件名以用作目录名 */
function sanitizeDirName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0, 64)
}

/** 从整合包中提取图标 (icon.png) */
async function extractIcon(archivePath: string, instanceDir: string): Promise<string | undefined> {
  try {
    const directory = await unzipper.Open.file(archivePath)
    // Modrinth: icon.png at root; CurseForge: icon.png or modpack-icon.png
    const iconEntry = directory.files.find(f =>
      /^(icon\.png|modpack-icon\.png)$/i.test(f.path) && f.type !== 'Directory'
    )
    if (!iconEntry) return undefined

    const iconDest = path.join(instanceDir, 'icon.png')
    const content = await iconEntry.buffer()
    await fsp.writeFile(iconDest, content)
    return iconDest
  } catch {
    return undefined
  }
}
