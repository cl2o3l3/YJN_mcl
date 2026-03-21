/**
 * MC Server Manager
 * 多核心 server.jar 自动下载 + MC Server 启停管理
 * 支持: Vanilla / Paper / Fabric / Forge / NeoForge
 */

import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { net } from 'electron'
import { BrowserWindow } from 'electron'
import { fetchJson, downloadFile } from './download'
import { getMirrorSource } from './mirror-manager'
import { scanSystemJava, selectJava } from './java-manager'

// ========== 类型 ==========

export type ServerCoreType = 'vanilla' | 'paper' | 'fabric' | 'forge' | 'neoforge'

export type McServerStatus = 'idle' | 'downloading' | 'starting' | 'running' | 'stopping'

export interface ServerCoreConfig {
  type: ServerCoreType
  mcVersion: string
  loaderVersion?: string   // Fabric/Forge/NeoForge loader 版本
}

export interface ServerCoreResult {
  jarPath: string
  javaMinVersion: number
}

export interface McServerConfig {
  coreConfig: ServerCoreConfig
  gameDir: string          // 游戏实例目录
  worldName: string        // 存档名称 (saves/ 下的目录名)
  javaPath?: string        // 手动指定 Java 路径
  port?: number            // 服务端口, 不指定则随机
  maxPlayers?: number
  customJarPath?: string   // 手动指定 jar 路径 (跳过下载)
}

// ========== 状态 ==========

let currentServer: {
  process: ChildProcess
  config: McServerConfig
  port: number
  status: McServerStatus
  serverDir: string
} | null = null

// ========== 广播 ==========

