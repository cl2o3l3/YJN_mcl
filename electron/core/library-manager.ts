import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import { createReadStream } from 'node:fs'
import type { VersionJson, VersionLibrary, LibraryRule, DownloadTask } from '../../src/types'
import { getOSName, getArch, mavenToPath, getClasspathSeparator } from './platform'
import { mirrorLibraryUrl, mirrorClientUrl } from './mirror-manager'

/** 判断一个库是否适用于当前平台 */
export function isLibraryAllowed(lib: VersionLibrary): boolean {
  if (!lib.rules) return true
  let allowed = false
  for (const rule of lib.rules) {
    if (matchRule(rule)) {
      allowed = rule.action === 'allow'
    }
  }
  return allowed
}

function matchRule(rule: LibraryRule): boolean {
  if (!rule.os) return true
  const osName = getOSName()
  if (rule.os.name && rule.os.name !== osName) return false
  if (rule.os.arch && rule.os.arch !== getArch()) return false
  return true
}

/** 收集需要下载的库任务列表 */
export function collectLibraryTasks(
  versionJson: VersionJson,
  librariesDir: string
): DownloadTask[] {
  const tasks: DownloadTask[] = []

  for (const lib of versionJson.libraries) {
    if (!isLibraryAllowed(lib)) continue

    if (lib.downloads?.artifact) {
      const art = lib.downloads.artifact
      // Forge 处理器输出的 artifact 的 url 为空字符串, 由 installer 本地生成, 跳过下载
      if (art.url) {
        const mirrored = mirrorLibraryUrl(art.url)
        tasks.push({
          url: mirrored,
          path: path.join(librariesDir, art.path),
          sha1: art.sha1,
          size: art.size,
          fallbackUrls: mirrored !== art.url ? [art.url] : undefined
        })
      }
    } else if (lib.name && lib.url) {
      // Fabric/Quilt 等使用 Maven URL
      const relPath = mavenToPath(lib.name)
      const originalUrl = lib.url.endsWith('/') ? lib.url + relPath : lib.url + '/' + relPath
      const mirrored = mirrorLibraryUrl(originalUrl)
      tasks.push({
        url: mirrored,
        path: path.join(librariesDir, relPath),
        fallbackUrls: mirrored !== originalUrl ? [originalUrl] : undefined
      })
    } else if (lib.name) {
      // 无 downloads 且无 url, 使用 Mojang Maven
      const relPath = mavenToPath(lib.name)
      const originalUrl = `https://libraries.minecraft.net/${relPath}`
      const mirrored = mirrorLibraryUrl(originalUrl)
      tasks.push({
        url: mirrored,
        path: path.join(librariesDir, relPath),
        fallbackUrls: mirrored !== originalUrl ? [originalUrl] : undefined
      })
    }
  }

  return tasks
}

/** 收集 native 库的下载任务 */
export function collectNativeTasks(
  versionJson: VersionJson,
  librariesDir: string
): DownloadTask[] {
  const tasks: DownloadTask[] = []
  const osName = getOSName()

  for (const lib of versionJson.libraries) {
    if (!isLibraryAllowed(lib)) continue
    if (!lib.natives) continue

    const classifier = lib.natives[osName]
    if (!classifier) continue

    const resolvedClassifier = classifier.replace('${arch}', getArch() === 'x64' ? '64' : '32')
    const artifact = lib.downloads?.classifiers?.[resolvedClassifier]
    if (artifact) {
      const mirrored = mirrorLibraryUrl(artifact.url)
      tasks.push({
        url: mirrored,
        path: path.join(librariesDir, artifact.path),
        sha1: artifact.sha1,
        size: artifact.size,
        fallbackUrls: mirrored !== artifact.url ? [artifact.url] : undefined
      })
    }
  }

  return tasks
}

/** 收集客户端 JAR 下载任务 */
export function collectClientTask(
  versionJson: VersionJson,
  versionsDir: string
): DownloadTask | null {
  const dl = versionJson.downloads?.client
  if (!dl) return null
  const mirrored = mirrorClientUrl(dl.url)
  return {
    url: mirrored,
    path: path.join(versionsDir, versionJson.id, `${versionJson.id}.jar`),
    sha1: dl.sha1,
    size: dl.size,
    fallbackUrls: mirrored !== dl.url ? [dl.url] : undefined
  }
}

/** 提取 natives 到目标目录 */
export async function extractNatives(
  versionJson: VersionJson,
  librariesDir: string,
  nativesDir: string
): Promise<void> {
  await fsp.mkdir(nativesDir, { recursive: true })
  const osName = getOSName()
  const { Extract } = await import('unzipper')

  for (const lib of versionJson.libraries) {
    if (!isLibraryAllowed(lib)) continue
    if (!lib.natives) continue

    const classifier = lib.natives[osName]
    if (!classifier) continue

    const resolvedClassifier = classifier.replace('${arch}', getArch() === 'x64' ? '64' : '32')
    const artifact = lib.downloads?.classifiers?.[resolvedClassifier]
    if (!artifact) continue

    const jarPath = path.join(librariesDir, artifact.path)
    if (!fs.existsSync(jarPath)) continue

    const excludes = lib.extract?.exclude || []

    try {
      const readStream = createReadStream(jarPath)
      const extractor = readStream.pipe(Extract({ path: nativesDir }))

      extractor.on('entry', (entry: { path: string; autodrain: () => void }) => {
        if (excludes.some(ex => entry.path.startsWith(ex))) {
          entry.autodrain()
        }
      })

      await new Promise<void>((resolve, reject) => {
        extractor.on('close', resolve)
        extractor.on('error', reject)
      })
    } catch {
      // 旧版 natives JAR 可能格式特殊, 在此跳过
    }
  }
}

/** 构建 classpath 字符串 */
export function buildClasspath(
  versionJson: VersionJson,
  librariesDir: string,
  versionsDir: string
): string {
  const sep = getClasspathSeparator()
  const paths: string[] = []

  for (const lib of versionJson.libraries) {
    if (!isLibraryAllowed(lib)) continue
    // 跳过 natives-only 的库
    if (lib.natives && !lib.downloads?.artifact) continue

    if (lib.downloads?.artifact) {
      paths.push(path.join(librariesDir, lib.downloads.artifact.path))
    } else if (lib.name) {
      paths.push(path.join(librariesDir, mavenToPath(lib.name)))
    }
  }

  // 客户端 JAR
  const clientJar = path.join(versionsDir, versionJson.id, `${versionJson.id}.jar`)
  // inheritsFrom 的情况: 客户端 JAR 可能在父版本目录
  if (fs.existsSync(clientJar)) {
    paths.push(clientJar)
  } else if (versionJson.inheritsFrom) {
    const parentJar = path.join(versionsDir, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`)
    if (fs.existsSync(parentJar)) paths.push(parentJar)
  }

  return paths.join(sep)
}
