/**
 * Java 运行时下载管理
 * 支持: Adoptium (Temurin), GraalVM, Alibaba Dragonwell (龙井)
 */
import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import { getJavaExecutable } from './platform'
import { getMirrorSource } from './mirror-manager'

const execFileAsync = promisify(execFile)

// ========== 类型 ==========

export interface JavaDistro {
  id: string
  name: string
  description: string
  versions: number[]        // 支持的主版本号
}

export interface JavaDownloadInfo {
  url: string
  filename: string
  version: string
  majorVersion: number
  distro: string
}

export interface JavaDownloadProgress {
  distro: string
  version: number
  status: 'downloading' | 'extracting' | 'done' | 'error'
  percent: number            // 0-100
  message: string
}

// ========== 发行版定义 ==========

export const JAVA_DISTROS: JavaDistro[] = [
  {
    id: 'temurin',
    name: 'Eclipse Temurin',
    description: '最广泛使用的 OpenJDK 发行版，社区首选',
    versions: [8, 17, 21],
  },
  {
    id: 'graalvm',
    name: 'GraalVM CE',
    description: '高性能 JIT 编译器，可提升 MC 帧数',
    versions: [17, 21],
  },
  {
    id: 'dragonwell',
    name: 'Alibaba Dragonwell (龙井)',
    description: '阿里巴巴优化版 JDK，对国内网络友好',
    versions: [8, 11, 17, 21],
  },
]

// ========== HTTP 工具 ==========

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { headers: { 'User-Agent': 'YJN-Launcher/1.0' }, timeout: 30000 }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return fetchJson(res.headers.location!).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(e) }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时: ${url}`)) })
  })
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { headers: { 'User-Agent': 'YJN-Launcher/1.0' }, timeout: 30000 }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return fetchText(res.headers.location!).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => resolve(data))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时: ${url}`)) })
  })
}

function downloadFile(url: string, dest: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { headers: { 'User-Agent': 'YJN-Launcher/1.0' }, timeout: 60000 }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return downloadFile(res.headers.location!, dest, onProgress).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      const ws = createWriteStream(dest)
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total > 0 && onProgress) onProgress(Math.round(received / total * 100))
      })
      pipeline(res, ws).then(resolve, reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`下载超时: ${url}`)) })
  })
}

// ========== 各发行版获取下载 URL ==========

function getOsArch(): { os: string; arch: string; ext: string } {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz'
  return { os, arch, ext }
}

/**
 * ghfast.top 仅支持代理文件下载，不支持 API
 * GitHub API 直连（国内通常可达），仅镜像下载 URL
 */
function mirrorGitHubRelease(url: string): string {
  const source = getMirrorSource()
  if (source === 'official') return url
  return url
    .replace('https://github.com/', 'https://ghfast.top/https://github.com/')
}

/** 已知的 GraalVM CE 最新版本号（API 不可用时的降级方案） */
const GRAALVM_KNOWN_VERSIONS: Record<number, string> = {
  17: '17.0.9',
  21: '21.0.2',
  22: '22.0.1',
}

/** 已知的 Dragonwell 最新版本号 */
const DRAGONWELL_KNOWN_VERSIONS: Record<number, { tag: string; filePrefix: string }> = {
  8:  { tag: 'dragonwell-standard-8.20.21_jdk8u422-ga', filePrefix: 'Alibaba_Dragonwell_Standard_8' },
  11: { tag: 'dragonwell-standard-11.0.24.20_jdk-11.0.24-ga', filePrefix: 'Alibaba_Dragonwell_Standard_11' },
  17: { tag: 'dragonwell-standard-17.0.12.0.13+9_jdk-17.0.12-ga', filePrefix: 'Alibaba_Dragonwell_Standard_17' },
  21: { tag: 'dragonwell-standard-21.0.4.0.4+7_jdk-21.0.4-ga', filePrefix: 'Alibaba_Dragonwell_Standard_21' },
}

