import { WebSocketServer, WebSocket } from 'ws'
import * as http from 'http'
import * as https from 'https'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'
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
const PERSISTENT_ROOM_TTL = 7 * 24 * 60 * 60 * 1000 // 7d
const SNAPSHOT_TTL = 7 * 24 * 60 * 60 * 1000 // 7d
const SNAPSHOT_UPLOAD_TOKEN_TTL = 10 * 60 * 1000 // 10 min
const SNAPSHOT_BASE_DIR = path.join(process.cwd(), '.snapshot-store')
const STATE_FILE = path.join(SNAPSHOT_BASE_DIR, 'state.json')

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
  createdAt: number
  peers: Map<string, Peer>
  relayBytes: number
  relayResetTime: number
  // 持久房间支持
  type: 'temporary' | 'persistent'
  pinned: boolean
  pinnedAt?: number
  currentHostId: string | null    // 共享世界的当前 MC 服务器主机
  currentHostPort?: number | null
  worldMeta?: {                   // 共享世界元数据
    worldName: string
    mcVersion: string
    modLoader?: {
      type: string
      version: string
    }
  }
  latestSnapshot?: RoomSnapshot
  emptyAt?: number                // 房间变空的时间戳 (TTL 起算点)
}

interface RoomSnapshot {
  snapshotId: string
  generation: number
  pinned: boolean
  worldName: string
  mcVersion: string
  modLoader?: {
    type: string
    version: string
  }
  sha1: string
  size: number
  uploadedAt: number
  expiresAt: number
  filePath: string
}

interface PendingSnapshotUpload {
  snapshotId: string
  token: string
  roomId: string
  peerId: string
  generation: number
  worldName: string
  mcVersion: string
  modLoader?: {
    type: string
    version: string
  }
  sha1: string
  size: number
  expiresAt: number
  filePath: string
}

interface PersistedState {
  rooms: PersistedRoom[]
}

interface PersistedRoom {
  id: string
  code: string
  hostId: string
  createdAt: number
  pinned: boolean
  pinnedAt?: number
  worldMeta?: Room['worldMeta']
  latestSnapshot?: PersistedSnapshot
}

interface PersistedSnapshot {
  snapshotId: string
  generation: number
  pinned: boolean
  worldName: string
  mcVersion: string
  modLoader?: {
    type: string
    version: string
  }
  sha1: string
  size: number
  uploadedAt: number
  expiresAt: number
  filePath: string
}

// ========== 状态 ==========

const peers = new Map<string, Peer>()
const rooms = new Map<string, Room>()
const codeToRoom = new Map<string, string>()
const snapshots = new Map<string, RoomSnapshot>()
const pendingSnapshotUploads = new Map<string, PendingSnapshotUpload>()
let persistStateTimer: ReturnType<typeof setTimeout> | null = null

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

function publicSnapshot(snapshot: RoomSnapshot) {
  return {
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
    pinned: snapshot.pinned,
    worldName: snapshot.worldName,
    mcVersion: snapshot.mcVersion,
    modLoader: snapshot.modLoader,
    sha1: snapshot.sha1,
    size: snapshot.size,
    uploadedAt: snapshot.uploadedAt,
    expiresAt: snapshot.expiresAt,
    downloadPath: `/snapshot/download/${snapshot.snapshotId}`,
  }
}

function publicRoom(room: Room) {
  return {
    roomCode: room.code,
    pinned: room.pinned,
    pinnedAt: room.pinnedAt,
    worldMeta: room.worldMeta,
    snapshot: room.latestSnapshot ? publicSnapshot(room.latestSnapshot) : null,
  }
}

function toPersistedSnapshot(snapshot: RoomSnapshot): PersistedSnapshot {
  return {
    snapshotId: snapshot.snapshotId,
    generation: snapshot.generation,
    pinned: snapshot.pinned,
    worldName: snapshot.worldName,
    mcVersion: snapshot.mcVersion,
    modLoader: snapshot.modLoader,
    sha1: snapshot.sha1,
    size: snapshot.size,
    uploadedAt: snapshot.uploadedAt,
    expiresAt: snapshot.expiresAt,
    filePath: snapshot.filePath,
  }
}

function toPersistedRoom(room: Room): PersistedRoom {
  return {
    id: room.id,
    code: room.code,
    hostId: room.hostId,
    createdAt: room.createdAt,
    pinned: room.pinned,
    pinnedAt: room.pinnedAt,
    worldMeta: room.worldMeta,
    latestSnapshot: room.latestSnapshot ? toPersistedSnapshot(room.latestSnapshot) : undefined,
  }
}

