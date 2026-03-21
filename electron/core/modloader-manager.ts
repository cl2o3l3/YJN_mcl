import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fetchJson } from './download'
import { getVersionJson } from './version-manager'
import { selectJava, scanSystemJava } from './java-manager'
import { getMirrorSource } from './mirror-manager'
import { BrowserWindow } from 'electron'
import type { ModLoaderInfo } from '../../src/types'

// ========== 类型 ==========

export interface ModLoaderVersion {
  version: string
  stable: boolean
}

export interface ForgeVersionEntry {
  version: string
  mcversion: string
  modified: string
}

// ========== 缓存层 ==========

const CACHE_TTL = 5 * 60 * 1000 // 5 分钟
const cache = new Map<string, { data: unknown; ts: number }>()

function getCached<T>(key: string): T | null {
  const entry = cache.get(key)
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data as T
  cache.delete(key)
  return null
}

function setCache(key: string, data: unknown) {
  cache.set(key, { data, ts: Date.now() })
}

// ========== Fabric ==========

/** 获取 Fabric Loader 版本列表 */
export async function fetchFabricLoaderVersions(mcVersion: string): Promise<ModLoaderVersion[]> {
  const cacheKey = `fabric:${mcVersion}`
  const cached = getCached<ModLoaderVersion[]>(cacheKey)
  if (cached) return cached

  const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`
  const raw = await fetchJson<{ loader: { version: string; stable: boolean } }[]>(url)
  const result = raw.map(e => ({ version: e.loader.version, stable: e.loader.stable }))
  setCache(cacheKey, result)
  return result
}

/** 安装 Fabric Loader — 获取 profile JSON 并写入 versions 目录 */
export async function installFabricLoader(
  mcVersion: string,
  loaderVersion: string,
  gameDir: string
): Promise<string> {
  // 0. 如果已安装，直接返回版本 ID
  const expectedId = `fabric-loader-${loaderVersion}-${mcVersion}`
  const existingJson = path.join(gameDir, 'versions', expectedId, `${expectedId}.json`)
  if (fs.existsSync(existingJson)) return expectedId

  // 1. 确保 vanilla 版本 JSON 存在
  await getVersionJson(mcVersion, gameDir)

  // 2. 获取 Fabric profile JSON
  const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`
  const profileJson = await fetchJson<Record<string, unknown>>(profileUrl)

  const versionId = profileJson.id as string
  const versionDir = path.join(gameDir, 'versions', versionId)
  await fsp.mkdir(versionDir, { recursive: true })
  await fsp.writeFile(
    path.join(versionDir, `${versionId}.json`),
    JSON.stringify(profileJson, null, 2)
  )

  return versionId
}

// ========== Quilt ==========

/** 获取 Quilt Loader 版本列表 */
export async function fetchQuiltLoaderVersions(mcVersion: string): Promise<ModLoaderVersion[]> {
  const cacheKey = `quilt:${mcVersion}`
  const cached = getCached<ModLoaderVersion[]>(cacheKey)
  if (cached) return cached

  const url = `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}`
  const raw = await fetchJson<{ loader: { version: string } }[]>(url)
  // Quilt API 不提供 stable 字段，约定非 beta 为 stable
  const result = raw.map(e => ({
    version: e.loader.version,
    stable: !e.loader.version.includes('beta') && !e.loader.version.includes('alpha')
  }))
  setCache(cacheKey, result)
  return result
}

/** 安装 Quilt Loader */
export async function installQuiltLoader(
  mcVersion: string,
  loaderVersion: string,
  gameDir: string
): Promise<string> {
  // 0. 如果已安装，直接返回版本 ID
  const expectedId = `quilt-loader-${loaderVersion}-${mcVersion}`
  const existingJson = path.join(gameDir, 'versions', expectedId, `${expectedId}.json`)
  if (fs.existsSync(existingJson)) return expectedId

  await getVersionJson(mcVersion, gameDir)

  const profileUrl = `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`
  const profileJson = await fetchJson<Record<string, unknown>>(profileUrl)

  const versionId = profileJson.id as string
  const versionDir = path.join(gameDir, 'versions', versionId)
  await fsp.mkdir(versionDir, { recursive: true })
  await fsp.writeFile(
    path.join(versionDir, `${versionId}.json`),
    JSON.stringify(profileJson, null, 2)
  )

  return versionId
}

