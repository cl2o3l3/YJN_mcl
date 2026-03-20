import fsp from 'node:fs/promises'
import path from 'node:path'
import unzipper from 'unzipper'
import { downloadFile, downloadBatch } from './download'
import { installModLoader } from './modloader-manager'
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

// ========== 进度回调 ==========

export interface ModpackInstallProgress {
  stage: 'downloading-pack' | 'parsing' | 'installing-game' | 'installing-loader' | 'downloading-files' | 'extracting-overrides' | 'done' | 'error'
  message: string
  fileProgress?: { total: number; completed: number; failed: number; speed: number }
}

// ========== 核心安装逻辑 ==========

export async function installModpack(
  mrpackUrl: string,
  mrpackFilename: string,
  gameDir: string,
  profileName: string,
  onProgress?: (progress: ModpackInstallProgress) => void
): Promise<{
  name: string
  mcVersion: string
  modLoader?: ModLoaderInfo
  instanceDir: string
}> {
  // 1. 创建整合包实例目录
  const instanceDir = path.join(gameDir, 'instances', sanitizeDirName(profileName))
  await fsp.mkdir(instanceDir, { recursive: true })

  // 2. 下载 .mrpack 文件
  onProgress?.({ stage: 'downloading-pack', message: `正在下载整合包: ${mrpackFilename}` })
  const mrpackPath = path.join(instanceDir, mrpackFilename)
  await downloadFile(mrpackUrl, mrpackPath)

  // 3. 解析 modrinth.index.json
  onProgress?.({ stage: 'parsing', message: '正在解析整合包...' })
  const index = await parseMrpack(mrpackPath)

  // 4. 提取 MC 版本和 Mod Loader 信息
  const mcVersion = index.dependencies['minecraft']
  if (!mcVersion) throw new Error('整合包未指定 Minecraft 版本')

  const modLoader = resolveModLoader(index.dependencies)

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
  const clientFiles = index.files.filter(f => {
    if (!f.env) return true
    return f.env.client !== 'unsupported'
  })

  if (clientFiles.length > 0) {
    onProgress?.({ stage: 'downloading-files', message: `正在下载 ${clientFiles.length} 个文件...` })

    const tasks: DownloadTask[] = clientFiles.map(f => ({
      url: f.downloads[0],
      path: path.join(instanceDir, f.path),
      sha1: f.hashes.sha1,
      size: f.fileSize
    }))

    await downloadBatch(tasks, 16, (p) => {
      onProgress?.({
        stage: 'downloading-files',
        message: `正在下载文件 (${p.completed}/${p.total})`,
        fileProgress: { total: p.total, completed: p.completed, failed: p.failed, speed: p.speed }
      })
    })
  }

  // 8. 提取 overrides 目录
  onProgress?.({ stage: 'extracting-overrides', message: '正在提取配置文件...' })
  await extractOverrides(mrpackPath, instanceDir)

  // 9. 清理 .mrpack 文件
  await fsp.rm(mrpackPath, { force: true }).catch(() => {})

  onProgress?.({ stage: 'done', message: '整合包安装完成!' })

  return {
    name: index.name || profileName,
    mcVersion,
    modLoader,
    instanceDir
  }
}

// ========== 内部函数 ==========

/** 解析 .mrpack 中的 modrinth.index.json */
async function parseMrpack(mrpackPath: string): Promise<MrpackIndex> {
  const directory = await unzipper.Open.file(mrpackPath)
  const indexEntry = directory.files.find(f => f.path === 'modrinth.index.json')
  if (!indexEntry) throw new Error('无效的 .mrpack 文件: 缺少 modrinth.index.json')

  const content = await indexEntry.buffer()
  return JSON.parse(content.toString('utf-8')) as MrpackIndex
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

/** 从 .mrpack 中提取 overrides/ 和 client-overrides/ 到实例目录 */
async function extractOverrides(mrpackPath: string, instanceDir: string): Promise<void> {
  const directory = await unzipper.Open.file(mrpackPath)

  for (const entry of directory.files) {
    let relativePath: string | null = null
    if (entry.path.startsWith('overrides/')) {
      relativePath = entry.path.slice('overrides/'.length)
    } else if (entry.path.startsWith('client-overrides/')) {
      relativePath = entry.path.slice('client-overrides/'.length)
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