async function writePersistedState() {
  const pinnedRooms = Array.from(rooms.values())
    .filter(room => room.type === 'persistent' && room.pinned)
    .map(room => toPersistedRoom(room))

  await fsp.mkdir(SNAPSHOT_BASE_DIR, { recursive: true })
  await fsp.writeFile(STATE_FILE, JSON.stringify({ rooms: pinnedRooms }, null, 2), 'utf8')
}

function schedulePersistedStateWrite() {
  if (persistStateTimer) clearTimeout(persistStateTimer)
  persistStateTimer = setTimeout(() => {
    persistStateTimer = null
    void writePersistedState().catch((error) => {
      console.error('[State] Failed to persist room state:', error?.message || error)
    })
  }, 200)
}

async function loadPersistedState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as PersistedState
    if (!Array.isArray(parsed.rooms)) return

    for (const persistedRoom of parsed.rooms) {
      if (!persistedRoom?.id || !persistedRoom?.code || !persistedRoom.pinned) continue

      let snapshot: RoomSnapshot | undefined
      if (persistedRoom.latestSnapshot?.snapshotId && persistedRoom.latestSnapshot.filePath && fs.existsSync(persistedRoom.latestSnapshot.filePath)) {
        snapshot = {
          snapshotId: persistedRoom.latestSnapshot.snapshotId,
          generation: persistedRoom.latestSnapshot.generation,
          pinned: true,
          worldName: persistedRoom.latestSnapshot.worldName,
          mcVersion: persistedRoom.latestSnapshot.mcVersion,
          modLoader: persistedRoom.latestSnapshot.modLoader,
          sha1: persistedRoom.latestSnapshot.sha1,
          size: persistedRoom.latestSnapshot.size,
          uploadedAt: persistedRoom.latestSnapshot.uploadedAt,
          expiresAt: persistedRoom.latestSnapshot.expiresAt,
          filePath: persistedRoom.latestSnapshot.filePath,
        }
        snapshots.set(snapshot.snapshotId, snapshot)
      }

      const room: Room = {
        id: persistedRoom.id,
        code: persistedRoom.code,
        hostId: persistedRoom.hostId || '',
        createdAt: persistedRoom.createdAt || Date.now(),
        peers: new Map(),
        relayBytes: 0,
        relayResetTime: Date.now(),
        type: 'persistent',
        pinned: true,
        pinnedAt: persistedRoom.pinnedAt || Date.now(),
        currentHostId: null,
        currentHostPort: null,
        worldMeta: persistedRoom.worldMeta,
        latestSnapshot: snapshot,
        emptyAt: undefined,
      }

      rooms.set(room.id, room)
      codeToRoom.set(room.code, room.id)
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.error('[State] Failed to load persisted room state:', error?.message || error)
    }
  }
}

async function deleteSnapshot(snapshot?: RoomSnapshot) {
  if (!snapshot) return
  snapshots.delete(snapshot.snapshotId)
  try {
    await fsp.rm(snapshot.filePath, { force: true })
  } catch { /* ignore */ }
  schedulePersistedStateWrite()
}

async function handleSnapshotUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL, snapshotId: string) {
  const pending = pendingSnapshotUploads.get(snapshotId)
  const token = url.searchParams.get('token') || ''
  if (!pending || pending.token !== token || pending.expiresAt < Date.now()) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid or expired upload token' }))
    return
  }

  await fsp.mkdir(path.dirname(pending.filePath), { recursive: true })

  try {
    await pipeline(req, fs.createWriteStream(pending.filePath))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (error: any) {
    try { await fsp.rm(pending.filePath, { force: true }) } catch { /* ignore */ }
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error?.message || 'upload failed' }))
  }
}

