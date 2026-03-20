/**
 * E2E 测试 — 信令服务器核心路径
 * 
 * 测试覆盖:
 *   1. WebSocket 连接 + welcome 消息
 *   2. 创建房间 + 获取房间码
 *   3. 加入房间 + peer-joined 通知
 *   4. SDP offer/answer 中继
 *   5. ICE candidate 中继
 *   6. 离开房间 + 通知
 *   7. 房主离开 → 房间关闭通知
 *   8. TURN 凭据请求
 *   9. rejoin-room 重连
 *  10. 健康检查端点
 * 
 * 运行: npx ts-node test-e2e.ts [ws://localhost:8080]
 */

import WebSocket from 'ws'
import * as http from 'http'
import * as https from 'https'

const SERVER_URL = process.argv[2] || 'ws://localhost:8080'
const HTTP_URL = SERVER_URL.replace('ws://', 'http://').replace('wss://', 'https://')

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++
    console.log(`  ✅ ${msg}`)
  } else {
    failed++
    console.error(`  ❌ ${msg}`)
  }
}

function createClient(): Promise<{ ws: WebSocket; peerId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL)
    const timer = setTimeout(() => reject(new Error('Connect timeout')), 10000)
    ws.on('open', () => {
      ws.once('message', (data) => {
        clearTimeout(timer)
        const msg = JSON.parse(data.toString())
        if (msg.type === 'welcome' && msg.peerId) {
          resolve({ ws, peerId: msg.peerId })
        } else {
          reject(new Error('Expected welcome message'))
        }
      })
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function waitMsg(ws: WebSocket, type: string, timeout = 10000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout)
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === type) {
        clearTimeout(timer)
        ws.removeListener('message', handler)
        resolve(msg)
      }
    }
    ws.on('message', handler)
  })
}

function send(ws: WebSocket, msg: Record<string, unknown>) {
  ws.send(JSON.stringify(msg))
}

async function httpGet(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = `${HTTP_URL}${path}`
    const getter = url.startsWith('https') ? https.get : http.get
    getter(url, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(data) })
        } catch {
          resolve({ status: res.statusCode || 0, body: {} })
        }
      })
    }).on('error', reject)
  })
}

async function test1_connect() {
  console.log('\n📡 Test 1: WebSocket 连接 + welcome')
  const { ws, peerId } = await createClient()
  assert(typeof peerId === 'string' && peerId.length > 0, 'Received peerId')
  ws.close()
}

async function test2_createRoom() {
  console.log('\n🏠 Test 2: 创建房间')
  const { ws, peerId } = await createClient()
  send(ws, { type: 'create-room', playerName: 'Host' })
  const msg = await waitMsg(ws, 'room-created')
  assert(typeof msg.roomCode === 'string' && (msg.roomCode as string).length === 6, `Room code: ${msg.roomCode}`)
  assert(typeof msg.roomId === 'string', `Room ID: ${(msg.roomId as string).substring(0, 8)}...`)
  ws.close()
  return { roomCode: msg.roomCode as string, roomId: msg.roomId as string }
}

async function test3_joinRoom() {
  console.log('\n🚪 Test 3: 加入房间 + peer-joined 通知')
  const host = await createClient()
  send(host.ws, { type: 'create-room', playerName: 'Host' })
  const created = await waitMsg(host.ws, 'room-created')
  const code = created.roomCode as string

  const guest = await createClient()
  const hostNotification = waitMsg(host.ws, 'peer-joined')
  send(guest.ws, { type: 'join-room', roomCode: code, playerName: 'Guest' })
  const joined = await waitMsg(guest.ws, 'room-joined')
  const notification = await hostNotification

  assert(Array.isArray(joined.peers), 'Guest received peers list')
  assert((joined.peers as unknown[]).length === 1, 'Peers list has host')
  assert(notification.peerName === 'Guest', 'Host notified of guest join')

  host.ws.close()
  guest.ws.close()
  return { code, roomId: created.roomId as string }
}

async function test4_sdpRelay() {
  console.log('\n🔄 Test 4: SDP offer/answer 中继')
  const host = await createClient()
  send(host.ws, { type: 'create-room', playerName: 'Host' })
  const created = await waitMsg(host.ws, 'room-created')

  const guest = await createClient()
  const hostNotif4 = waitMsg(host.ws, 'peer-joined')
  send(guest.ws, { type: 'join-room', roomCode: created.roomCode as string, playerName: 'Guest' })
  await waitMsg(guest.ws, 'room-joined')
  await hostNotif4

  // Guest → Host: offer
  const offerPromise = waitMsg(host.ws, 'offer')
  send(guest.ws, { type: 'offer', targetPeerId: host.peerId, sdp: 'test-offer-sdp' })
  const offer = await offerPromise
  assert(offer.sdp === 'test-offer-sdp', 'Offer relayed correctly')
  assert(offer.fromPeerId === guest.peerId, 'Offer has correct sender')

  // Host → Guest: answer
  const answerPromise = waitMsg(guest.ws, 'answer')
  send(host.ws, { type: 'answer', targetPeerId: guest.peerId, sdp: 'test-answer-sdp' })
  const answer = await answerPromise
  assert(answer.sdp === 'test-answer-sdp', 'Answer relayed correctly')

  host.ws.close()
  guest.ws.close()
}

