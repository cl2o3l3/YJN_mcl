/**
 * 首次运行安装器
 * 负责将 exe 复制到目标目录、创建快捷方式等
 */

import { app, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

const PRODUCT_NAME = 'YJN'

export interface InstallOptions {
  installDir: string           // 安装目标目录
  createDesktopShortcut: boolean
  createStartMenuShortcut: boolean
  gameDir: string              // .minecraft 目录
}

export interface InstallResult {
  success: boolean
  error?: string
  installedExePath?: string
}

/** 获取当前 exe 路径 */
export function getCurrentExePath(): string {
  return process.execPath
}

/** 获取默认安装目录 */
export function getDefaultInstallDir(): string {
  return path.join(app.getPath('appData'), PRODUCT_NAME)
}

/** 获取默认 .minecraft 目录 */
export function getDefaultGameDir(): string {
  return path.join(app.getPath('appData'), '.minecraft')
}

/** 检查是否从安装目录运行（已安装） */
export function isInstalledRun(): boolean {
  const expectedDir = getDefaultInstallDir()
  const currentDir = path.dirname(getCurrentExePath())
  return currentDir.toLowerCase() === expectedDir.toLowerCase()
}

/** 执行安装 */
export async function performInstall(options: InstallOptions): Promise<InstallResult> {
  try {
    const currentExe = getCurrentExePath()
    const exeName = path.basename(currentExe)
    const targetDir = options.installDir
    const targetExe = path.join(targetDir, exeName)

    // 1. 创建安装目录
    fs.mkdirSync(targetDir, { recursive: true })

    // 2. 如果不是从目标目录运行，复制 exe（dev 模式跳过）
    const isDev = !app.isPackaged
    if (!isDev && currentExe.toLowerCase() !== targetExe.toLowerCase()) {
      fs.copyFileSync(currentExe, targetExe)
    }

    // 3. 创建 .minecraft 目录
    if (options.gameDir) {
      fs.mkdirSync(options.gameDir, { recursive: true })
    }

    // 4. 创建快捷方式（Windows，仅打包模式）
    if (process.platform === 'win32' && !isDev) {
      if (options.createDesktopShortcut) {
        await createShortcut(
          targetExe,
          path.join(app.getPath('desktop'), `${PRODUCT_NAME}.lnk`),
          targetDir
        )
      }
      if (options.createStartMenuShortcut) {
        const startMenuDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', PRODUCT_NAME)
        fs.mkdirSync(startMenuDir, { recursive: true })
        await createShortcut(
          targetExe,
          path.join(startMenuDir, `${PRODUCT_NAME}.lnk`),
          targetDir
        )
      }
    }

    return { success: true, installedExePath: targetExe }
  } catch (err: any) {
    // 确保返回纯 JSON 可序列化的对象（Node 系统错误包含不可序列化属性）
    return { success: false, error: String(err?.message || err) }
  }
}

/** 使用 PowerShell 创建 Windows 快捷方式 */
async function createShortcut(targetPath: string, linkPath: string, workingDir: string): Promise<void> {
  if (process.platform !== 'win32') return

  const { execSync } = await import('child_process')

  // 转义 PowerShell 字符串中的单引号
  const esc = (s: string) => s.replace(/'/g, "''")

  const ps = `
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut('${esc(linkPath)}')
    $sc.TargetPath = '${esc(targetPath)}'
    $sc.WorkingDirectory = '${esc(workingDir)}'
    $sc.Description = '${PRODUCT_NAME} Minecraft Launcher'
    $sc.Save()
  `.trim()

  execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
    windowsHide: true,
    timeout: 10000
  })
}

/** 打开文件夹选择对话框 */
export async function selectDirectory(defaultPath: string): Promise<string | null> {
  const { dialog } = await import('electron')
  const result = await dialog.showOpenDialog({
    defaultPath,
    properties: ['openDirectory', 'createDirectory']
  })
  return result.canceled ? null : (result.filePaths[0] || null)
}

/** 打开安装目录 */
export function openInstallDir(dir: string): void {
  shell.openPath(dir)
}