async function handleSnapshotDownload(res: http.ServerResponse, snapshotId: string) {
  const snapshot = snapshots.get(snapshotId)
  if (!snapshot || snapshot.expiresAt < Date.now() || !fs.existsSync(snapshot.filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'snapshot not found' }))
    return
  }

  const stat = await fsp.stat(snapshot.filePath)
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${snapshot.worldName}-${snapshot.generation}.tar.gz"`,
  })
  fs.createReadStream(snapshot.filePath).pipe(res)
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
        createdAt: Date.now(),
        peers: new Map([[peer.id, peer]]),
        relayBytes: 0,
        relayResetTime: Date.now(),
        type: 'temporary',
        pinned: false,
        currentHostId: null,
        currentHostPort: null,
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
      room.emptyAt = undefined

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
      sendTo(peer.ws, { type: 'left-room' })
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
      rejoinRoom.emptyAt = undefined

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
        createdAt: Date.now(),
        peers: new Map([[peer.id, peer]]),
        relayBytes: 0,
        relayResetTime: Date.now(),
        type: 'persistent',
        pinned: false,
        currentHostId: null,
        currentHostPort: null,
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
        latestSnapshot: undefined,
      }

      rooms.set(roomId, room)
      codeToRoom.set(code, roomId)
      peer.roomId = roomId

      sendTo(peer.ws, { type: 'persistent-room-created', roomId, roomCode: code, room: publicRoom(room) })
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
      room.currentHostPort = mcPort
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
      room.currentHostPort = null
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
          host: {
            peerId: room.currentHostId,
            peerName: hostPeer?.name || 'Unknown',
            mcPort: room.currentHostPort || undefined,
          },
          hostId: room.currentHostId,
          hostName: hostPeer?.name || 'Unknown',
          mcPort: room.currentHostPort || undefined,
          roomPinned: room.pinned,
          worldMeta: room.worldMeta,
          snapshot: room.latestSnapshot ? publicSnapshot(room.latestSnapshot) : null,
        })
      } else {
        sendTo(peer.ws, {
          type: 'host-info',
          hostId: null,
          roomPinned: room.pinned,
          worldMeta: room.worldMeta,
          snapshot: room.latestSnapshot ? publicSnapshot(room.latestSnapshot) : null,
        })
      }
      break
    }

    case 'set-room-pinned': {
      if (!peer.roomId) { sendTo(peer.ws, { type: 'error', message: '未在房间中' }); return }
      const room = rooms.get(peer.roomId)
      if (!room || room.type !== 'persistent') { sendTo(peer.ws, { type: 'error', message: '房间不存在' }); return }

      const pinned = !!msg.pinned
      room.pinned = pinned
      room.pinnedAt = pinned ? (room.pinnedAt || Date.now()) : undefined

      if (room.latestSnapshot) {
        room.latestSnapshot.pinned = pinned
        if (!pinned) {
          room.latestSnapshot.expiresAt = Date.now() + SNAPSHOT_TTL
        }
      }

      schedulePersistedStateWrite()

      const payload = {
        type: 'room-pinned-updated',
        roomPinned: room.pinned,
        pinnedAt: room.pinnedAt,
        snapshot: room.latestSnapshot ? publicSnapshot(room.latestSnapshot) : null,
      }
      sendTo(peer.ws, payload)
      broadcastToRoom(room, payload, peer.id)
      console.log(`[Room] ${room.code} pinned state changed: ${room.pinned}`)
      break
    }

    case 'request-snapshot-upload': {
      if (!peer.roomId) { sendTo(peer.ws, { type: 'error', message: '未在房间中' }); return }
      const room = rooms.get(peer.roomId)
      if (!room || room.type !== 'persistent') { sendTo(peer.ws, { type: 'error', message: '房间不存在' }); return }
      if (room.currentHostId !== peer.id) { sendTo(peer.ws, { type: 'error', message: '只有当前主机可以上传快照' }); return }

      const worldName = String(msg.worldName || room.worldMeta?.worldName || 'shared-world')
      const mcVersion = String(msg.mcVersion || room.worldMeta?.mcVersion || '')
      const size = Number(msg.size) || 0
      const sha1 = String(msg.sha1 || '')
      const modLoader = (msg as any).modLoader?.type && (msg as any).modLoader?.version
        ? {
            type: String((msg as any).modLoader.type),
            version: String((msg as any).modLoader.version),
          }
        : undefined

      const generation = (room.latestSnapshot?.generation || 0) + 1
      const snapshotId = generateId()
      const token = generateId() + generateId()
      const expiresAt = Date.now() + SNAPSHOT_UPLOAD_TOKEN_TTL
      const filePath = path.join(SNAPSHOT_BASE_DIR, `${snapshotId}.tar.gz`)

      pendingSnapshotUploads.set(snapshotId, {
        snapshotId,
        token,
        roomId: room.id,
        peerId: peer.id,
        generation,
        worldName,
        mcVersion,
        modLoader,
        sha1,
        size,
        expiresAt,
        filePath,
      })

      sendTo(peer.ws, {
        type: 'snapshot-upload-ready',
        snapshotId,
        generation,
        uploadPath: `/snapshot/upload/${snapshotId}?token=${token}`,
        expiresAt,
      })
      break
    }

    case 'commit-snapshot-upload': {
      if (!peer.roomId) { sendTo(peer.ws, { type: 'error', message: '未在房间中' }); return }
      const room = rooms.get(peer.roomId)
      if (!room || room.type !== 'persistent') { sendTo(peer.ws, { type: 'error', message: '房间不存在' }); return }

      const snapshotId = String(msg.snapshotId || '')
      const pending = pendingSnapshotUploads.get(snapshotId)
      if (!pending || pending.peerId !== peer.id || pending.roomId !== room.id) {
        sendTo(peer.ws, { type: 'error', message: '快照上传不存在或已失效' })
        return
      }

      if (!fs.existsSync(pending.filePath)) {
        sendTo(peer.ws, { type: 'error', message: '快照文件尚未上传完成' })
        return
      }

      const uploadedAt = Date.now()
      const snapshot: RoomSnapshot = {
        snapshotId,
        generation: pending.generation,
        pinned: room.pinned,
        worldName: pending.worldName,
        mcVersion: pending.mcVersion,
        modLoader: pending.modLoader,
        sha1: pending.sha1,
        size: pending.size,
        uploadedAt,
        expiresAt: uploadedAt + SNAPSHOT_TTL,
        filePath: pending.filePath,
      }

      const oldSnapshot = room.latestSnapshot
      room.latestSnapshot = snapshot
      room.worldMeta = {
        worldName: snapshot.worldName,
        mcVersion: snapshot.mcVersion,
        modLoader: snapshot.modLoader,
      }
      snapshots.set(snapshot.snapshotId, snapshot)
      pendingSnapshotUploads.delete(snapshotId)

      if (oldSnapshot && oldSnapshot.snapshotId !== snapshot.snapshotId) {
        void deleteSnapshot(oldSnapshot)
      }

      schedulePersistedStateWrite()

      sendTo(peer.ws, { type: 'snapshot-stored', snapshot: publicSnapshot(snapshot) })
      broadcastToRoom(room, { type: 'snapshot-updated', snapshot: publicSnapshot(snapshot) }, peer.id)
      console.log(`[Snapshot] ${peer.name} stored snapshot ${snapshot.snapshotId} for room ${room.code}`)
      break
    }

    case 'query-latest-snapshot': {
      if (!peer.roomId) { sendTo(peer.ws, { type: 'error', message: '未在房间中' }); return }
      const room = rooms.get(peer.roomId)
      if (!room || room.type !== 'persistent') { sendTo(peer.ws, { type: 'error', message: '房间不存在' }); return }
      sendTo(peer.ws, {
        type: 'snapshot-info',
        snapshot: room.latestSnapshot ? publicSnapshot(room.latestSnapshot) : null,
      })
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
    room.currentHostPort = null
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
    schedulePersistedStateWrite()
  } else {
    // 临时房间：房主离开 = 解散房间
    if (room.hostId === peer.id) {
      broadcastToRoom(room, { type: 'room-closed', reason: '房主已离开' })
      for (const [, p] of room.peers) {
        p.roomId = null
      }
      void deleteSnapshot(room.latestSnapshot)
      codeToRoom.delete(room.code)
      rooms.delete(room.id)
      console.log(`[Room] ${room.code} closed (host left)`)
    } else {
      broadcastToRoom(room, { type: 'peer-left', peerId: peer.id })
      console.log(`[Room] ${peer.name} left ${room.code}`)
      if (room.peers.size === 0) {
        void deleteSnapshot(room.latestSnapshot)
        codeToRoom.delete(room.code)
        rooms.delete(room.id)
      }
    }
  }
}

