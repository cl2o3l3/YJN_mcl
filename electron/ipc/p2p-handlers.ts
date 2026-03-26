/**
 * P2P IPC handlers
 * 注册 proxy 启停、数据转发、LAN 检测、网络诊断的 IPC 通道
 */

import { ipcMain, BrowserWindow } from 'electron'
import {
  createHostProxy, createClientProxy,
  getHostProxy, getClientProxy,
  destroyProxy, destroyAllProxies, resetHostProxy, connectHostProxy
} from '../core/tcp-proxy'
import { startLanDetector, stopLanDetector, parseLanPortFromLog } from '../core/lan-detector'
import { startLanBroadcast, stopLanBroadcast, stopAllLanBroadcasts } from '../core/lan-broadcaster'
import { runNetworkDiagnostics } from '../core/network-probe'

function safe<T>(fn: (...args: any[]) => T): (...args: any[]) => Promise<Awaited<T>> {
  return async (...args: any[]): Promise<Awaited<T>> => {
    try { return await fn(...args) as Awaited<T> }
    catch (e: any) { throw new Error(e?.message ?? String(e)) }
  }
}

export function registerP2pHandlers() {
  // ========== TCP 代理 ==========

  function forwardProxyError(id: string, err: string) {
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      win.webContents.send('p2p:proxyError', id, err)
    }
  }

  ipcMain.handle('p2p:startHostProxy', safe(async (_, proxyId: string, mcLanPort: number) => {
    const proxy = createHostProxy(proxyId, mcLanPort)

    proxy.on('data-from-mc', (id: string, data: Buffer) => {
      const wins = BrowserWindow.getAllWindows()
      for (const win of wins) {
        win.webContents.send('p2p:dataFromMc', id, data)
      }
    })

    proxy.on('mc-connected', (id: string) => {
      const wins = BrowserWindow.getAllWindows()
      for (const win of wins) {
        win.webContents.send('p2p:mcConnected', id)
      }
    })

    proxy.on('mc-disconnected', (id: string) => {
      const wins = BrowserWindow.getAllWindows()
      for (const win of wins) {
        win.webContents.send('p2p:mcDisconnected', id)
      }
    })

    proxy.on('error', (id: string, err: string) => {
      forwardProxyError(id, err)
    })

    proxy.start()
    return { proxyId }
  }))

  ipcMain.handle('p2p:startClientProxy', safe(async (_, proxyId: string) => {
    const { port } = await createClientProxy(proxyId)

    const proxy = getClientProxy(proxyId)
    if (proxy) {
      proxy.on('data-from-mc', (id: string, data: Buffer) => {
        const wins = BrowserWindow.getAllWindows()
        for (const win of wins) {
          win.webContents.send('p2p:dataFromMc', id, data)
        }
      })

      proxy.on('mc-connected', (id: string) => {
        const wins = BrowserWindow.getAllWindows()
        for (const win of wins) {
          win.webContents.send('p2p:mcConnected', id)
        }
      })

      proxy.on('mc-disconnected', (id: string) => {
        const wins = BrowserWindow.getAllWindows()
        for (const win of wins) {
          win.webContents.send('p2p:mcDisconnected', id)
        }
      })

      proxy.on('error', (id: string, err: string) => {
        forwardProxyError(id, err)
      })
    }

    return { proxyId, port }
  }))

  ipcMain.handle('p2p:sendToMc', safe((_, proxyId: string, data: Uint8Array) => {
    const buf = Buffer.from(data)
    const hp = getHostProxy(proxyId)
    if (hp) { hp.writeToMc(buf); return }
    const cp = getClientProxy(proxyId)
    if (cp) { cp.writeToMc(buf); return }
  }))

  ipcMain.handle('p2p:destroyProxy', safe((_, proxyId: string) => {
    destroyProxy(proxyId)
  }))

  ipcMain.handle('p2p:resetHostProxy', safe((_, proxyId: string) => {
    resetHostProxy(proxyId)
  }))

  ipcMain.handle('p2p:connectHostProxy', safe((_, proxyId: string) => {
    connectHostProxy(proxyId)
  }))

  ipcMain.handle('p2p:destroyAllProxies', safe(() => {
    destroyAllProxies()
    stopAllLanBroadcasts()
  }))

  // ========== LAN 广播 (客人端) ==========

  ipcMain.handle('p2p:startLanBroadcast', safe((_, id: string, port: number, motd: string) => {
    startLanBroadcast(id, port, motd)
  }))

  ipcMain.handle('p2p:stopLanBroadcast', safe((_, id: string) => {
    stopLanBroadcast(id)
  }))

  ipcMain.handle('p2p:stopAllLanBroadcasts', safe(() => {
    stopAllLanBroadcasts()
  }))

  // ========== LAN 检测 ==========

  ipcMain.handle('p2p:startLanDetector', safe((event) => {
    startLanDetector((games) => {
      event.sender.send('p2p:lanGames', games)
    })
  }))

  ipcMain.handle('p2p:stopLanDetector', safe(() => {
    stopLanDetector()
  }))

  ipcMain.handle('p2p:parseLanPort', safe((_, logLine: string) => {
    return parseLanPortFromLog(logLine)
  }))

  // ========== 网络诊断 ==========

  ipcMain.handle('p2p:runDiagnostics', safe(async () => {
    return runNetworkDiagnostics()
  }))
}
