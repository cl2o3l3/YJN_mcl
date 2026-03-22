/**
 * 自动更新模块
 * NSIS 安装版：electron-updater 全流程
 * Portable 便携版：electron-updater 仅检测版本，手动下载 portable exe 并用 bat 脚本热替换
 */

import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { BrowserWindow, shell, app, net } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { spawn } from 'child_process'

// electron-updater 日志走 console
autoUpdater.logger = console

// 不自动下载，让用户确认
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = !isPortableMode()

/** 检测是否以 portable 方式运行 */
function isPortableMode(): boolean {
  return !!process.env.PORTABLE_EXECUTABLE_DIR
}
export const isPortable = isPortableMode()

/** GitHub 仓库信息（与 electron-builder.json5 中 publish 一致） */
const GH_OWNER = 'cl2o3l3'
const GH_REPO = 'YJN_mcl'

export interface UpdateStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  releaseNotes?: string
  progress?: { percent: number; bytesPerSecond: number; transferred: number; total: number }
  error?: string
  isPortable?: boolean
}

/** 当前发现的新版本号，portable 下载时用 */
let pendingVersion = ''
/** portable 下载后的临时文件路径 */
let portableDownloadedPath = ''
const PORTABLE_DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000
const PORTABLE_DOWNLOAD_STALL_TIMEOUT_MS = 60_000
const PORTABLE_DOWNLOAD_MAX_RETRIES = 3

function broadcast(channel: string, ...args: any[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

function sendStatus(status: UpdateStatus) {
  broadcast('updater:status', status)
}

// ---- 事件绑定 ----

autoUpdater.on('checking-for-update', () => {
  sendStatus({ status: 'checking' })
})

autoUpdater.on('update-available', (info: UpdateInfo) => {
  let notes: string | undefined
  if (typeof info.releaseNotes === 'string') {
    notes = info.releaseNotes
  } else if (Array.isArray(info.releaseNotes)) {
    notes = info.releaseNotes.map(n => typeof n === 'string' ? n : n.note).filter(Boolean).join('\n')
  }
  pendingVersion = info.version
  sendStatus({
    status: 'available',
    version: info.version,
    releaseNotes: notes,
    isPortable
  })
})

autoUpdater.on('update-not-available', () => {
  sendStatus({ status: 'not-available' })
})

// NSIS 模式的下载进度和完成事件（portable 不走这些）
autoUpdater.on('download-progress', (prog: ProgressInfo) => {
  if (!isPortable) {
    sendStatus({
      status: 'downloading',
      progress: {
        percent: prog.percent,
        bytesPerSecond: prog.bytesPerSecond,
        transferred: prog.transferred,
        total: prog.total
      }
    })
  }
})

autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
  if (!isPortable) {
    sendStatus({
      status: 'downloaded',
      version: info.version,
      isPortable: false
    })
  }
})

autoUpdater.on('error', (err: Error) => {
  sendStatus({ status: 'error', error: err.message })
})

// ---- Portable 专用：手动下载新版 exe ----

/**
 * 根据 electron-builder 的 artifactName 模板推算 portable exe 名称
 * 模板: ${productName}-${version}-${arch}.${ext} → YJN-1.0.1-x64.exe
 */
function portableExeName(version: string): string {
  return `YJN-${version}-x64.exe`
}

