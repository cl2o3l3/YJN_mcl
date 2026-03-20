/**
 * LAN 广播器 (主进程)
 * 向本地 MC 客户端广播伪造的 LAN 公告
 * 让远程游戏直接显示在 MC 多人游戏列表中，无需手动输入地址
 *
 * MC Java Edition 监听 UDP 多播 224.0.2.60:4445
 * 报文格式: [MOTD]<motd>[/MOTD][AD]<port>[/AD]
 */

import * as dgram from 'dgram'

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
      socket.setMulticastTTL(1)
      socket.setMulticastLoopback(true)
    } catch { /* 部分系统不支持 */ }

    // 立即发送一次
    socket.send(message, 0, message.length, MC_LAN_PORT, MC_LAN_MULTICAST)
  })

  const timer = setInterval(() => {
    try {
      socket.send(message, 0, message.length, MC_LAN_PORT, MC_LAN_MULTICAST)
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