// ========== 服务器启动 ==========

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'PUT' && requestUrl.pathname.startsWith('/snapshot/upload/')) {
    const snapshotId = requestUrl.pathname.split('/').pop() || ''
    void handleSnapshotUpload(req, res, requestUrl, snapshotId)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname.startsWith('/snapshot/download/')) {
    const snapshotId = requestUrl.pathname.split('/').pop() || ''
    void handleSnapshotDownload(res, snapshotId)
    return
  }

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

  for (const [snapshotId, pending] of pendingSnapshotUploads) {
    if (pending.expiresAt <= now) {
      pendingSnapshotUploads.delete(snapshotId)
      void fsp.rm(pending.filePath, { force: true }).catch(() => {})
    }
  }

  for (const [roomId, room] of rooms) {
    if (room.latestSnapshot && !room.latestSnapshot.pinned && room.latestSnapshot.expiresAt <= now) {
      const expiredSnapshot = room.latestSnapshot
      room.latestSnapshot = undefined
      void deleteSnapshot(expiredSnapshot)
    }

    if (room.type === 'persistent' && !room.pinned && room.peers.size === 0 && room.emptyAt) {
      if (now - room.emptyAt > PERSISTENT_ROOM_TTL) {
        void deleteSnapshot(room.latestSnapshot)
        codeToRoom.delete(room.code)
        rooms.delete(roomId)
        console.log(`[Room] Persistent room ${room.code} expired (7d TTL)`)
        schedulePersistedStateWrite()
      }
    }
  }
}, 10 * 60 * 1000)

server.listen(PORT, () => {
  void loadPersistedState().catch(() => {})
  void fsp.mkdir(SNAPSHOT_BASE_DIR, { recursive: true }).catch(() => {})
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