async function getTemurinDownload(majorVersion: number): Promise<JavaDownloadInfo> {
  const { os, arch, ext } = getOsArch()
  const source = getMirrorSource()

  if (source !== 'official') {
    // BMCLAPI 代理 Adoptium API
    const apiUrl = `https://bmclapi2.bangbang93.com/adoptium/v3/assets/latest/${majorVersion}/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`
    try {
      const data = await fetchJson(apiUrl) as Array<{ binary: { package: { link: string; name: string } }; version: { openjdk_version: string; major: number } }>
      if (data && data.length > 0) {
        const asset = data[0]
        let dlUrl = asset.binary.package.link
        dlUrl = dlUrl.replace('https://github.com/', 'https://ghfast.top/https://github.com/')
        return { url: dlUrl, filename: asset.binary.package.name, version: asset.version.openjdk_version, majorVersion: asset.version.major, distro: 'temurin' }
      }
    } catch { /* BMCLAPI 代理不可用，尝试清华 */ }

    // 备选：清华镜像目录
    const tsinghuaApiUrl = `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${majorVersion}/jdk/${arch}/${os}/`
    try {
      const html = await fetchText(tsinghuaApiUrl)
      const pattern = ext === 'zip'
        ? /href="(OpenJDK\d+U-jdk_[^"]*\.zip)"/
        : /href="(OpenJDK\d+U-jdk_[^"]*\.tar\.gz)"/
      const match = html.match(pattern)
      if (match) {
        return {
          url: `${tsinghuaApiUrl}${match[1]}`,
          filename: match[1],
          version: `${majorVersion}`,
          majorVersion,
          distro: 'temurin',
        }
      }
    } catch { /* 清华镜像不可用 */ }
  }

  // 官方 API
  const apiUrl = `https://api.adoptium.net/v3/assets/latest/${majorVersion}/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`
  const data = await fetchJson(apiUrl) as Array<{ binary: { package: { link: string; name: string } }; version: { openjdk_version: string; major: number } }>
  if (!data || data.length === 0) throw new Error(`Temurin Java ${majorVersion} 未找到`)
  const asset = data[0]
  return { url: asset.binary.package.link, filename: asset.binary.package.name, version: asset.version.openjdk_version, majorVersion: asset.version.major, distro: 'temurin' }
}

async function getGraalVMDownload(majorVersion: number): Promise<JavaDownloadInfo> {
  const { os, arch } = getOsArch()
  const osName = os === 'windows' ? 'windows' : os === 'mac' ? 'macos' : 'linux'
  const ext = os === 'windows' ? 'zip' : 'tar.gz'

  // 先尝试 GitHub API（直连，国内通常可达）
  try {
    const apiUrl = `https://api.github.com/repos/graalvm/graalvm-ce-builds/releases`
    const releases = await fetchJson(apiUrl) as Array<{ tag_name: string; assets: Array<{ name: string; browser_download_url: string }> }>

    const tag = `jdk-${majorVersion}`
    const release = releases.find(r => r.tag_name.startsWith(tag))
    if (release) {
      const asset = release.assets.find(a =>
        a.name.includes(osName) && a.name.includes(arch) &&
        (a.name.endsWith('.zip') || a.name.endsWith('.tar.gz')) &&
        !a.name.endsWith('.sha256')
      )
      if (asset) {
        return {
          url: mirrorGitHubRelease(asset.browser_download_url),
          filename: asset.name,
          version: release.tag_name,
          majorVersion,
          distro: 'graalvm',
        }
      }
    }
  } catch { /* API 不可用，使用已知版本降级 */ }

  // 降级：用已知版本号直接拼下载 URL
  const ver = GRAALVM_KNOWN_VERSIONS[majorVersion]
  if (!ver) throw new Error(`GraalVM CE Java ${majorVersion} 未找到且无已知版本`)
  const filename = `graalvm-community-jdk-${ver}_${osName}-${arch}_bin.${ext}`
  const url = `https://github.com/graalvm/graalvm-ce-builds/releases/download/jdk-${ver}/${filename}`
  return {
    url: mirrorGitHubRelease(url),
    filename,
    version: `jdk-${ver}`,
    majorVersion,
    distro: 'graalvm',
  }
}

async function getDragonwellDownload(majorVersion: number): Promise<JavaDownloadInfo> {
  const { os, arch } = getOsArch()
  const osName = os === 'windows' ? 'windows' : os === 'mac' ? 'macos' : 'linux'
  const ext = os === 'windows' ? 'zip' : 'tar.gz'

  const repo = `dragonwell-project/dragonwell${majorVersion}`

  // 先尝试 GitHub API
  try {
    const apiUrl = `https://api.github.com/repos/${repo}/releases`
    const releases = await fetchJson(apiUrl) as Array<{ tag_name: string; assets: Array<{ name: string; browser_download_url: string }> }>

    if (releases && releases.length > 0) {
      const release = releases[0]
      const asset = release.assets.find(a => {
        const lower = a.name.toLowerCase()
        return lower.includes(osName) && lower.includes(arch) &&
          (lower.endsWith('.zip') || lower.endsWith('.tar.gz')) &&
          !lower.endsWith('.sha256') && !lower.includes('debuginfo') && !lower.includes('testimage')
      })
      if (asset) {
        return {
          url: mirrorGitHubRelease(asset.browser_download_url),
          filename: asset.name,
          version: release.tag_name,
          majorVersion,
          distro: 'dragonwell',
        }
      }
    }
  } catch { /* API 不可用，使用已知版本降级 */ }

  // 降级：已知版本拼 URL
  const known = DRAGONWELL_KNOWN_VERSIONS[majorVersion]
  if (!known) throw new Error(`Dragonwell Java ${majorVersion} 未找到且无已知版本`)
  const filename = `${known.filePrefix}_${osName}_${arch}.${ext}`
  const url = `https://github.com/${repo}/releases/download/${known.tag}/${filename}`
  return {
    url: mirrorGitHubRelease(url),
    filename,
    version: known.tag,
    majorVersion,
    distro: 'dragonwell',
  }
}

