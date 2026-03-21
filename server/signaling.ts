import { WebSocketServer, WebSocket } from 'ws'
import * as http from 'http'
import * as https from 'https'
import * as dotenv from 'dotenv'

dotenv.config()

// ========== 配置 ==========

const PORT = parseInt(process.env.PORT || '8080', 10)
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID || ''
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN || ''
const MAX_PLAYERS_PER_ROOM = 8
const HEARTBEAT_INTERVAL = 30_000
const HEARTBEAT_TIMEOUT = 60_000
const RELAY_RATE_LIMIT = 1_048_576 // 1MB/s per room
const ROOM_CODE_LENGTH = 6
const SERVER_START_TIME = Date.now()
const PERSISTENT_ROOM_TTL = 24 * 60 * 60 * 1000 // 24h

// ========== 类型 ==========

interface Peer {
  id: string
  name: string
  ws: WebSocket
  roomId: string | null
  lastPong: number
}

interface Room {
  id: string
  code: string
  hostId: string
  peers: Map<string, Peer>
  relayBytes: number
  relayResetTime: number
  // 持久房间支持
  type: 'temporary' | 'persistent'
  currentHostId: string | null    // 共享世界的当前 MC 服务器主机
  worldMeta?: {                   // 共享世界元数据
    worldName: string
    mcVersion: string
    modLoader?: {
      type: string
      version: string
    }
  }
  emptyAt?: number                // 房间变空的时间戳 (TTL 起算点)
}

// ========== 状态 ==========

const peers = new Map<string, Peer>()
const rooms = new Map<string, Room>()
const codeToRoom = new Map<string, string>()

// ========== 工具函数 ==========

function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36)
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉易混淆字符
  let code = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

