/**
 * LAN 广播器 (主进程)
 * 向本地 MC 客户端广播伪造的 LAN 公告
 * 让远程游戏直接显示在 MC 多人游戏列表中，无需手动输入地址
 *
 * MC Java Edition 监听 UDP 多播 224.0.2.60:4445
 * 报文格式: [MOTD]<motd>[/MOTD][AD]<port>[/AD]
 */

import * as dgram from 'dgram'
import * as os from 'node:os'

const MC_LAN_MULTICAST = '224.0.2.60'
const MC_LAN_PORT = 4445
const BROADCAST_INTERVAL = 1500 // MC 原版间隔

interface BroadcastEntry {
  port: number
  motd: string
  timer: ReturnType<typeof setInterval>
  socket: dgram.Socket
}

const activeBroadcasts = new Map<string, BroadcastEntry>()

function toBroadcastAddress(address: string, netmask: string): string | null {
  const addressParts = address.split('.').map(Number)
  const netmaskParts = netmask.split('.').map(Number)
  if (addressParts.length !== 4 || netmaskParts.length !== 4) return null
  if (addressParts.some(Number.isNaN) || netmaskParts.some(Number.isNaN)) return null

  const broadcastParts = addressParts.map((part, index) => (part | (~netmaskParts[index] & 0xff)) & 0xff)
  return broadcastParts.join('.')
}

function collectAnnouncementTargets(): string[] {
  const targets = new Set<string>([MC_LAN_MULTICAST, '255.255.255.255'])

  const interfaces = os.networkInterfaces()
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue
    for (const info of iface) {
      if (info.family !== 'IPv4' || info.internal || !info.address || !info.netmask) continue
      const broadcast = toBroadcastAddress(info.address, info.netmask)
      if (broadcast) targets.add(broadcast)
    }
  }

  return [...targets]
}

function sendAnnouncement(socket: dgram.Socket, message: Buffer) {
  const targets = collectAnnouncementTargets()
  for (const target of targets) {
    socket.send(message, 0, message.length, MC_LAN_PORT, target, (err) => {
      if (err) {
        console.warn(`[LAN Broadcast] Send failed to ${target}:`, err.message)
      }
    })
  }
}

/**
 * 开始广播一个伪造的 LAN 游戏
 * @param id 唯一标识（用于后续停止）
 * @param port 本地代理端口（MC 客户端将连接此端口）
 * @param motd 显示在列表中的描述文字
 */
export function startLanBroadcast(id: string, port: number, motd: string): void {
  stopLanBroadcast(id)

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const message = Buffer.from(`[MOTD]${motd}[/MOTD][AD]${port}[/AD]`)

  socket.on('error', (err) => {
    console.error('[LAN Broadcast] Socket error:', err.message)
    stopLanBroadcast(id)
  })

  socket.bind(0, () => {
    try {
      socket.setBroadcast(true)
      socket.setMulticastTTL(1)
      socket.setMulticastLoopback(true)
    } catch { /* 部分系统不支持 */ }

    // 立即发送一次
    sendAnnouncement(socket, message)
  })

  const timer = setInterval(() => {
    try {
      sendAnnouncement(socket, message)
    } catch { /* 忽略 */ }
  }, BROADCAST_INTERVAL)

  activeBroadcasts.set(id, { port, motd, timer, socket })
}

/**
 * 停止指定广播
 */
export function stopLanBroadcast(id: string): void {
  const entry = activeBroadcasts.get(id)
  if (!entry) return
  clearInterval(entry.timer)
  try { entry.socket.close() } catch { /* ignore */ }
  activeBroadcasts.delete(id)
}

/**
 * 停止所有广播
 */
export function stopAllLanBroadcasts(): void {
  for (const id of activeBroadcasts.keys()) {
    stopLanBroadcast(id)
  }
}
