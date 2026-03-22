/**
 * TCP 代理
 * 房主端: 将 WebRTC DataChannel 的数据转发到 MC LAN 服务器
 * 客人端: 在本地开启 TCP 服务器，MC 客户端连接后通过 DataChannel 转发
 */

import * as net from 'net'
import { EventEmitter } from 'events'

export interface ProxyEvents {
  'data-from-mc': (proxyId: string, data: Buffer) => void
  'mc-connected': (proxyId: string) => void
  'mc-disconnected': (proxyId: string) => void
  'error': (proxyId: string, error: string) => void
}

/**
 * 房主端代理: 连接到 MC LAN 服务器, 双向转发
 * 每个远程 peer 一个实例
 */
export class HostProxy extends EventEmitter {
  readonly proxyId: string
  private socket: net.Socket | null = null
  private mcPort: number
  private destroyed = false

  constructor(proxyId: string, mcLanPort: number) {
    super()
    this.proxyId = proxyId
    this.mcPort = mcLanPort
  }

  /** 初始化（不立即连接 MC 服务器，等待首次数据到达时按需建立） */
  start(): void {
    // 连接延迟到 writeToMc() 首次调用时建立
    // 避免 MC 服务器因长时间无握手数据而关闭空闲连接
  }

  /** 按需建立 / 重建到 MC 服务器的 TCP 连接 */
  private ensureConnection(): void {
    if (this.destroyed) return
    if (this.socket && !this.socket.destroyed) return

    this.socket = net.createConnection({ host: '127.0.0.1', port: this.mcPort }, () => {
      this.emit('mc-connected', this.proxyId)
    })

    this.socket.on('data', (data: Buffer) => {
      this.emit('data-from-mc', this.proxyId, data)
    })

    this.socket.on('close', () => {
      this.socket = null
      this.emit('mc-disconnected', this.proxyId)
    })

    this.socket.on('error', (err: Error) => {
      this.emit('error', this.proxyId, err.message)
    })
  }

  /** 从 WebRTC DataChannel 写入数据到 MC 服务器 */
  writeToMc(data: Buffer): void {
    if (this.destroyed) return
    this.ensureConnection()
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(data)
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.removeAllListeners()
  }
}

/**
 * 客人端代理: 本地监听 TCP, MC 客户端连接此端口
 */
export class ClientProxy extends EventEmitter {
  readonly proxyId: string
  private server: net.Server | null = null
  private client: net.Socket | null = null  // MC 客户端连接
  private localPort = 0
  private destroyed = false

  constructor(proxyId: string) {
    super()
    this.proxyId = proxyId
  }

  /** 开始监听, 返回本地端口 */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('Proxy already destroyed'))
        return
      }

      this.server = net.createServer((socket) => {
        // 允许新连接替换旧连接（MC 断开后重连）
        if (this.client) {
          this.client.destroy()
          this.client = null
        }

        this.client = socket
        this.emit('mc-connected', this.proxyId)

        socket.on('data', (data: Buffer) => {
          this.emit('data-from-mc', this.proxyId, data)
        })

        socket.on('close', () => {
          if (this.client === socket) {
            this.client = null
            this.emit('mc-disconnected', this.proxyId)
          }
        })

        socket.on('error', (err: Error) => {
          this.emit('error', this.proxyId, err.message)
        })
      })

      this.server.listen(0, '0.0.0.0', () => {
        const addr = this.server?.address()
        if (addr && typeof addr === 'object') {
          this.localPort = addr.port
          resolve(this.localPort)
        } else {
          reject(new Error('Failed to get server address'))
        }
      })

      this.server.on('error', (err) => {
        reject(err)
      })
    })
  }

  /** 获取监听端口 */
  getPort(): number {
    return this.localPort
  }

  /** 从 WebRTC DataChannel 写入数据到 MC 客户端 */
  writeToMc(data: Buffer): void {
    if (this.client && !this.client.destroyed) {
      this.client.write(data)
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.client) {
      this.client.destroy()
      this.client = null
    }
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.removeAllListeners()
  }
}

// ========== 代理管理器 ==========

const hostProxies = new Map<string, HostProxy>()
const clientProxies = new Map<string, ClientProxy>()

export function createHostProxy(proxyId: string, mcLanPort: number): HostProxy {
  const existing = hostProxies.get(proxyId)
  if (existing) existing.destroy()

  const proxy = new HostProxy(proxyId, mcLanPort)
  hostProxies.set(proxyId, proxy)
  return proxy
}

export async function createClientProxy(proxyId: string): Promise<{ proxy: ClientProxy; port: number }> {
  const existing = clientProxies.get(proxyId)
  if (existing) existing.destroy()

  const proxy = new ClientProxy(proxyId)
  const port = await proxy.start()
  clientProxies.set(proxyId, proxy)
  return { proxy, port }
}

export function getHostProxy(proxyId: string): HostProxy | undefined {
  return hostProxies.get(proxyId)
}

export function getClientProxy(proxyId: string): ClientProxy | undefined {
  return clientProxies.get(proxyId)
}

export function destroyProxy(proxyId: string): void {
  hostProxies.get(proxyId)?.destroy()
  hostProxies.delete(proxyId)
  clientProxies.get(proxyId)?.destroy()
  clientProxies.delete(proxyId)
}

export function destroyAllProxies(): void {
  for (const p of hostProxies.values()) p.destroy()
  for (const p of clientProxies.values()) p.destroy()
  hostProxies.clear()
  clientProxies.clear()
}
