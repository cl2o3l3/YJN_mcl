/**
 * 手动交换模式 - 无需信令服务器
 * 通过复制粘贴压缩的 SDP 邀请码/应答码完成 WebRTC 连接
 * 支持 TURN 凭据自动获取，解决校园网对校园网
 */

// TURN 凭据下发接口 (Cloudflare Worker)
const DEFAULT_TURN_API = 'https://holy-bar-abea.a850479263.workers.dev/turn-credentials'

export interface ManualOffer {
  offerCode: string
  pc: RTCPeerConnection
  dc: RTCDataChannel
  applyAnswer: (answerCode: string) => Promise<void>
  waitOpen: () => Promise<void>
}

export interface ManualAnswer {
  answerCode: string
  pc: RTCPeerConnection
  dc: Promise<RTCDataChannel>
}

/**
 * 从 Worker 获取 TURN 凭据
 */
export async function fetchTurnCredentials(apiUrl?: string): Promise<RTCIceServer[]> {
  const url = apiUrl || DEFAULT_TURN_API
  try {
    const resp = await fetch(url, { method: 'POST' })
    if (!resp.ok) return []
    const data = await resp.json() as { iceServers?: RTCIceServer[] }
    return data.iceServers || []
  } catch {
    return []
  }
}

/**
 * 房主: 创建邀请码
 * @param stunServers STUN 服务器列表
 * @param extraIceServers 额外的 ICE 服务器 (如 TURN)
 */
export async function createManualOffer(
  stunServers: string[],
  extraIceServers: RTCIceServer[] = []
): Promise<ManualOffer> {
  const iceServers: RTCIceServer[] = [
    ...stunServers.map(url => ({ urls: url })),
    ...extraIceServers
  ]

  const pc = new RTCPeerConnection({ iceServers })

  const dc = pc.createDataChannel('mc-tcp', { ordered: true, protocol: 'mc-tcp' })
  dc.binaryType = 'arraybuffer'

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await waitIceGathering(pc)

  const offerCode = await compressSdp(pc.localDescription!.sdp!)

  const applyAnswer = async (answerCode: string) => {
    const answerSdp = await decompressSdp(answerCode)
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
  }

  const waitOpen = () => new Promise<void>((resolve, reject) => {
    if (dc.readyState === 'open') { resolve(); return }
    const timeout = setTimeout(() => reject(new Error('DataChannel 连接超时')), 30000)
    dc.onopen = () => { clearTimeout(timeout); resolve() }
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        clearTimeout(timeout)
        reject(new Error('ICE 连接失败'))
      }
    }
  })

  return { offerCode, pc, dc, applyAnswer, waitOpen }
}

/**
 * 客人: 解析邀请码, 生成应答码
 */
/**
 * 客人: 解析邀请码, 生成应答码
 * @param offerCode 房主的邀请码
 * @param stunServers STUN 服务器列表
 * @param extraIceServers 额外的 ICE 服务器 (如 TURN)
 */
export async function acceptManualOffer(
  offerCode: string,
  stunServers: string[],
  extraIceServers: RTCIceServer[] = []
): Promise<ManualAnswer> {
  const offerSdp = await decompressSdp(offerCode)

  const iceServers: RTCIceServer[] = [
    ...stunServers.map(url => ({ urls: url })),
    ...extraIceServers
  ]

  const pc = new RTCPeerConnection({ iceServers })

  const dcPromise = new Promise<RTCDataChannel>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('DataChannel 超时')), 60000)
    pc.ondatachannel = (e) => {
      e.channel.binaryType = 'arraybuffer'
      if (e.channel.readyState === 'open') { clearTimeout(timeout); resolve(e.channel); return }
      e.channel.onopen = () => { clearTimeout(timeout); resolve(e.channel) }
    }
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        clearTimeout(timeout)
        reject(new Error('ICE 连接失败'))
      }
    }
  })

  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  await waitIceGathering(pc)

  const answerCode = await compressSdp(pc.localDescription!.sdp!)

  return { answerCode, pc, dc: dcPromise }
}

// ========== 内部工具 ==========

function waitIceGathering(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return }
    const timeout = setTimeout(resolve, 10000)
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout)
        resolve()
      }
    }
  })
}

async function compressSdp(sdp: string): Promise<string> {
  const data = new TextEncoder().encode(sdp)
  const cs = new CompressionStream('deflate-raw')
  const writer = cs.writable.getWriter()
  writer.write(data)
  writer.close()

  const chunks: Uint8Array[] = []
  const reader = cs.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }

  const total = chunks.reduce((a, c) => a + c.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { result.set(c, offset); offset += c.length }

  let binary = ''
  for (let i = 0; i < result.length; i++) binary += String.fromCharCode(result[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function decompressSdp(code: string): Promise<string> {
  let b64 = code.trim().replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='

  const binary = atob(b64)
  const data = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i)

  const ds = new DecompressionStream('deflate-raw')
  const writer = ds.writable.getWriter()
  writer.write(data)
  writer.close()

  const chunks: Uint8Array[] = []
  const reader = ds.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }

  const total = chunks.reduce((a, c) => a + c.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { result.set(c, offset); offset += c.length }

  return new TextDecoder().decode(result)
}
