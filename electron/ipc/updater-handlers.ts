/**
 * 自动更新 IPC 处理器
 */

import { ipcMain } from 'electron'
import { checkForUpdates, downloadUpdate, installUpdate, openReleasePage, isPortable } from '../core/auto-updater'

export function registerUpdaterHandlers() {
  ipcMain.handle('updater:check', async () => {
    await checkForUpdates()
  })

  ipcMain.handle('updater:download', async () => {
    await downloadUpdate()
  })

  ipcMain.handle('updater:install', () => {
    installUpdate()
  })

  ipcMain.handle('updater:openRelease', () => {
    openReleasePage()
  })

  ipcMain.handle('updater:isPortable', () => {
    return isPortable
  })
}
