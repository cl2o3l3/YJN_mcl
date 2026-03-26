/**
 * LAN 端口检测器
 * 监听 MC Java Edition 的 LAN 广播 (UDP port 4445)
 * 以及解析游戏日志中的 LAN 端口
 */

import * as dgram from 'dgram'

const LAN_BROADCAST_PORT = 4445
const MOTD_REGEX = /\[MOTD\](.*?)\[\/MOTD\]\[AD\](\d+)\[\/AD\]/
const LOG_PORT_PATTERNS = [
  /Local game hosted on port\s+(\d+)/i,
  /Started serving on(?:.*?[:\s])(\d{2,5})/i,
  /LAN server.*?port(?:\s+is|\s*[:=])\s*(\d{2,5})/i,
  /Hosting.*?LAN.*?on(?:\s+address)?(?:.*?[:\s])(\d{2,5})/i,
  /Publishing.*?LAN.*?port\s+(\d+)/i,
  /对局域网开放.*?(\d{2,5})/i,
  /局域网.*?端口.*?(\d{2,5})/i,
  /在端口\s*(\d{2,5})\s*上提供服务/i,
]

export interface LanGame {
  motd: string
  port: number
  address: string
  timestamp: number
}

let socket: dgram.Socket | null = null
let detectedGames: Map<string, LanGame> = new Map()

/**
 * 开始监听 MC LAN 广播
 * callback 会在检测到新游戏或游戏消失时调用
 */
export function startLanDetector(
  callback: (games: LanGame[]) => void
): void {
  if (socket) return // 已经在监听

  detectedGames = new Map()

  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

  socket.on('message', (msg, rinfo) => {
    const text = msg.toString()
    const match = MOTD_REGEX.exec(text)
    if (!match) return

    const motd = match[1]
    const port = parseInt(match[2], 10)
    if (isNaN(port) || port < 1 || port > 65535) return

    const key = `${rinfo.address}:${port}`
    const game: LanGame = {
      motd,
      port,
      address: rinfo.address,
      timestamp: Date.now()
    }

    detectedGames.set(key, game)
    callback(Array.from(detectedGames.values()))
  })

  socket.on('error', (err) => {
    console.error('[LAN Detector] Socket error:', err.message)
    stopLanDetector()
  })

  socket.bind(LAN_BROADCAST_PORT, () => {
    try {
      socket?.addMembership('224.0.2.60') // MC 的多播组
    } catch {
      // 某些环境下多播可能不可用，忽略
    }
  })

  // 定期清理超过 5 秒没更新的游戏（MC 每 1.5 秒广播一次）
  const cleanupInterval = setInterval(() => {
    const now = Date.now()
    let changed = false
    for (const [key, game] of detectedGames) {
      if (now - game.timestamp > 5000) {
        detectedGames.delete(key)
        changed = true
      }
    }
    if (changed) {
      callback(Array.from(detectedGames.values()))
    }
  }, 2000)

  // 把 interval 挂在 socket 上以便清理
  ;(socket as any).__cleanupInterval = cleanupInterval
}

/**
 * 停止 LAN 监听
 */
export function stopLanDetector(): void {
  if (!socket) return
  const interval = (socket as any).__cleanupInterval
  if (interval) clearInterval(interval)
  try { socket.close() } catch { /* ignore */ }
  socket = null
  detectedGames.clear()
}

/**
 * 从游戏日志解析 LAN 端口
 */
export function parseLanPortFromLog(logLine: string): number | null {
  for (const pattern of LOG_PORT_PATTERNS) {
    const match = pattern.exec(logLine)
    if (!match) continue
    const port = parseInt(match[1], 10)
    if (port >= 1 && port <= 65535) return port
  }
  return null
}
