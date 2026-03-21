/**
 * 自动更新模块
 * NSIS 安装版：electron-updater 全流程
 * Portable 便携版：electron-updater 仅检测版本，手动下载 portable exe 并用 bat 脚本热替换
 */

import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { BrowserWindow, shell, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
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
function downloadPortableExe(version: string): Promise<string> {
  const fileName = portableExeName(version)
  const url = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/v${version}/${fileName}`
  const tmpDir = path.join(app.getPath('userData'), 'portable-update')
  fs.mkdirSync(tmpDir, { recursive: true })
  const destPath = path.join(tmpDir, fileName)

  // 清理旧文件
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath)

  return new Promise((resolve, reject) => {
    const download = (downloadUrl: string, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error('下载重定向次数过多'))
        return
      }

      const parsedUrl = new URL(downloadUrl)
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: { 'User-Agent': `YJN-Launcher/${app.getVersion()}` },
        timeout: 30000 // 30 秒连接超时
      }

      const req = https.get(options, (res) => {
        // GitHub 会 302 重定向到 CDN
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          download(res.headers.location, redirects + 1)
          return
        }

        if (res.statusCode !== 200) {
          reject(new Error(`下载失败: HTTP ${res.statusCode}（Release 可能尚未发布）`))
          return
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10)
        let transferred = 0
        let lastReport = 0
        let lastDataTime = Date.now()
        const file = fs.createWriteStream(destPath)

        // 数据传输停滞检测（60 秒无数据则超时）
        const stallTimer = setInterval(() => {
          if (Date.now() - lastDataTime > 60000) {
            clearInterval(stallTimer)
            req.destroy()
            file.close()
            fs.unlink(destPath, () => {})
            reject(new Error('下载超时：60 秒内无数据传输'))
          }
        }, 10000)

        res.on('data', (chunk: Buffer) => {
          transferred += chunk.length
          lastDataTime = Date.now()
          file.write(chunk)

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
        })

        const startTime = Date.now()

        res.on('end', () => {
          clearInterval(stallTimer)
          file.end(() => {
            resolve(destPath)
          })
        })

        res.on('error', (err) => {
          clearInterval(stallTimer)
          file.close()
          fs.unlink(destPath, () => {})
          reject(err)
        })
      })

      req.on('timeout', () => {
        req.destroy()
        reject(new Error('下载连接超时（30秒）'))
      })

      req.on('error', reject)
    }

    download(url)
  })
}

/**
 * Portable 热替换：生成 bat 脚本，等当前进程退出后覆盖 exe 并重启
 */
function portableHotSwap(newExePath: string): void {
  const currentExe = process.execPath
  const currentDir = path.dirname(currentExe)
  const backupExe = currentExe + '.old'
  const batPath = path.join(app.getPath('userData'), 'portable-update', '_update.bat')

  const batContent = `@echo off
chcp 65001 >nul
echo Updating YJN Launcher...
set PID=${process.pid}

:waitloop
tasklist /FI "PID eq %PID%" /NH 2>nul | findstr /B /C:"%PID%" >nul 2>nul
if %errorlevel%==0 (
  timeout /t 1 /nobreak >nul
  goto waitloop
)
REM Double-check with a short delay
timeout /t 2 /nobreak >nul

echo Replacing executable...
if exist "${backupExe}" del /f "${backupExe}"
move /y "${currentExe}" "${backupExe}"
if errorlevel 1 (
  echo ERROR: Failed to move old exe, retrying...
  timeout /t 2 /nobreak >nul
  move /y "${currentExe}" "${backupExe}"
)
copy /y "${newExePath}" "${currentExe}"

echo Starting new version...
start "" "${currentExe}"

timeout /t 3 /nobreak >nul
if exist "${backupExe}" del /f "${backupExe}"
if exist "${newExePath}" del /f "${newExePath}"
del /f "%~f0"
`

  fs.writeFileSync(batPath, batContent, 'utf-8')

  // 启动 bat 脚本（分离子进程，不随主进程退出而终止）
  spawn('cmd.exe', ['/c', batPath], {
    detached: true,
    stdio: 'ignore',
    cwd: currentDir
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