async function test5_iceRelay() {
  console.log('\n🧊 Test 5: ICE candidate 中继')
  const host = await createClient()
  send(host.ws, { type: 'create-room', playerName: 'Host' })
  const created = await waitMsg(host.ws, 'room-created')

  const guest = await createClient()
  const hostNotif5 = waitMsg(host.ws, 'peer-joined')
  send(guest.ws, { type: 'join-room', roomCode: created.roomCode as string, playerName: 'Guest' })
  await waitMsg(guest.ws, 'room-joined')
  await hostNotif5

  const icePromise = waitMsg(host.ws, 'ice-candidate')
  send(guest.ws, { type: 'ice-candidate', targetPeerId: host.peerId, candidate: 'test-candidate' })
  const ice = await icePromise
  assert(ice.candidate === 'test-candidate', 'ICE candidate relayed')
  assert(ice.fromPeerId === guest.peerId, 'ICE has correct sender')

  host.ws.close()
  guest.ws.close()
}

async function test6_leaveRoom() {
  console.log('\n👋 Test 6: 客人离开房间')
  const host = await createClient()
  send(host.ws, { type: 'create-room', playerName: 'Host' })
  const created = await waitMsg(host.ws, 'room-created')

  const guest = await createClient()
  const hostNotif6 = waitMsg(host.ws, 'peer-joined')
  send(guest.ws, { type: 'join-room', roomCode: created.roomCode as string, playerName: 'Guest' })
  await waitMsg(guest.ws, 'room-joined')
  await hostNotif6

  const leftPromise = waitMsg(host.ws, 'peer-left')
  send(guest.ws, { type: 'leave-room' })
  const left = await leftPromise
  assert(left.peerId === guest.peerId, 'Host notified of guest leaving')

  host.ws.close()
  guest.ws.close()
}

async function test7_hostLeave() {
  console.log('\n💥 Test 7: 房主离开 → 房间关闭')
  const host = await createClient()
  send(host.ws, { type: 'create-room', playerName: 'Host' })
  const created = await waitMsg(host.ws, 'room-created')

  const guest = await createClient()
  const hostNotif7 = waitMsg(host.ws, 'peer-joined')
  send(guest.ws, { type: 'join-room', roomCode: created.roomCode as string, playerName: 'Guest' })
  await waitMsg(guest.ws, 'room-joined')
  await hostNotif7

  const closedPromise = waitMsg(guest.ws, 'room-closed')
  send(host.ws, { type: 'leave-room' })
  const closed = await closedPromise
  assert(typeof closed.reason === 'string', `Room closed: ${closed.reason}`)

  host.ws.close()
  guest.ws.close()
}

async function test8_turnCredentials() {
  console.log('\n🔑 Test 8: TURN 凭据请求')
  const { ws } = await createClient()
  send(ws, { type: 'request-turn-credentials' })
  const msg = await waitMsg(ws, 'turn-credentials')
  assert(Array.isArray(msg.iceServers), `TURN response: ${(msg.iceServers as unknown[]).length} servers`)
  ws.close()
}

async function test9_rejoin() {
  console.log('\n🔄 Test 9: rejoin-room 重连')
  const host = await createClient()
  send(host.ws, { type: 'create-room', playerName: 'Host' })
  const created = await waitMsg(host.ws, 'room-created')
  const roomId = created.roomId as string

  // 新客户端尝试 rejoin
  const guest = await createClient()
  send(guest.ws, { type: 'rejoin-room', roomId, playerName: 'RejoiningGuest' })
  const joined = await waitMsg(guest.ws, 'room-joined')
  assert(joined.roomId === roomId, 'Rejoined same room')
  assert(Array.isArray(joined.peers), 'Received peers list')

  host.ws.close()
  guest.ws.close()
}

async function test10_healthEndpoint() {
  console.log('\n🩺 Test 10: 健康检查端点')
  try {
    const { status, body } = await httpGet('/health')
    assert(status === 200, `HTTP 200`)
    assert(body.status === 'ok', 'Status is ok')
    assert(typeof body.uptime === 'number', `Uptime: ${body.uptime}s`)
    assert(typeof body.rooms === 'number', `Rooms: ${body.rooms}`)
    assert(typeof body.peers === 'number', `Peers: ${body.peers}`)
  } catch (err: unknown) {
    assert(false, `Health check failed: ${err instanceof Error ? err.message : err}`)
  }
}

async function run() {
  console.log(`\n🧪 E2E 测试 — 信令服务器`)
  console.log(`   目标: ${SERVER_URL}\n`)

  try {
    await test1_connect()
    await test2_createRoom()
    await test3_joinRoom()
    await test4_sdpRelay()
    await test5_iceRelay()
    await test6_leaveRoom()
    await test7_hostLeave()
    await test8_turnCredentials()
    await test9_rejoin()
    await test10_healthEndpoint()
  } catch (err) {
    console.error(`\n💀 Fatal error: ${err instanceof Error ? err.message : err}`)
    failed++
  }

  console.log(`\n${'='.repeat(40)}`)
  console.log(`✅ Passed: ${passed}`)
  console.log(`❌ Failed: ${failed}`)
  console.log(`${'='.repeat(40)}\n`)

  process.exit(failed > 0 ? 1 : 0)
}

run()