// ========== 下载并安装 ==========

/** 获取 Java 安装目录 */
function getJavaInstallDir(): string {
  return path.join(app.getPath('userData'), 'java-runtimes')
}

export async function getAvailableDownloads(distroId: string, majorVersion: number): Promise<JavaDownloadInfo> {
  switch (distroId) {
    case 'temurin': return getTemurinDownload(majorVersion)
    case 'graalvm': return getGraalVMDownload(majorVersion)
    case 'dragonwell': return getDragonwellDownload(majorVersion)
    default: throw new Error(`未知发行版: ${distroId}`)
  }
}

export async function installJavaRuntime(
  distroId: string,
  majorVersion: number,
  onProgress?: (p: JavaDownloadProgress) => void,
): Promise<string> {
  const installDir = getJavaInstallDir()
  await fsp.mkdir(installDir, { recursive: true })

  const send = (p: Partial<JavaDownloadProgress>) =>
    onProgress?.({ distro: distroId, version: majorVersion, status: 'downloading', percent: 0, message: '', ...p })

  // 1. 获取下载信息
  send({ status: 'downloading', percent: 0, message: '正在获取下载信息...' })
  const info = await getAvailableDownloads(distroId, majorVersion)

  // 2. 下载
  const tmpFile = path.join(installDir, info.filename)
  send({ status: 'downloading', percent: 0, message: `正在下载 ${info.filename}...` })
  await downloadFile(info.url, tmpFile, (percent) => {
    send({ status: 'downloading', percent, message: `正在下载 ${info.filename}... ${percent}%` })
  })

  // 3. 解压
  send({ status: 'extracting', percent: 100, message: '正在解压...' })
  const destDir = path.join(installDir, `${distroId}-${majorVersion}`)

  // 删除旧安装
  if (fs.existsSync(destDir)) {
    await fsp.rm(destDir, { recursive: true, force: true })
  }
  await fsp.mkdir(destDir, { recursive: true })

  if (tmpFile.endsWith('.zip')) {
    // Windows: 用 PowerShell 解压
    await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${tmpFile}' -DestinationPath '${destDir}' -Force`
    ], { timeout: 120000 })
  } else {
    // Linux/Mac: tar
    await execFileAsync('tar', ['xzf', tmpFile, '-C', destDir], { timeout: 120000 })
  }

  // 清理下载文件
  await fsp.unlink(tmpFile).catch(() => {})

  // 4. 查找 java 可执行文件 (解压后通常有一层子目录)
  const javaExe = getJavaExecutable()
  const javaPath = await findJavaInDir(destDir, javaExe)
  if (!javaPath) throw new Error('解压完成但未找到 java 可执行文件')

  send({ status: 'done', percent: 100, message: '安装完成' })
  return javaPath
}

/** 递归查找 java 可执行文件 (限深度 3) */
async function findJavaInDir(dir: string, javaExe: string, depth = 0): Promise<string | null> {
  if (depth > 3) return null
  const binPath = path.join(dir, 'bin', javaExe)
  if (fs.existsSync(binPath)) return binPath

  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) {
        const found = await findJavaInDir(path.join(dir, e.name), javaExe, depth + 1)
        if (found) return found
      }
    }
  } catch { /* ignore */ }
  return null
}

/** 获取已安装的运行时列表 */
export async function getInstalledRuntimes(): Promise<Array<{ distro: string; majorVersion: number; javaPath: string }>> {
  const installDir = getJavaInstallDir()
  if (!fs.existsSync(installDir)) return []

  const results: Array<{ distro: string; majorVersion: number; javaPath: string }> = []
  const javaExe = getJavaExecutable()

  try {
    const entries = await fsp.readdir(installDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const match = e.name.match(/^(temurin|graalvm|dragonwell)-(\d+)$/)
      if (!match) continue

      const jp = await findJavaInDir(path.join(installDir, e.name), javaExe)
      if (jp) {
        results.push({ distro: match[1], majorVersion: parseInt(match[2]), javaPath: jp })
      }
    }
  } catch { /* ignore */ }

  return results
}
