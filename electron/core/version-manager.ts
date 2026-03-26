import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import type { VersionManifest, VersionManifestEntry, VersionJson } from '../../src/types'
import { getVersionManifestUrl, mirrorVersionJsonUrl } from './mirror-manager'
import { fetchJson, downloadFile } from './download'
import { getDefaultMinecraftDir } from './platform'

let cachedManifest: VersionManifest | null = null

function getStandardVersionPaths(gameDir: string, versionId: string) {
  const versionDir = path.join(gameDir, 'versions', versionId)
  return {
    versionDir,
    jsonPath: path.join(versionDir, `${versionId}.json`),
    jarPath: path.join(versionDir, `${versionId}.jar`),
    nativesDir: path.join(versionDir, 'natives')
  }
}

function getEmbeddedVersionPaths(gameDir: string, versionId: string) {
  return {
    versionDir: gameDir,
    jsonPath: path.join(gameDir, `${versionId}.json`),
    jarPath: path.join(gameDir, `${versionId}.jar`),
    nativesDir: path.join(gameDir, 'natives', versionId)
  }
}

export function hasEmbeddedVersionLayout(gameDir: string, versionId: string): boolean {
  const embedded = getEmbeddedVersionPaths(gameDir, versionId)
  return fs.existsSync(embedded.jsonPath) || fs.existsSync(embedded.jarPath)
}

export function getVersionPaths(gameDir: string, versionId: string) {
  return hasEmbeddedVersionLayout(gameDir, versionId)
    ? getEmbeddedVersionPaths(gameDir, versionId)
    : getStandardVersionPaths(gameDir, versionId)
}

export function hasLocalVersion(gameDir: string, versionId: string): boolean {
  const { jsonPath } = getVersionPaths(gameDir, versionId)
  return fs.existsSync(jsonPath)
}

/** 获取版本清单 (带本地缓存) */
export async function getVersionManifest(forceRefresh = false): Promise<VersionManifest> {
  const cacheFile = path.join(getDefaultMinecraftDir(), 'version_manifest_v2.json')

  if (!forceRefresh && cachedManifest) return cachedManifest

  try {
    const manifest = await fetchJson<VersionManifest>(getVersionManifestUrl())
    cachedManifest = manifest
    // 写缓存 (后台)
    fsp.mkdir(path.dirname(cacheFile), { recursive: true })
      .then(() => fsp.writeFile(cacheFile, JSON.stringify(manifest)))
      .catch(() => { /* 忽略缓存写入失败 */ })
    return manifest
  } catch {
    // 网络失败, 读本地缓存
    if (fs.existsSync(cacheFile)) {
      const data = await fsp.readFile(cacheFile, 'utf-8')
      cachedManifest = JSON.parse(data)
      return cachedManifest!
    }
    throw new Error('无法获取版本列表,且无本地缓存')
  }
}

/** 获取版本清单中的版本列表 */
export async function getVersionList(type?: 'release' | 'snapshot'): Promise<VersionManifestEntry[]> {
  const manifest = await getVersionManifest()
  if (type) return manifest.versions.filter(v => v.type === type)
  return manifest.versions
}

/** 获取并解析版本 JSON (支持 inheritsFrom 合并) */
export async function getVersionJson(versionId: string, gameDir: string): Promise<VersionJson> {
  const standardPaths = getStandardVersionPaths(gameDir, versionId)
  const localPaths = getVersionPaths(gameDir, versionId)

  let json: VersionJson

  if (fs.existsSync(localPaths.jsonPath)) {
    json = JSON.parse(await fsp.readFile(localPaths.jsonPath, 'utf-8'))
  } else {
    // 从清单查找 URL
    const manifest = await getVersionManifest()
    const entry = manifest.versions.find(v => v.id === versionId)
    if (!entry) {
      // 可能是 mod 加载器版本, 直接抛出
      throw new Error(`版本 ${versionId} 未在清单中找到,且本地不存在`)
    }
    const url = mirrorVersionJsonUrl(entry.url)
    await downloadFile(url, standardPaths.jsonPath, entry.sha1)
    json = JSON.parse(await fsp.readFile(standardPaths.jsonPath, 'utf-8'))
  }

  // 处理 inheritsFrom (Fabric/Forge 等 mod 加载器)
  if (json.inheritsFrom) {
    const parentJson = await getVersionJson(json.inheritsFrom, gameDir)
    return mergeVersionJson(parentJson, json)
  }

  return json
}

/** 合并子版本 JSON 到父版本 (Mod 加载器专用) */
function mergeVersionJson(parent: VersionJson, child: VersionJson): VersionJson {
  const merged: VersionJson = { ...parent, ...child }

  // 合并 libraries (子版本优先)
  merged.libraries = [...(child.libraries || []), ...(parent.libraries || [])]

  // 合并 arguments
  if (parent.arguments && child.arguments) {
    merged.arguments = {
      game: [...(parent.arguments.game || []), ...(child.arguments.game || [])],
      jvm: [...(parent.arguments.jvm || []), ...(child.arguments.jvm || [])]
    }
  }

  // 保留父版本的 downloads / assetIndex (子版本一般不提供)
  if (!child.downloads) merged.downloads = parent.downloads
  if (!child.assetIndex) merged.assetIndex = parent.assetIndex
  if (!child.assets) merged.assets = parent.assets

  return merged
}

/** 获取本地已安装的版本列表 */
export async function getLocalVersions(gameDir: string): Promise<string[]> {
  const versions = new Set<string>()
  const versionsDir = path.join(gameDir, 'versions')

  if (fs.existsSync(versionsDir)) {
    const dirs = await fsp.readdir(versionsDir, { withFileTypes: true })
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const jsonFile = path.join(versionsDir, d.name, `${d.name}.json`)
      if (fs.existsSync(jsonFile)) versions.add(d.name)
    }
  }

  if (fs.existsSync(gameDir)) {
    const entries = await fsp.readdir(gameDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const versionId = entry.name.slice(0, -5)
      if (!versionId) continue
      const siblingJar = path.join(gameDir, `${versionId}.jar`)
      if (fs.existsSync(siblingJar)) versions.add(versionId)
    }
  }

  return [...versions]
}
