/**
 * 整合包同步服务
 * 房主通过 DataChannel 共享 mod 列表，客人对比后一键安装缺失 mod
 *
 * 协议:
 *   房主 → 客人:  __MOD_SYNC:<json>  (InstalledResource[] 序列化)
 *   客人 → 房主:  __MOD_SYNC_ACK
 */

import type { InstalledResource } from '../types'

export interface ModSyncDiff {
  missing: InstalledResource[]    // 客人缺失的
  extra: InstalledResource[]      // 客人多出的（仅告知）
  matched: InstalledResource[]    // 双方都有的
}

const SYNC_PREFIX = '__MOD_SYNC:'
const SYNC_ACK = '__MOD_SYNC_ACK'

/**
 * 将 mod 列表编码为发送消息
 */
export function encodeModList(mods: InstalledResource[]): Uint8Array {
  return new TextEncoder().encode(SYNC_PREFIX + JSON.stringify(mods))
}

/**
 * 尝试解析 mod 同步消息，非同步消息返回 null
 */
export function decodeModSyncMessage(data: Uint8Array): InstalledResource[] | null {
  const text = new TextDecoder().decode(data)
  if (!text.startsWith(SYNC_PREFIX)) return null
  try {
    return JSON.parse(text.slice(SYNC_PREFIX.length))
  } catch {
    return null
  }
}

/**
 * 判断是否是 ACK 消息
 */
export function isModSyncAck(data: Uint8Array): boolean {
  return new TextDecoder().decode(data) === SYNC_ACK
}

/**
 * 编码 ACK
 */
export function encodeModSyncAck(): Uint8Array {
  return new TextEncoder().encode(SYNC_ACK)
}

/**
 * 对比两份 mod 列表，按 projectId 匹配
 */
export function diffModLists(hostMods: InstalledResource[], guestMods: InstalledResource[]): ModSyncDiff {
  const guestMap = new Map(guestMods.map(m => [m.projectId, m]))
  const hostMap = new Map(hostMods.map(m => [m.projectId, m]))

  const missing: InstalledResource[] = []
  const matched: InstalledResource[] = []
  const extra: InstalledResource[] = []

  for (const mod of hostMods) {
    if (guestMap.has(mod.projectId)) {
      matched.push(mod)
    } else {
      missing.push(mod)
    }
  }

  for (const mod of guestMods) {
    if (!hostMap.has(mod.projectId)) {
      extra.push(mod)
    }
  }

  return { missing, extra, matched }
}