/** 从 GitHub Release 下载 portable exe */
async function downloadPortableExe(version: string): Promise<string> {
  const fileName = portableExeName(version)
  const url = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/v${version}/${fileName}`
  const tmpDir = path.join(app.getPath('userData'), 'portable-update')
  fs.mkdirSync(tmpDir, { recursive: true })
  const destPath = path.join(tmpDir, fileName)

  // 清理旧文件
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath)

  let lastError: unknown = null

  for (let attempt = 1; attempt <= PORTABLE_DOWNLOAD_MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const connectTimer = setTimeout(() => controller.abort(), PORTABLE_DOWNLOAD_CONNECT_TIMEOUT_MS)
    let stallTimer: ReturnType<typeof setInterval> | null = null
    let file: fs.WriteStream | null = null

    try {
      const res = await net.fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': `YJN-Launcher/${app.getVersion()}` },
        redirect: 'follow',
        signal: controller.signal,
      })

      clearTimeout(connectTimer)

      if (!res.ok) {
        throw new Error(`下载失败: HTTP ${res.status}（Release 可能尚未发布）`)
      }

      if (!res.body) {
        throw new Error('下载失败：响应体为空')
      }

      const totalBytes = parseInt(res.headers.get('content-length') || '0', 10)
      let transferred = 0
      let lastReport = 0
      let lastDataTime = Date.now()
      const startTime = Date.now()
      const reader = res.body.getReader()
      file = fs.createWriteStream(destPath)

      stallTimer = setInterval(() => {
        if (Date.now() - lastDataTime > PORTABLE_DOWNLOAD_STALL_TIMEOUT_MS) {
          controller.abort()
        }
      }, 10_000)

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue

        transferred += value.length
        lastDataTime = Date.now()

        if (!file.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => file!.once('drain', resolve))
        }

        const now = Date.now()
        if (now - lastReport > 200 || transferred === totalBytes) {
          lastReport = now
          const elapsed = Math.max(1, (now - startTime) / 1000)
          sendStatus({
            status: 'downloading',
            progress: {
              percent: totalBytes > 0 ? (transferred / totalBytes) * 100 : 0,
              bytesPerSecond: transferred / elapsed,
              transferred,
              total: totalBytes
            }
          })
        }
      }

      clearInterval(stallTimer)
      await new Promise<void>((resolve, reject) => {
        file!.end((err?: Error | null) => err ? reject(err) : resolve())
      })
      return destPath
    } catch (err: any) {
      lastError = err
      clearTimeout(connectTimer)
      if (stallTimer) clearInterval(stallTimer)
      try { file?.destroy() } catch { /* ignore */ }
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath)

      if (attempt >= PORTABLE_DOWNLOAD_MAX_RETRIES) break

      await new Promise(resolve => setTimeout(resolve, attempt * 1500))
    } finally {
      clearTimeout(connectTimer)
      if (stallTimer) clearInterval(stallTimer)
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError)
  if (msg.includes('aborted')) {
    throw new Error('下载超时：连接过慢或 60 秒内无数据传输')
  }
  throw new Error(msg || '下载失败')
}

/**
 * Portable 热替换：生成 PowerShell 脚本，等当前进程退出后覆盖 exe 并重启
 * 使用 PowerShell -WindowStyle Hidden 避免弹出可见终端窗口
 */
function portableHotSwap(newExePath: string): void {
  const currentExe = process.execPath
  const backupExe = currentExe + '.old'
  const ps1Path = path.join(app.getPath('userData'), 'portable-update', '_update.ps1')

  // PowerShell 单引号字符串中，单引号用两个单引号转义
  const esc = (s: string) => s.replace(/'/g, "''")

  const ps1Content = `$ErrorActionPreference = 'Stop'
$pid = ${process.pid}
$currentExe = '${esc(currentExe)}'
$backupExe = '${esc(backupExe)}'
$newExe = '${esc(newExePath)}'

# Wait for old process to exit
while ($true) {
  try {
    Get-Process -Id $pid -ErrorAction Stop | Out-Null
    Start-Sleep -Milliseconds 500
  } catch {
    break
  }
}
Start-Sleep -Seconds 2

# Replace exe
if (Test-Path $backupExe) { Remove-Item $backupExe -Force }
Move-Item $currentExe $backupExe -Force
Copy-Item $newExe $currentExe -Force

# Start new version
Start-Process $currentExe

# Cleanup
Start-Sleep -Seconds 3
if (Test-Path $backupExe) { Remove-Item $backupExe -Force -ErrorAction SilentlyContinue }
if (Test-Path $newExe) { Remove-Item $newExe -Force -ErrorAction SilentlyContinue }

# Self-delete
Remove-Item $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`

  fs.writeFileSync(ps1Path, ps1Content, 'utf-8')

  // 启动 PowerShell 脚本（隐藏窗口，分离子进程）
  spawn('powershell.exe', ['-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1Path], {
    detached: true,
    stdio: 'ignore',
  }).unref()

  // 强制退出应用（跳过 before-quit / close 事件防止被拦截）
  app.exit(0)
}

// ---- 对外 API ----

export async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (err: any) {
    sendStatus({ status: 'error', error: err.message })
  }
}

export async function downloadUpdate(): Promise<void> {
  if (isPortable) {
    // Portable：手动从 GitHub Release 下载 portable exe
    if (!pendingVersion) {
      sendStatus({ status: 'error', error: '未检测到新版本' })
      return
    }
    try {
      sendStatus({ status: 'downloading', progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 } })
      portableDownloadedPath = await downloadPortableExe(pendingVersion)
      sendStatus({ status: 'downloaded', version: pendingVersion, isPortable: true })
    } catch (err: any) {
      sendStatus({ status: 'error', error: `下载 Portable 更新失败: ${err.message}` })
    }
  } else {
    // NSIS：electron-updater 下载安装包
    try {
      await autoUpdater.downloadUpdate()
    } catch (err: any) {
      sendStatus({ status: 'error', error: err.message })
    }
  }
}

export function installUpdate(): void {
  if (isPortable) {
    if (!portableDownloadedPath || !fs.existsSync(portableDownloadedPath)) {
      sendStatus({ status: 'error', error: '更新文件不存在，请重新下载' })
      return
    }
    portableHotSwap(portableDownloadedPath)
  } else {
    autoUpdater.quitAndInstall(false, true)
  }
}

/** 打开 GitHub Release 页面 */
export function openReleasePage(): void {
  shell.openExternal(`https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest`)
}