function sendTo(ws: WebSocket, msg: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function broadcastToRoom(room: Room, msg: Record<string, unknown>, excludeId?: string) {
  for (const [id, peer] of room.peers) {
    if (id !== excludeId) {
      sendTo(peer.ws, msg)
    }
  }
}

// ========== Cloudflare TURN 凭据代理 (带缓存) ==========

let turnCache: { iceServers: unknown[] } | null = null
let turnCacheExpiry = 0
const TURN_CACHE_TTL = 3600_000 // 1 小时

async function fetchCfTurnCredentials(): Promise<{ iceServers: unknown[] } | null> {
  // 命中缓存
  if (turnCache && Date.now() < turnCacheExpiry) {
    return turnCache
  }

  if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) return null

  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_KEY_ID}/credentials/generate-ice-servers`

  return new Promise((resolve) => {
    const body = JSON.stringify({ ttl: 86400 })
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.iceServers) {
            const result = { iceServers: parsed.iceServers }
            turnCache = result
            turnCacheExpiry = Date.now() + TURN_CACHE_TTL
            resolve(result)
          } else {
            console.error('[CF TURN] Unexpected response:', data.substring(0, 200))
            resolve(null)
          }
        } catch {
          console.error('[CF TURN] Parse error:', data.substring(0, 200))
          resolve(null)
        }
      })
    })

    req.on('error', (err) => {
      console.error('[CF TURN] Request error:', err.message)
      resolve(null)
    })

    req.setTimeout(10_000, () => {
      req.destroy()
      resolve(null)
    })

    req.write(body)
    req.end()
  })
}

// ========== 消息处理 ==========

function handleMessage(peer: Peer, raw: string) {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(raw)
  } catch {
    sendTo(peer.ws, { type: 'error', message: 'Invalid JSON' })
    return
  }

  const type = msg.type as string

  switch (type) {
    case 'create-room': {
      if (peer.roomId) {
        sendTo(peer.ws, { type: 'error', message: '已在房间中' })
        return
      }
      const playerName = String(msg.playerName || 'Player')
      peer.name = playerName

      const roomId = generateId()
      let code = generateRoomCode()
      while (codeToRoom.has(code)) code = generateRoomCode()

      const room: Room = {
        id: roomId,
        code,
        hostId: peer.id,
        peers: new Map([[peer.id, peer]]),
        relayBytes: 0,
        relayResetTime: Date.now(),
        type: 'temporary',
        currentHostId: null,
      }

      rooms.set(roomId, room)
      codeToRoom.set(code, roomId)
      peer.roomId = roomId

      sendTo(peer.ws, { type: 'room-created', roomId, roomCode: code })
      console.log(`[Room] Created ${code} by ${playerName}`)
      break
    }

    case 'join-room': {
      if (peer.roomId) {
        sendTo(peer.ws, { type: 'error', message: '已在房间中' })
        return
      }
      const code = String(msg.roomCode || '').toUpperCase()
      const roomId = codeToRoom.get(code)
      if (!roomId) {
        sendTo(peer.ws, { type: 'error', message: '房间不存在' })
        return
      }
      const room = rooms.get(roomId)
      if (!room) {
        sendTo(peer.ws, { type: 'error', message: '房间不存在' })
        return
      }
      if (room.peers.size >= MAX_PLAYERS_PER_ROOM) {
        sendTo(peer.ws, { type: 'error', message: '房间已满' })
        return
      }

      peer.name = String(msg.playerName || 'Player')
      peer.roomId = roomId
      room.peers.set(peer.id, peer)

      // 通知新成员已有 peers
      const existingPeers = Array.from(room.peers.values())
        .filter(p => p.id !== peer.id)
        .map(p => ({ id: p.id, name: p.name }))
      sendTo(peer.ws, { type: 'room-joined', roomId, peers: existingPeers })

      // 通知其他人有新成员
      broadcastToRoom(room, { type: 'peer-joined', peerId: peer.id, peerName: peer.name }, peer.id)
      console.log(`[Room] ${peer.name} joined ${room.code}`)
      break
    }

    case 'leave-room': {
      removePeerFromRoom(peer)
      break
    }

    case 'rejoin-room': {
      // 断线重连后重新加入房间
      const rejoinRoomId = String(msg.roomId || '')
      const rejoinRoom = rooms.get(rejoinRoomId)
      if (!rejoinRoom) {
        sendTo(peer.ws, { type: 'error', message: '房间已关闭' })
        return
      }
      if (rejoinRoom.peers.size >= MAX_PLAYERS_PER_ROOM) {
        sendTo(peer.ws, { type: 'error', message: '房间已满' })
        return
      }
      peer.name = String(msg.playerName || 'Player')
      peer.roomId = rejoinRoomId
      rejoinRoom.peers.set(peer.id, peer)

      const existingPeers = Array.from(rejoinRoom.peers.values())
        .filter(p => p.id !== peer.id)
        .map(p => ({ id: p.id, name: p.name }))
      sendTo(peer.ws, { type: 'room-joined', roomId: rejoinRoomId, peers: existingPeers })
      broadcastToRoom(rejoinRoom, { type: 'peer-joined', peerId: peer.id, peerName: peer.name }, peer.id)
      console.log(`[Room] ${peer.name} rejoined ${rejoinRoom.code}`)
      break
    }

    // SDP / ICE 中继——按 targetPeerId 转发
    case 'offer':
    case 'answer':
    case 'ice-candidate': {
      const targetId = String(msg.targetPeerId || '')
      if (!peer.roomId) return
      const room = rooms.get(peer.roomId)
      if (!room) return
      const target = room.peers.get(targetId)
      if (!target) return
      sendTo(target.ws, { ...msg, fromPeerId: peer.id })
      break
    }

    // 中继模式——二进制帧转发
    case 'relay-data': {
      if (!peer.roomId) return
      const room = rooms.get(peer.roomId)
      if (!room) return

      const data = String(msg.data || '')
      const dataSize = data.length // base64 近似字节数

      // 限速检查
      const now = Date.now()
      if (now - room.relayResetTime > 1000) {
        room.relayBytes = 0
        room.relayResetTime = now
      }
      room.relayBytes += dataSize
      if (room.relayBytes > RELAY_RATE_LIMIT) {
        // 限速：丢弃本帧但不断连
        return
      }

      const targetId = String(msg.targetPeerId || '')
      const target = room.peers.get(targetId)
      if (target) {
        sendTo(target.ws, { type: 'relay-data', fromPeerId: peer.id, data })
      }
      break
    }

    case 'relay-start':
    case 'relay-stop': {
      if (!peer.roomId) return
      const room = rooms.get(peer.roomId)
      if (!room) return
      const targetId = String(msg.targetPeerId || '')
      const target = room.peers.get(targetId)
      if (target) {
        sendTo(target.ws, { type, fromPeerId: peer.id })
      }
      break
    }

    case 'connection-tier': {
      // 可记录统计，暂直接转发
      if (!peer.roomId) return
      const room = rooms.get(peer.roomId)
      if (room) {
        broadcastToRoom(room, { type: 'connection-tier', peerId: peer.id, tier: msg.tier }, peer.id)
      }
      break
    }

    // Cloudflare TURN 凭据请求
    case 'request-turn-credentials': {
      fetchCfTurnCredentials().then((result) => {
        if (result) {
          sendTo(peer.ws, { type: 'turn-credentials', iceServers: result.iceServers })
        } else {
          sendTo(peer.ws, { type: 'turn-credentials', iceServers: [] })
        }
      })
      break
    }

    // ========== 持久房间 + 主机注册 (Shared World) ==========

    case 'create-persistent-room': {
      if (peer.roomId) {
        sendTo(peer.ws, { type: 'error', message: '已在房间中' })
        return
      }
      const playerName = String(msg.playerName || 'Player')
      peer.name = playerName

      const roomId = generateId()
      let code = generateRoomCode()
      while (codeToRoom.has(code)) code = generateRoomCode()

      const room: Room = {
        id: roomId,
        code,
        hostId: peer.id,
        peers: new Map([[peer.id, peer]]),
        relayBytes: 0,
        relayResetTime: Date.now(),
        type: 'persistent',
        currentHostId: null,
        worldMeta: msg.worldMeta ? {
          worldName: String((msg.worldMeta as any).worldName || ''),
          mcVersion: String((msg.worldMeta as any).mcVersion || ''),
          modLoader: (msg.worldMeta as any).modLoader?.type && (msg.worldMeta as any).modLoader?.version
            ? {
                type: String((msg.worldMeta as any).modLoader.type),
                version: String((msg.worldMeta as any).modLoader.version),
              }
            : undefined,
        } : undefined,
      }

      rooms.set(roomId, room)
      codeToRoom.set(code, roomId)
      peer.roomId = roomId

      sendTo(peer.ws, { type: 'persistent-room-created', roomId, roomCode: code })
      console.log(`[Room] Persistent room ${code} created by ${playerName}`)
      break
    }

    case 'register-host': {
      if (!peer.roomId) { sendTo(peer.ws, { type: 'error', message: '未在房间中' }); return }
      const room = rooms.get(peer.roomId)
      if (!room) { sendTo(peer.ws, { type: 'error', message: '房间不存在' }); return }

      // 原子先到先得: 只有当前无主机时才能注册
      if (room.currentHostId && room.currentHostId !== peer.id) {
        const hostPeer = room.peers.get(room.currentHostId)
        if (hostPeer) {
          sendTo(peer.ws, { type: 'host-conflict', currentHostId: room.currentHostId, currentHostName: hostPeer.name })
          return
        }
        // 主机已断连但未清理，允许覆盖
      }

      room.currentHostId = peer.id
      const mcPort = Number(msg.mcPort) || 0
      sendTo(peer.ws, { type: 'host-registered', mcPort })
      broadcastToRoom(room, {
        type: 'host-changed',
        hostId: peer.id,
        hostName: peer.name,
        mcPort
      }, peer.id)
      console.log(`[Room] ${peer.name} registered as host in ${room.code} (port: ${mcPort})`)
      break
    }

    case 'unregister-host': {
      if (!peer.roomId) return
      const room = rooms.get(peer.roomId)
      if (!room) return
      if (room.currentHostId !== peer.id) return

      room.currentHostId = null
      broadcastToRoom(room, { type: 'host-changed', hostId: null, reason: 'unregistered' })
      console.log(`[Room] ${peer.name} unregistered as host in ${room.code}`)
      break
    }

    case 'query-host': {
      if (!peer.roomId) { sendTo(peer.ws, { type: 'error', message: '未在房间中' }); return }
      const room = rooms.get(peer.roomId)
      if (!room) { sendTo(peer.ws, { type: 'error', message: '房间不存在' }); return }

      if (room.currentHostId) {
        const hostPeer = room.peers.get(room.currentHostId)
        sendTo(peer.ws, {
          type: 'host-info',
          hostId: room.currentHostId,
          hostName: hostPeer?.name || 'Unknown',
          worldMeta: room.worldMeta,
        })
      } else {
        sendTo(peer.ws, { type: 'host-info', hostId: null, worldMeta: room.worldMeta })
      }
      break
    }

    // 存档传输信号
    case 'save-offer':
    case 'save-accept':
    case 'save-reject': {
      if (!peer.roomId) return
      const room = rooms.get(peer.roomId)
      if (!room) return
      const targetId = String(msg.targetPeerId || '')
      const target = room.peers.get(targetId)
      if (target) {
        sendTo(target.ws, { ...msg, fromPeerId: peer.id })
      }
      break
    }

    default:
      sendTo(peer.ws, { type: 'error', message: `Unknown type: ${type}` })
  }
}

// ========== 房间清理 ==========

function removePeerFromRoom(peer: Peer) {
  if (!peer.roomId) return
  const room = rooms.get(peer.roomId)
  peer.roomId = null
  if (!room) return

  room.peers.delete(peer.id)

  // 如果这个 peer 是当前 MC 主机，广播主机变更
  if (room.currentHostId === peer.id) {
    room.currentHostId = null
    broadcastToRoom(room, { type: 'host-changed', hostId: null, reason: 'disconnected' })
    console.log(`[Room] Host ${peer.name} disconnected from ${room.code}`)
  }

  if (room.type === 'persistent') {
    // 持久房间：房主离开不解散，只广播 peer-left
    broadcastToRoom(room, { type: 'peer-left', peerId: peer.id })
    console.log(`[Room] ${peer.name} left persistent room ${room.code} (${room.peers.size} remaining)`)

    // 房间变空时记录时间戳，启动 TTL
    if (room.peers.size === 0) {
      room.emptyAt = Date.now()
      console.log(`[Room] Persistent room ${room.code} is empty, TTL starts`)
    }
  } else {
    // 临时房间：房主离开 = 解散房间
    if (room.hostId === peer.id) {
      broadcastToRoom(room, { type: 'room-closed', reason: '房主已离开' })
      for (const [, p] of room.peers) {
        p.roomId = null
      }
      codeToRoom.delete(room.code)
      rooms.delete(room.id)
      console.log(`[Room] ${room.code} closed (host left)`)
    } else {
      broadcastToRoom(room, { type: 'peer-left', peerId: peer.id })
      console.log(`[Room] ${peer.name} left ${room.code}`)
      if (room.peers.size === 0) {
        codeToRoom.delete(room.code)
        rooms.delete(room.id)
      }
    }
  }
}

// ========== 服务器启动 ==========

const server = http.createServer((req, res) => {
  // 健康检查 + 状态
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
      rooms: rooms.size,
      peers: peers.size,
      turnCached: turnCache !== null && Date.now() < turnCacheExpiry
    }))
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  const peer: Peer = {
    id: generateId(),
    name: '',
    ws,
    roomId: null,
    lastPong: Date.now()
  }
  peers.set(peer.id, peer)

  // 发送 peer ID
  sendTo(ws, { type: 'welcome', peerId: peer.id })

  ws.on('message', (data) => {
    handleMessage(peer, data.toString())
  })

  ws.on('pong', () => {
    peer.lastPong = Date.now()
  })

  ws.on('close', () => {
    removePeerFromRoom(peer)
    peers.delete(peer.id)
  })

  ws.on('error', () => {
    removePeerFromRoom(peer)
    peers.delete(peer.id)
  })
})

// 心跳
setInterval(() => {
  const now = Date.now()
  for (const [id, peer] of peers) {
    if (now - peer.lastPong > HEARTBEAT_TIMEOUT) {
      peer.ws.terminate()
      removePeerFromRoom(peer)
      peers.delete(id)
    } else {
      peer.ws.ping()
    }
  }
}, HEARTBEAT_INTERVAL)

// 持久房间 TTL 清理 (每 10 分钟检查)
setInterval(() => {
  const now = Date.now()
  for (const [roomId, room] of rooms) {
    if (room.type === 'persistent' && room.peers.size === 0 && room.emptyAt) {
      if (now - room.emptyAt > PERSISTENT_ROOM_TTL) {
        codeToRoom.delete(room.code)
        rooms.delete(roomId)
        console.log(`[Room] Persistent room ${room.code} expired (24h TTL)`)
      }
    }
  }
}, 10 * 60 * 1000)

server.listen(PORT, () => {
  console.log(`[Signaling] Server running on port ${PORT}`)
  console.log(`[Signaling] CF TURN: ${CF_TURN_KEY_ID ? 'configured' : 'not configured'}`)
  console.log(`[Signaling] Rooms: 0 | Peers: 0`)
})

// ========== 优雅关机 ==========

function gracefulShutdown(signal: string) {
  console.log(`[Signaling] ${signal} received, notifying clients...`)
  // 通知所有客户端服务器即将重启
  for (const [, peer] of peers) {
    sendTo(peer.ws, { type: 'server-restart', message: '服务器正在重启，请稍后自动重连' })
    peer.ws.close(1001, 'Server restarting')
  }
  // 清空状态
  rooms.clear()
  codeToRoom.clear()
  peers.clear()

  wss.close(() => {
    server.close(() => {
      console.log('[Signaling] Shutdown complete')
      process.exit(0)
    })
  })

  // 强制退出兜底
  setTimeout(() => process.exit(0), 5000)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
