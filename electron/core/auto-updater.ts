/**
 * 自动更新模块
 * 使用 electron-updater 从 GitHub Releases 检查并下载更新
 */

import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { BrowserWindow } from 'electron'

// electron-updater 日志走 console
autoUpdater.logger = console

// 不自动下载，让用户确认
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

export interface UpdateStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  releaseNotes?: string
  progress?: { percent: number; bytesPerSecond: number; transferred: number; total: number }
  error?: string
}

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
  sendStatus({
    status: 'available',
    version: info.version,
    releaseNotes: notes
  })
})

autoUpdater.on('update-not-available', () => {
  sendStatus({ status: 'not-available' })
})

autoUpdater.on('download-progress', (prog: ProgressInfo) => {
  sendStatus({
    status: 'downloading',
    progress: {
      percent: prog.percent,
      bytesPerSecond: prog.bytesPerSecond,
      transferred: prog.transferred,
      total: prog.total
    }
  })
})

autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
  sendStatus({
    status: 'downloaded',
    version: info.version
  })
})

autoUpdater.on('error', (err: Error) => {
  sendStatus({ status: 'error', error: err.message })
})

// ---- 对外 API ----

export async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (err: any) {
    sendStatus({ status: 'error', error: err.message })
  }
}

export async function downloadUpdate(): Promise<void> {
  try {
    await autoUpdater.downloadUpdate()
  } catch (err: any) {
    sendStatus({ status: 'error', error: err.message })
  }
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}
