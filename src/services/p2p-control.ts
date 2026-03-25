const MAGIC = new Uint8Array([0x59, 0x4a, 0x4e, 0x01])

export type P2PControlType =
  | 'mc-lan-ready'
  | 'proxy-failed'
  | 'rtt-ping'
  | 'rtt-pong'
  | 'mod-sync'
  | 'mod-sync-ack'
  | 'world-meta'
  | 'client-ready'

export interface P2PControlMessage<T = unknown> {
  type: P2PControlType
  payload?: T
}

export function encodeP2PControl<T = unknown>(type: P2PControlType, payload?: T): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify({ type, payload }))
  const result = new Uint8Array(MAGIC.length + body.length)
  result.set(MAGIC, 0)
  result.set(body, MAGIC.length)
  return result
}

export function decodeP2PControl(data: Uint8Array): P2PControlMessage | null {
  if (data.length <= MAGIC.length) return null
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (data[index] !== MAGIC[index]) return null
  }

  try {
    const text = new TextDecoder().decode(data.subarray(MAGIC.length))
    const parsed = JSON.parse(text) as P2PControlMessage
    if (!parsed?.type) return null
    return parsed
  } catch {
    return null
  }
}