function broadcast(channel: string, ...args: unknown[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

function broadcastLog(message: string) {
  broadcast('server:log', message)
}

function broadcastStatus(status: McServerStatus) {
  if (currentServer) currentServer.status = status
  broadcast('server:statusChanged', status)
}

// ========== 工具 ==========

function getRandomPort(): number {
  // 25565 附近的随机端口
  return 25565 + Math.floor(Math.random() * 1000)
}

/** 获取存储核心 jar 的目录 */
function getCoreDir(gameDir: string, config: ServerCoreConfig): string {
  const label = config.loaderVersion
    ? `${config.type}-${config.mcVersion}-${config.loaderVersion}`
    : `${config.type}-${config.mcVersion}`
  return path.join(gameDir, 'server-cores', label)
}

// ========== Vanilla 核心下载 ==========

interface PistonVersion {
  id: string
  type: string
  url: string
  sha1: string
}

interface PistonVersionJson {
  downloads?: {
    server?: { sha1: string; size: number; url: string }
  }
}

async function downloadVanillaCore(mcVersion: string, gameDir: string): Promise<ServerCoreResult> {
  const coreDir = getCoreDir(gameDir, { type: 'vanilla', mcVersion })
  const jarPath = path.join(coreDir, 'server.jar')

  if (fs.existsSync(jarPath)) {
    return { jarPath, javaMinVersion: guessJavaVersion(mcVersion) }
  }

  broadcastLog(`[Vanilla] 正在获取版本信息 ${mcVersion}...`)

  // 从 piston-meta 获取版本列表
  const manifestUrl = getMirrorSource() === 'official'
    ? 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    : 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'

  const manifest = await fetchJson<{ versions: PistonVersion[] }>(manifestUrl)
  const entry = manifest.versions.find(v => v.id === mcVersion)
  if (!entry) throw new Error(`Vanilla 版本 ${mcVersion} 不存在`)

  // 获取版本 JSON
  const versionJson = await fetchJson<PistonVersionJson>(entry.url)
  const serverDl = versionJson.downloads?.server
  if (!serverDl) throw new Error(`Vanilla ${mcVersion} 不提供服务端下载`)

  broadcastLog(`[Vanilla] 正在下载 server.jar (${(serverDl.size / 1024 / 1024).toFixed(1)} MB)...`)
  await fsp.mkdir(coreDir, { recursive: true })
  await downloadFile(serverDl.url, jarPath, serverDl.sha1)
  broadcastLog(`[Vanilla] server.jar 下载完成`)

  return { jarPath, javaMinVersion: guessJavaVersion(mcVersion) }
}

// ========== Paper 核心下载 ==========

interface PaperBuild {
  build: number
  channel: string
  downloads: {
    application: { name: string; sha256: string }
  }
}

async function downloadPaperCore(mcVersion: string, gameDir: string): Promise<ServerCoreResult> {
  const coreDir = getCoreDir(gameDir, { type: 'paper', mcVersion })
  const jarPath = path.join(coreDir, 'paper.jar')

  if (fs.existsSync(jarPath)) {
    return { jarPath, javaMinVersion: guessJavaVersion(mcVersion) }
  }

  broadcastLog(`[Paper] 正在查询最新构建 ${mcVersion}...`)

  // 获取最新 build
  const buildsUrl = `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(mcVersion)}/builds`
  const buildsData = await fetchJson<{ builds: PaperBuild[] }>(buildsUrl)
  if (!buildsData.builds.length) throw new Error(`Paper 没有 ${mcVersion} 的构建`)

  const latest = buildsData.builds[buildsData.builds.length - 1]
  const dl = latest.downloads.application
  const downloadUrl = `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(mcVersion)}/builds/${latest.build}/downloads/${dl.name}`

  broadcastLog(`[Paper] 正在下载 build #${latest.build} (${dl.name})...`)
  await fsp.mkdir(coreDir, { recursive: true })

  // 下载并检查 SHA256
  const resp = await net.fetch(downloadUrl)
  if (!resp.ok) throw new Error(`Paper 下载失败: HTTP ${resp.status}`)
  const buffer = Buffer.from(await resp.arrayBuffer())

  const hash = crypto.createHash('sha256').update(buffer).digest('hex')
  if (hash !== dl.sha256) throw new Error(`Paper SHA256 不匹配: expected ${dl.sha256}, got ${hash}`)

  await fsp.writeFile(jarPath, buffer)
  broadcastLog(`[Paper] paper.jar 下载完成 (build #${latest.build})`)

  return { jarPath, javaMinVersion: guessJavaVersion(mcVersion) }
}

// ========== Fabric Server 核心下载 ==========

async function downloadFabricServerCore(
  mcVersion: string,
  loaderVersion: string,
  gameDir: string
): Promise<ServerCoreResult> {
  const coreDir = getCoreDir(gameDir, { type: 'fabric', mcVersion, loaderVersion })
  const jarPath = path.join(coreDir, 'fabric-server.jar')

  if (fs.existsSync(jarPath)) {
    return { jarPath, javaMinVersion: guessJavaVersion(mcVersion) }
  }

  broadcastLog(`[Fabric Server] 正在下载 loader ${loaderVersion} for MC ${mcVersion}...`)

  // Fabric 提供直接下载 server jar 的端点
  const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/1.0.1/server/jar`

  await fsp.mkdir(coreDir, { recursive: true })
  const resp = await net.fetch(url)
  if (!resp.ok) throw new Error(`Fabric Server 下载失败: HTTP ${resp.status}`)
  const buffer = Buffer.from(await resp.arrayBuffer())
  await fsp.writeFile(jarPath, buffer)

  broadcastLog(`[Fabric Server] fabric-server.jar 下载完成`)
  return { jarPath, javaMinVersion: guessJavaVersion(mcVersion) }
}

// ========== Forge Server 核心安装 ==========

async function downloadForgeServerCore(
  mcVersion: string,
  forgeVersion: string,
  gameDir: string,
  javaPath?: string
): Promise<ServerCoreResult> {
  const coreDir = getCoreDir(gameDir, { type: 'forge', mcVersion, loaderVersion: forgeVersion })

  // 检查是否已安装 (Forge server 会生成多种文件)
  const possibleJars = [
    path.join(coreDir, `forge-${mcVersion}-${forgeVersion}.jar`),
    path.join(coreDir, 'run.bat'),
    path.join(coreDir, 'run.sh'),
  ]
  for (const p of possibleJars) {
    if (fs.existsSync(p)) {
      return { jarPath: p, javaMinVersion: 8 }
    }
  }

  const java = javaPath || await resolveJava(8)

  broadcastLog(`[Forge Server] 正在下载 installer ${mcVersion}-${forgeVersion}...`)
  await fsp.mkdir(coreDir, { recursive: true })

  // 下载 installer
  const fileName = `forge-${mcVersion}-${forgeVersion}-installer.jar`
  const source = getMirrorSource()
  const urls = source === 'bmclapi'
    ? [`https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/${fileName}`,
       `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/${fileName}`]
    : [`https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/${fileName}`,
       `https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/${fileName}`]

  const installerPath = path.join(coreDir, fileName)
  if (!fs.existsSync(installerPath)) {
    let lastError: Error | undefined
    for (const url of urls) {
      try {
        const resp = await net.fetch(url)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const buf = Buffer.from(await resp.arrayBuffer())
        await fsp.writeFile(installerPath, buf)
        lastError = undefined
        break
      } catch (e: any) {
        lastError = new Error(`下载失败: ${e.message}`)
      }
    }
    if (lastError) throw lastError
  }

  // 运行 installer --installServer
  broadcastLog(`[Forge Server] 正在执行 installer --installServer...`)
  await runServerInstaller(java, installerPath, coreDir)
  await fsp.rm(installerPath, { force: true }).catch(() => {})

  // 查找生成的 jar 或 run 脚本
  const jarPath = await findForgeServerJar(coreDir, mcVersion, forgeVersion)
  broadcastLog(`[Forge Server] 安装完成`)
  return { jarPath, javaMinVersion: 8 }
}

// ========== NeoForge Server 核心安装 ==========

async function downloadNeoForgeServerCore(
  mcVersion: string,
  neoforgeVersion: string,
  gameDir: string,
  javaPath?: string
): Promise<ServerCoreResult> {
  const coreDir = getCoreDir(gameDir, { type: 'neoforge', mcVersion, loaderVersion: neoforgeVersion })

  const possibleJars = [
    path.join(coreDir, `neoforge-${neoforgeVersion}.jar`),
    path.join(coreDir, 'run.bat'),
    path.join(coreDir, 'run.sh'),
  ]
  for (const p of possibleJars) {
    if (fs.existsSync(p)) {
      return { jarPath: p, javaMinVersion: 17 }
    }
  }

  const java = javaPath || await resolveJava(17)

  broadcastLog(`[NeoForge Server] 正在下载 installer ${neoforgeVersion}...`)
  await fsp.mkdir(coreDir, { recursive: true })

  const fileName = `neoforge-${neoforgeVersion}-installer.jar`
  const source = getMirrorSource()
  const urls = source === 'bmclapi'
    ? [`https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${neoforgeVersion}/${fileName}`,
       `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoforgeVersion}/${fileName}`]
    : [`https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoforgeVersion}/${fileName}`,
       `https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/${neoforgeVersion}/${fileName}`]

  const installerPath = path.join(coreDir, fileName)
  if (!fs.existsSync(installerPath)) {
    let lastError: Error | undefined
    for (const url of urls) {
      try {
        const resp = await net.fetch(url)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const buf = Buffer.from(await resp.arrayBuffer())
        await fsp.writeFile(installerPath, buf)
        lastError = undefined
        break
      } catch (e: any) {
        lastError = new Error(`下载失败: ${e.message}`)
      }
    }
    if (lastError) throw lastError
  }

  broadcastLog(`[NeoForge Server] 正在执行 installer --installServer...`)
  await runServerInstaller(java, installerPath, coreDir)
  await fsp.rm(installerPath, { force: true }).catch(() => {})

  const jarPath = await findNeoForgeServerJar(coreDir, neoforgeVersion)
  broadcastLog(`[NeoForge Server] 安装完成`)
  return { jarPath, javaMinVersion: 17 }
}

// ========== 统一下载入口 ==========

export async function downloadServerCore(config: ServerCoreConfig, gameDir: string, javaPath?: string): Promise<ServerCoreResult> {
  switch (config.type) {
    case 'vanilla':
      return downloadVanillaCore(config.mcVersion, gameDir)
    case 'paper':
      return downloadPaperCore(config.mcVersion, gameDir)
    case 'fabric':
      if (!config.loaderVersion) throw new Error('Fabric Server 需要指定 loaderVersion')
      return downloadFabricServerCore(config.mcVersion, config.loaderVersion, gameDir)
    case 'forge':
      if (!config.loaderVersion) throw new Error('Forge Server 需要指定 loaderVersion')
      return downloadForgeServerCore(config.mcVersion, config.loaderVersion, gameDir, javaPath)
    case 'neoforge':
      if (!config.loaderVersion) throw new Error('NeoForge Server 需要指定 loaderVersion')
      return downloadNeoForgeServerCore(config.mcVersion, config.loaderVersion, gameDir, javaPath)
  }
}

// ========== MC Server 启停 ==========

export async function startMcServer(config: McServerConfig): Promise<{ port: number }> {
  if (currentServer) {
    throw new Error('已有服务器在运行，请先停止')
  }

  broadcastStatus('downloading')

  // 1. 确定 jar 路径
  let jarPath: string
  let javaMinVersion: number

  if (config.customJarPath) {
    jarPath = config.customJarPath
    javaMinVersion = guessJavaVersion(config.coreConfig.mcVersion)
  } else {
    const result = await downloadServerCore(config.coreConfig, config.gameDir, config.javaPath)
    jarPath = result.jarPath
    javaMinVersion = result.javaMinVersion
  }

  // 2. 准备服务器目录 (在 gameDir 内的 server-run 目录)
  const serverDir = path.join(config.gameDir, 'shared-server')
  await fsp.mkdir(serverDir, { recursive: true })

  // 3. 链接/复制世界存档
  const worldSrc = path.join(config.gameDir, 'saves', config.worldName)
  const worldDst = path.join(serverDir, 'world')
  if (!fs.existsSync(worldSrc)) {
    // 没有存档就让服务器自动创建
    broadcastLog(`[Server] 存档 ${config.worldName} 不存在，服务器将创建新世界`)
  } else {
    // 如果 world 目录已存在且不是同一个存档，先清理
    if (fs.existsSync(worldDst)) {
      await fsp.rm(worldDst, { recursive: true, force: true })
    }
    await copyDir(worldSrc, worldDst)
    broadcastLog(`[Server] 已复制存档 ${config.worldName} 到服务器目录`)
  }

  // 4. 写 eula.txt
  await fsp.writeFile(path.join(serverDir, 'eula.txt'), 'eula=true\n')

  // 5. 写 server.properties
  const port = config.port || getRandomPort()
  const props = [
    `server-port=${port}`,
    'online-mode=false',
    `max-players=${config.maxPlayers || 8}`,
    'enable-command-block=true',
    'spawn-protection=0',
    `level-name=world`,
    'motd=Shared World Server',
  ].join('\n') + '\n'
  await fsp.writeFile(path.join(serverDir, 'server.properties'), props)

  // 6. 写 launcher_profiles.json (Forge/NeoForge 需要)
  const profilesPath = path.join(serverDir, 'launcher_profiles.json')
  if (!fs.existsSync(profilesPath)) {
    await fsp.writeFile(profilesPath, JSON.stringify({ profiles: {} }))
  }

  // 7. 确定 Java
  const java = config.javaPath || await resolveJava(javaMinVersion)

  // 8. 构建启动命令
  let args: string[]
  const ext = path.extname(jarPath).toLowerCase()

  if (ext === '.bat' || ext === '.sh') {
    // Forge/NeoForge 新版生成 run.bat/run.sh
    // 需要从脚本中提取 java 命令或直接执行
    args = ['-jar', jarPath]  // fallback：直接用 jar
    // 查找同目录下的实际 jar
    const dir = path.dirname(jarPath)
    const files = await fsp.readdir(dir)
    const serverJar = files.find(f => f.endsWith('.jar') && !f.includes('installer'))
    if (serverJar) {
      args = ['-jar', path.join(dir, serverJar), 'nogui']
    }
  } else {
    args = ['-jar', jarPath, 'nogui']
  }

  // 9. 启动
  broadcastStatus('starting')
  broadcastLog(`[Server] 正在启动 MC Server (port: ${port})...`)
  broadcastLog(`[Server] Java: ${java}`)
  broadcastLog(`[Server] 启动命令: java ${args.join(' ')}`)

  const child = spawn(java, args, {
    cwd: serverDir,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  currentServer = {
    process: child,
    config,
    port,
    status: 'starting',
    serverDir
  }

  return new Promise((resolve, reject) => {
    let started = false
    const startTimeout = setTimeout(() => {
      if (!started) {
        broadcastLog('[Server] 启动超时 (120s)')
        reject(new Error('MC Server 启动超时'))
      }
    }, 120_000)

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      broadcastLog(text.trimEnd())

      // 检测 "Done (X.XXXs)!" 表示启动完成
      if (!started && text.includes('Done (')) {
        started = true
        clearTimeout(startTimeout)
        broadcastStatus('running')
        broadcastLog(`[Server] ✓ 服务器启动完成 (port: ${port})`)
        resolve({ port })
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      broadcastLog(`[STDERR] ${data.toString().trimEnd()}`)
    })

    child.on('exit', (code) => {
      clearTimeout(startTimeout)
      broadcastLog(`[Server] 进程退出 (code: ${code})`)
      if (!started) {
        reject(new Error(`MC Server 启动失败 (exit code: ${code})`))
      }
      // 退出后同步存档回 saves
      syncWorldBack().catch(() => {})
      currentServer = null
      broadcastStatus('idle')
    })

    child.on('error', (err) => {
      clearTimeout(startTimeout)
      broadcastLog(`[Server] 进程错误: ${err.message}`)
      if (!started) reject(err)
      currentServer = null
      broadcastStatus('idle')
    })
  })
}

export async function stopMcServer(): Promise<void> {
  if (!currentServer) return

  const { process: child } = currentServer
  broadcastStatus('stopping')
  broadcastLog('[Server] 正在停止服务器...')

  // 先发 save-all 确保存盘
  child.stdin?.write('save-all\n')
  await new Promise(r => setTimeout(r, 2000))

  // 发 stop 命令
  child.stdin?.write('stop\n')

  // 等待进程退出，5s 超时则强杀
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      broadcastLog('[Server] 5s 超时，强制终止进程')
      child.kill('SIGKILL')
      resolve()
    }, 5000)

    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })

  broadcastLog('[Server] 服务器已停止')
}

/** 向服务器 stdin 发送命令 */
export function sendServerCommand(command: string): void {
  if (!currentServer || currentServer.status !== 'running') return
  currentServer.process.stdin?.write(command + '\n')
}

/** 获取当前服务器状态 */
export function getServerStatus(): { status: McServerStatus; port: number | null } {
  return {
    status: currentServer?.status ?? 'idle',
    port: currentServer?.port ?? null
  }
}

/** 获取服务器运行目录 */
export function getServerDir(): string | null {
  return currentServer?.serverDir ?? null
}

// ========== 内部工具 ==========

/** 服务器停止后将 world 目录同步回 saves */
async function syncWorldBack(): Promise<void> {
  if (!currentServer) return
  const { config, serverDir } = currentServer
  const worldDst = path.join(serverDir, 'world')
  const saveDst = path.join(config.gameDir, 'saves', config.worldName)

  if (!fs.existsSync(worldDst)) return

  try {
    // 备份原存档
    if (fs.existsSync(saveDst)) {
      await fsp.rm(saveDst, { recursive: true, force: true })
    }
    await copyDir(worldDst, saveDst)
    broadcastLog(`[Server] 已同步世界存档回 saves/${config.worldName}`)
  } catch (e: any) {
    broadcastLog(`[Server] 存档同步失败: ${e.message}`)
  }
}

/** 根据 MC 版本推断最低 Java 版本 */
function guessJavaVersion(mcVersion: string): number {
  const parts = mcVersion.split('.').map(Number)
  const minor = parts[1] || 0
  if (minor >= 21) return 21
  if (minor >= 17) return 17
  if (minor >= 16) return 16
  return 8
}

/** 自动选择 Java */
async function resolveJava(minMajor: number): Promise<string> {
  const javas = await scanSystemJava()
  const selected = selectJava(javas, minMajor)
  if (!selected) throw new Error(`未找到 Java ${minMajor}+，请手动指定`)
  return selected.path
}

/** 执行 installer --installServer */
function runServerInstaller(javaPath: string, installerJar: string, targetDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, [
      '-jar', installerJar,
      '--installServer', targetDir
    ], {
      cwd: targetDir,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    child.stdout?.on('data', (data: Buffer) => {
      broadcastLog(data.toString().trimEnd())
    })
    child.stderr?.on('data', (data: Buffer) => {
      broadcastLog(data.toString().trimEnd())
    })

    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Installer 退出码 ${code}`))
    })
    child.on('error', reject)
  })
}

