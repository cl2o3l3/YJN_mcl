import { app, BrowserWindow, session, protocol, net } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { registerIpcHandlers } from './ipc/handlers'
import { registerP2pHandlers } from './ipc/p2p-handlers'
import { registerUpdaterHandlers } from './ipc/updater-handlers'
import { registerOverlayHandlers } from './core/overlay-window'
import { checkForUpdates } from './core/auto-updater'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let win: BrowserWindow | null

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    title: 'YJN',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// 注册所有 IPC 处理器
registerIpcHandlers()
registerP2pHandlers()
registerUpdaterHandlers()
registerOverlayHandlers()

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  // 注册 mc-icon: 协议，用于在渲染进程中加载本地图标文件
  protocol.handle('mc-icon', (request) => {
    // mc-icon:///C:/path/to/icon.png => file:///C:/path/to/icon.png
    const filePath = decodeURIComponent(request.url.replace('mc-icon:///', '').replace('mc-icon://', ''))
    const resolved = path.resolve(filePath)
    // 只允许 .png/.jpg/.ico/.webp 图标文件
    if (!/\.(png|jpe?g|ico|webp|gif)$/i.test(resolved) || !fs.existsSync(resolved)) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(resolved).href)
  })

  // CSP 安全策略
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: https: mc-icon:; " +
          "connect-src 'self' ws://localhost:* https://api.modrinth.com https://api.curseforge.com https://login.microsoftonline.com https://authserver.mojang.com https://bmclapi2.bangbang93.com https://launchermeta.mojang.com https://piston-meta.mojang.com wss://mc-signaling.onrender.com https://mc-signaling.onrender.com wss://signal.yjn159.online https://signal.yjn159.online https://crafatar.com https://minotar.net https://*.workers.dev; " +
          "font-src 'self' data:; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    })
  })

  createWindow()
  // 非开发模式下自动检查更新
  if (!VITE_DEV_SERVER_URL) {
    setTimeout(() => checkForUpdates(), 3000)
  }
})
