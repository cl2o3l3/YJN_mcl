/**
 * 安装器 IPC 处理器
 */

import { ipcMain } from 'electron'
import {
  getDefaultInstallDir,
  getDefaultGameDir,
  performInstall,
  selectDirectory,
  type InstallOptions
} from '../core/installer'

/** 确保返回值可被 IPC structured-clone */
function safeReturn<T>(val: T): T {
  return JSON.parse(JSON.stringify(val))
}

export function registerInstallerHandlers() {
  ipcMain.handle('installer:getDefaults', () => {
    try {
      return safeReturn({
        installDir: getDefaultInstallDir(),
        gameDir: getDefaultGameDir()
      })
    } catch (err: any) {
      console.error('[installer:getDefaults]', err)
      return { installDir: '', gameDir: '' }
    }
  })

  ipcMain.handle('installer:selectDir', async (_, defaultPath: string) => {
    try {
      const result = await selectDirectory(defaultPath)
      return result ?? null
    } catch (err: any) {
      console.error('[installer:selectDir]', err)
      return null
    }
  })

  ipcMain.handle('installer:install', async (_, options: InstallOptions) => {
    try {
      console.log('[installer:install] called with', JSON.stringify(options))
      const result = await performInstall(options)
      console.log('[installer:install] result', JSON.stringify(result))
      return safeReturn(result)
    } catch (err: any) {
      console.error('[installer:install] uncaught', err)
      return { success: false, error: String(err?.message || err) }
    }
  })
}
