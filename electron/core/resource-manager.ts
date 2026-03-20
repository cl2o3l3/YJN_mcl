import fsp from 'node:fs/promises'
import path from 'node:path'
import { downloadFile } from './download'
import * as modrinth from './modrinth-api'
import * as curseforge from './curseforge-api'
import type {
  ResourceSearchParams, ResourceSearchResult, ResourceProject,
  ResourceVersion, ResourceFile, ResourceType, ResourcePlatform,
  InstalledResource
} from '../../src/types'

// ========== 目录映射 ==========

function getResourceSubdir(type: ResourceType): string {
  switch (type) {
    case 'mod': return 'mods'
    case 'shader': return 'shaderpacks'
    case 'resourcepack': return 'resourcepacks'
    case 'modpack': return 'modpacks'
  }
}

function getResourceDir(gameDir: string, type: ResourceType): string {
  return path.join(gameDir, getResourceSubdir(type))
}

// ========== 元数据文件 ==========

const METADATA_FILE = '.mc-launcher-resources.json'

interface ResourceMetadata {
  installed: InstalledResource[]
}

async function readMetadata(gameDir: string): Promise<ResourceMetadata> {
  const metaPath = path.join(gameDir, METADATA_FILE)
  try {
    const raw = await fsp.readFile(metaPath, 'utf-8')
    return JSON.parse(raw) as ResourceMetadata
  } catch {
    return { installed: [] }
  }
}

async function writeMetadata(gameDir: string, meta: ResourceMetadata): Promise<void> {
  const metaPath = path.join(gameDir, METADATA_FILE)
  await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
}

// ========== 搜索 ==========

export async function searchResources(params: ResourceSearchParams): Promise<ResourceSearchResult> {
  const platform = params.platform || 'modrinth'
  if (platform === 'modrinth') {
    return modrinth.searchProjects(params)
  }
  if (platform === 'curseforge') {
    return curseforge.searchProjects(params)
  }
  throw new Error(`Platform "${platform}" is not yet supported`)
}

// ========== 项目详情 ==========

export async function getResourceDetail(
  platform: ResourcePlatform,
  id: string
): Promise<ResourceProject> {
  if (platform === 'modrinth') {
    return modrinth.getProject(id)
  }
  if (platform === 'curseforge') {
    return curseforge.getProject(id)
  }
  throw new Error(`Platform "${platform}" is not yet supported`)
}

// ========== 版本列表 ==========

export async function getResourceVersions(
  platform: ResourcePlatform,
  projectId: string,
  loaders?: string[],
  gameVersions?: string[]
): Promise<ResourceVersion[]> {
  if (platform === 'modrinth') {
    return modrinth.getProjectVersions(projectId, loaders, gameVersions)
  }
  if (platform === 'curseforge') {
    return curseforge.getProjectVersions(projectId, loaders, gameVersions)
  }
  throw new Error(`Platform "${platform}" is not yet supported`)
}

// ========== 安装资源 ==========

export async function installResource(
  file: ResourceFile,
  type: ResourceType,
  gameDir: string,
  projectMeta: { projectId: string; platform: ResourcePlatform; versionId: string; versionNumber: string; title: string }
): Promise<string> {
  const destDir = getResourceDir(gameDir, type)
  await fsp.mkdir(destDir, { recursive: true })

  const destPath = path.join(destDir, file.filename)

  // 下载 (带 SHA1 验证)
  await downloadFile(file.url, destPath, file.sha1)

  // 如果有 SHA512 也验一下 (额外校验)
  // 这里用 SHA1 即可，Modrinth 提供的 SHA1 可靠

  // 写入元数据
  const meta = await readMetadata(gameDir)
  // 更新或追加
  const existing = meta.installed.findIndex(
    r => r.filename === file.filename && r.type === type
  )
  const record: InstalledResource = {
    projectId: projectMeta.projectId,
    platform: projectMeta.platform,
    type,
    versionId: projectMeta.versionId,
    versionNumber: projectMeta.versionNumber,
    filename: file.filename,
    title: projectMeta.title,
    installedAt: Date.now()
  }
  if (existing >= 0) {
    meta.installed[existing] = record
  } else {
    meta.installed.push(record)
  }
  await writeMetadata(gameDir, meta)

  return destPath
}

// ========== 扫描已安装资源 ==========

export async function getInstalledResources(
  type: ResourceType,
  gameDir: string
): Promise<InstalledResource[]> {
  const meta = await readMetadata(gameDir)
  const dir = getResourceDir(gameDir, type)

  // 从元数据中筛选此类型
  const fromMeta = meta.installed.filter(r => r.type === type)

  // 同时扫描目录中实际存在的文件（元数据中没有的也列出来）
  const knownFiles = new Set(fromMeta.map(r => r.filename))
  const result: InstalledResource[] = [...fromMeta]

  try {
    const files = await fsp.readdir(dir)
    for (const f of files) {
      if (knownFiles.has(f)) continue
      // 跳过非文件
      const stat = await fsp.stat(path.join(dir, f))
      if (!stat.isFile()) continue
      // 无元数据的文件 — 以未知状态列出
      result.push({
        projectId: '',
        platform: 'modrinth',
        type,
        versionId: '',
        versionNumber: '',
        filename: f,
        title: f,
        installedAt: Math.floor(stat.mtimeMs)
      })
    }
  } catch {
    // 目录不存在
  }

  return result
}

// ========== 删除资源 ==========

export async function removeResource(
  type: ResourceType,
  gameDir: string,
  filename: string
): Promise<boolean> {
  const filePath = path.join(getResourceDir(gameDir, type), filename)

  // 删除文件
  try {
    await fsp.unlink(filePath)
  } catch {
    // 文件可能已不存在
  }

  // 更新元数据
  const meta = await readMetadata(gameDir)
  meta.installed = meta.installed.filter(
    r => !(r.type === type && r.filename === filename)
  )
  await writeMetadata(gameDir, meta)

  return true
}

// ========== 依赖解析 ==========

export async function resolveDependencies(
  version: ResourceVersion,
  platform: ResourcePlatform
): Promise<{ required: ResourceProject[]; optional: ResourceProject[] }> {
  const required: ResourceProject[] = []
  const optional: ResourceProject[] = []

  for (const dep of version.dependencies) {
    if (dep.dependencyType === 'incompatible' || dep.dependencyType === 'embedded') continue
    try {
      let project: ResourceProject
      if (platform === 'modrinth') {
        project = await modrinth.getProject(dep.projectId)
      } else if (platform === 'curseforge') {
        project = await curseforge.getProject(dep.projectId)
      } else {
        continue
      }
      if (dep.dependencyType === 'required') {
        required.push(project)
      } else if (dep.dependencyType === 'optional') {
        optional.push(project)
      }
    } catch {
      // 依赖项目找不到，跳过
    }
  }

  return { required, optional }
}