// ========== Forge ==========

/** 获取 Forge 版本列表 (通过 BMCLAPI) */
export async function fetchForgeVersions(mcVersion: string): Promise<ForgeVersionEntry[]> {
  const cacheKey = `forge:${mcVersion}`
  const cached = getCached<ForgeVersionEntry[]>(cacheKey)
  if (cached) return cached

  // BMCLAPI 提供 Forge 版本列表 API
  const url = `https://bmclapi2.bangbang93.com/forge/minecraft/${encodeURIComponent(mcVersion)}`
  const raw = await fetchJson<{ version: string; mcversion: string; modified: string }[]>(url)
  const result = raw.map(e => ({
    version: e.version,
    mcversion: e.mcversion,
    modified: e.modified
  }))
  setCache(cacheKey, result)
  return result
}

/** 获取 Forge installer JAR 下载地址列表（按优先级排序，用于 fallback） */
function getForgeInstallerUrls(mcVersion: string, forgeVersion: string): string[] {
  const fileName = `forge-${mcVersion}-${forgeVersion}-installer.jar`
  const official = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/${fileName}`
  const bmclapi = `https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/${fileName}`
  const source = getMirrorSource()
  // 用户选了 BMCLAPI 就先试 BMCLAPI，否则先官方
  return source === 'bmclapi' ? [bmclapi, official] : [official, bmclapi]
}

/** 安装 Forge — 下载 installer.jar 并执行 */
export async function installForgeLoader(
  mcVersion: string,
  forgeVersion: string,
  gameDir: string,
  javaPath?: string
): Promise<string> {
  // 0. 如果已安装，直接返回版本 ID
  try {
    const existing = await findInstalledForgeVersion(mcVersion, forgeVersion, gameDir)
    return existing
  } catch { /* 未找到，继续安装 */ }

  // 1. 确保 vanilla 版本 JSON 存在
  await getVersionJson(mcVersion, gameDir)

  // 2. 确定 Java 路径
  const java = javaPath || await resolveJavaPath(8)

  // 3. 下载 installer（带 fallback）
  const installerUrls = getForgeInstallerUrls(mcVersion, forgeVersion)
  const tmpDir = path.join(gameDir, '.mc-launcher-tmp')
  await fsp.mkdir(tmpDir, { recursive: true })
  const installerPath = path.join(tmpDir, `forge-${mcVersion}-${forgeVersion}-installer.jar`)

  if (!fs.existsSync(installerPath)) {
    const { net } = await import('electron')
    let lastError: Error | undefined
    for (const url of installerUrls) {
      try {
        const resp = await net.fetch(url)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const buffer = Buffer.from(await resp.arrayBuffer())
        await fsp.writeFile(installerPath, buffer)
        lastError = undefined
        break
      } catch (e: any) {
        lastError = new Error(`下载 Forge 安装器失败: ${e.message} ${url}`)
      }
    }
    if (lastError) throw lastError
  }

  // 4. 执行 installer
  await runJarInstaller(java, installerPath, gameDir)

  // 5. 查找生成的版本 ID
  const versionId = await findInstalledForgeVersion(mcVersion, forgeVersion, gameDir)

  // 6. 清理 installer
  await fsp.rm(installerPath, { force: true }).catch(() => {})

  return versionId
}

// ========== NeoForge ==========

/** 获取 NeoForge 版本列表 */
export async function fetchNeoForgeVersions(mcVersion: string): Promise<ModLoaderVersion[]> {
  const cacheKey = `neoforge:${mcVersion}`
  const cached = getCached<ModLoaderVersion[]>(cacheKey)
  if (cached) return cached

  // NeoForge 使用 Maven metadata — BMCLAPI 也代理了
  // 先从 meta API 获取所有版本，然后按 MC 版本过滤
  const url = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'
  try {
    const raw = await fetchJson<{ versions: string[] }>(url)
    // NeoForge 版本号格式: 20.4.xxx (对应 MC 1.20.4) 或 21.1.xxx (对应 MC 1.21.1)
    // MC 1.20.1 用的是旧版 neoforge 包名，版本号 47.1.xxx
    const mcMajorMinor = parseMcMajorMinor(mcVersion)
    const filtered = raw.versions
      .filter(v => neoforgeMatchesMcVersion(v, mcMajorMinor))
      .reverse() // 最新版在前
      .map(v => ({ version: v, stable: !v.includes('beta') && !v.includes('alpha') }))
    setCache(cacheKey, filtered)
    return filtered
  } catch {
    return []
  }
}

/** 获取 NeoForge installer 下载地址列表 */
function getNeoForgeInstallerUrls(neoforgeVersion: string): string[] {
  const fileName = `neoforge-${neoforgeVersion}-installer.jar`
  const official = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoforgeVersion}/${fileName}`
  const bmclapi = `https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${neoforgeVersion}/${fileName}`
  const source = getMirrorSource()
  return source === 'bmclapi' ? [bmclapi, official] : [official, bmclapi]
}