/** 查找 Forge server 安装后的启动 jar 或脚本 */
async function findForgeServerJar(dir: string, _mcVersion: string, _forgeVersion: string): Promise<string> {
  // 新版 Forge (1.17+) 生成 run.bat / run.sh
  for (const script of ['run.bat', 'run.sh']) {
    const p = path.join(dir, script)
    if (fs.existsSync(p)) return p
  }
  // 旧版直接生成 jar
  const files = await fsp.readdir(dir)
  const jar = files.find(f =>
    f.endsWith('.jar') && !f.includes('installer') &&
    (f.includes('forge') || f.includes('server'))
  )
  if (jar) return path.join(dir, jar)
  throw new Error(`Forge Server 安装后未找到可执行文件 (${dir})`)
}

/** 查找 NeoForge server 安装后的启动 jar */
async function findNeoForgeServerJar(dir: string, _nfVersion: string): Promise<string> {
  for (const script of ['run.bat', 'run.sh']) {
    const p = path.join(dir, script)
    if (fs.existsSync(p)) return p
  }
  const files = await fsp.readdir(dir)
  const jar = files.find(f =>
    f.endsWith('.jar') && !f.includes('installer') &&
    (f.includes('neoforge') || f.includes('server'))
  )
  if (jar) return path.join(dir, jar)
  throw new Error(`NeoForge Server 安装后未找到可执行文件 (${dir})`)
}

/** 递归复制目录 */
async function copyDir(src: string, dst: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath)
    } else {
      await fsp.copyFile(srcPath, dstPath)
    }
  }
}