/** 安装 NeoForge */
export async function installNeoForgeLoader(
  mcVersion: string,
  neoforgeVersion: string,
  gameDir: string,
  javaPath?: string
): Promise<string> {
  // 0. 如果已安装，直接返回版本 ID
  try {
    const existing = await findInstalledNeoForgeVersion(neoforgeVersion, gameDir)
    return existing
  } catch { /* 未找到，继续安装 */ }

  await getVersionJson(mcVersion, gameDir)

  const java = javaPath || await resolveJavaPath(17)

  const installerUrls = getNeoForgeInstallerUrls(neoforgeVersion)
  const tmpDir = path.join(gameDir, '.mc-launcher-tmp')
  await fsp.mkdir(tmpDir, { recursive: true })
  const installerPath = path.join(tmpDir, `neoforge-${neoforgeVersion}-installer.jar`)

  if (!fs.existsSync(installerPath)) {
    const { net } = await import('electron')
    let lastError: Error | undefined
    for (const url of installerUrls) {
      try {
        const resp = await net.fetch(url)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const buffer = Buffer.from(await resp.arrayBuffer())
        await fsp.writeFile(installerPath, buffer)
        lastError = undefined
        break
      } catch (e: any) {
        lastError = new Error(`下载 NeoForge 安装器失败: ${e.message} ${url}`)
      }
    }
    if (lastError) throw lastError
  }

  await runJarInstaller(java, installerPath, gameDir)

  // NeoForge 版本 ID 格式: neoforge-{version}
  const versionId = await findInstalledNeoForgeVersion(neoforgeVersion, gameDir)

  await fsp.rm(installerPath, { force: true }).catch(() => {})

  return versionId
}

// ========== 统一安装入口 ==========

export async function installModLoader(
  info: ModLoaderInfo,
  mcVersion: string,
  gameDir: string,
  javaPath?: string
): Promise<string> {
  switch (info.type) {
    case 'fabric':
      return installFabricLoader(mcVersion, info.version, gameDir)
    case 'quilt':
      return installQuiltLoader(mcVersion, info.version, gameDir)
    case 'forge':
      return installForgeLoader(mcVersion, info.version, gameDir, javaPath)
    case 'neoforge':
      return installNeoForgeLoader(mcVersion, info.version, gameDir, javaPath)
  }
}

// ========== 实用函数 ==========

/** 向所有窗口广播安装进度 */
function sendInstallerProgress(message: string) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('modloader:installerLog', message)
  }
}

/** 运行 installer.jar --installClient（带重试） */
async function runJarInstaller(javaPath: string, installerJar: string, gameDir: string, maxRetries = 2): Promise<void> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await runJarInstallerOnce(javaPath, installerJar, gameDir)
      return
    } catch (e: any) {
      lastError = e
      if (attempt < maxRetries) {
        sendInstallerProgress(`安装失败，正在重试 (${attempt + 1}/${maxRetries})...`)
        await new Promise(r => setTimeout(r, 2000))
      }
    }
  }
  throw lastError!
}

function runJarInstallerOnce(javaPath: string, installerJar: string, gameDir: string): Promise<void> {
  // Forge/NeoForge installer 要求 launcher_profiles.json 存在
  const profilesPath = path.join(gameDir, 'launcher_profiles.json')
  if (!fs.existsSync(profilesPath)) {
    fs.writeFileSync(profilesPath, JSON.stringify({ profiles: {}, selectedProfile: '' }, null, 2))
  }

  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, [
      '-jar', installerJar,
      '--installClient', gameDir
    ], {
      cwd: gameDir,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const logs: string[] = []
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      logs.push(text)
      sendInstallerProgress(text.trim())
    })
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      logs.push(text)
      sendInstallerProgress(text.trim())
    })

    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Installer 退出码 ${code}\n${logs.join('')}`))
      }
    })

    child.on('error', reject)
  })
}

/** 自动选择 Java */
async function resolveJavaPath(minMajor: number): Promise<string> {
  const javas = await scanSystemJava()
  const selected = selectJava(javas, minMajor)
  if (!selected) throw new Error(`未找到 Java ${minMajor}+，请在实例设置中手动指定`)
  return selected.path
}

/** 解析 MC 版本号的主次版本 (1.20.4 → "20.4") */
function parseMcMajorMinor(mcVersion: string): string {
  const parts = mcVersion.split('.')
  if (parts.length >= 3) return `${parts[1]}.${parts[2]}`
  if (parts.length === 2) return `${parts[1]}.0`
  return mcVersion
}

/** 判断 NeoForge 版本号是否匹配 MC 版本 */
function neoforgeMatchesMcVersion(nfVersion: string, mcMajorMinor: string): boolean {
  // NeoForge 版本号格式: {mcMajor}.{mcMinor}.{patch}
  // 例如 MC 1.21.1 → NeoForge 21.1.x
  return nfVersion.startsWith(mcMajorMinor + '.')
}

/** 查找 Forge 安装后生成的版本目录 */
async function findInstalledForgeVersion(
  mcVersion: string,
  forgeVersion: string,
  gameDir: string
): Promise<string> {
  const versionsDir = path.join(gameDir, 'versions')
  // Forge 版本 ID 常见格式
  const candidates = [
    `${mcVersion}-forge-${forgeVersion}`,
    `${mcVersion}-forge-${mcVersion}-${forgeVersion}`,
    `${mcVersion}-Forge-${forgeVersion}`,
    `forge-${mcVersion}-${forgeVersion}`,
    `Forge-${mcVersion}-${forgeVersion}`,
  ]

  for (const id of candidates) {
    const jsonPath = path.join(versionsDir, id, `${id}.json`)
    if (fs.existsSync(jsonPath)) return id
  }

  // 扫描目录查找
  if (fs.existsSync(versionsDir)) {
    const dirs = await fsp.readdir(versionsDir, { withFileTypes: true })
    for (const d of dirs) {
      if (d.isDirectory() && d.name.includes('forge') && d.name.includes(forgeVersion)) {
        const jsonPath = path.join(versionsDir, d.name, `${d.name}.json`)
        if (fs.existsSync(jsonPath)) return d.name
      }
    }
  }

  throw new Error(`Forge 安装完成但未找到版本目录 (${mcVersion}-forge-${forgeVersion})`)
}

/** 查找 NeoForge 安装后生成的版本目录 */
async function findInstalledNeoForgeVersion(
  neoforgeVersion: string,
  gameDir: string
): Promise<string> {
  const versionsDir = path.join(gameDir, 'versions')
  const candidates = [
    `neoforge-${neoforgeVersion}`,
    `NeoForge-${neoforgeVersion}`,
    `1.${neoforgeVersion.replace('.', '.')}-neoforge-${neoforgeVersion}`,
  ]

  for (const id of candidates) {
    const jsonPath = path.join(versionsDir, id, `${id}.json`)
    if (fs.existsSync(jsonPath)) return id
  }

  if (fs.existsSync(versionsDir)) {
    const dirs = await fsp.readdir(versionsDir, { withFileTypes: true })
    for (const d of dirs) {
      if (d.isDirectory() && d.name.includes('neoforge') && d.name.includes(neoforgeVersion)) {
        const jsonPath = path.join(versionsDir, d.name, `${d.name}.json`)
        if (fs.existsSync(jsonPath)) return d.name
      }
    }
  }

  throw new Error(`NeoForge 安装完成但未找到版本目录 (neoforge-${neoforgeVersion})`)
}
