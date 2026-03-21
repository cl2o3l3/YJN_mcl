import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { GameProfile, JvmArgs, ModLoaderInfo } from '../../src/types'
import { getDefaultJvmArgs } from '../../src/types'
import { getDefaultMinecraftDir } from './platform'

const store = new Store<{ profiles: GameProfile[] }>({
  name: 'profiles',
  defaults: { profiles: [] }
})

/** 获取所有实例 */
export function getAllProfiles(): GameProfile[] {
  return store.get('profiles')
}

/** 按 ID 获取 */
export function getProfile(id: string): GameProfile | undefined {
  return store.get('profiles').find(p => p.id === id)
}

/** 创建新实例 */
export function createProfile(opts: {
  name: string
  versionId: string
  gameDir?: string
  javaPath?: string
  jvmArgs?: Partial<JvmArgs>
  modLoader?: ModLoaderInfo
  accountId?: string
  iconPath?: string
}): GameProfile {
  const profile: GameProfile = {
    id: randomUUID(),
    name: opts.name,
    gameDir: opts.gameDir || getDefaultMinecraftDir(),
    versionId: opts.versionId,
    modLoader: opts.modLoader,
    javaPath: opts.javaPath || '',
    jvmArgs: { ...getDefaultJvmArgs(), ...opts.jvmArgs },
    windowWidth: 1280,
    windowHeight: 720,
    accountId: opts.accountId || '',
    createdAt: Date.now(),
    iconPath: opts.iconPath
  }

  const profiles = store.get('profiles')
  profiles.push(profile)
  store.set('profiles', profiles)
  return profile
}

/** 更新实例 */
export function updateProfile(id: string, updates: Partial<GameProfile>): GameProfile | null {
  const profiles = store.get('profiles')
  const index = profiles.findIndex(p => p.id === id)
  if (index === -1) return null

  profiles[index] = { ...profiles[index], ...updates }
  store.set('profiles', profiles)
  return profiles[index]
}

/** 删除实例 */
export function deleteProfile(id: string): boolean {
  const profiles = store.get('profiles')
  const filtered = profiles.filter(p => p.id !== id)
  if (filtered.length === profiles.length) return false
  store.set('profiles', filtered)
  return true
}

/** 复制实例 */
export function duplicateProfile(id: string): GameProfile | null {
  const source = getProfile(id)
  if (!source) return null

  return createProfile({
    name: `${source.name} (副本)`,
    versionId: source.versionId,
    gameDir: source.gameDir,
    javaPath: source.javaPath,
    jvmArgs: { ...source.jvmArgs },
    modLoader: source.modLoader ? { ...source.modLoader } : undefined,
    accountId: source.accountId
  })
}

/** 扫描游戏目录，为发现的已安装版本自动创建实例（跳过已有的） */
export function scanGameDir(gameDir: string): GameProfile[] {
  const versionsDir = path.join(gameDir, 'versions')
  if (!fs.existsSync(versionsDir)) return []

  const existing = store.get('profiles')
  const existingKeys = new Set(existing.map(p => `${p.gameDir}|${p.versionId}`))
  const added: GameProfile[] = []

  const entries = fs.readdirSync(versionsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const versionId = entry.name
    const jsonFile = path.join(versionsDir, versionId, `${versionId}.json`)
    if (!fs.existsSync(jsonFile)) continue

    const key = `${gameDir}|${versionId}`
    if (existingKeys.has(key)) continue

    // 尝试读取 version JSON 来判断 modloader
    let modLoader: ModLoaderInfo | undefined
    let displayName = versionId
    try {
      const raw = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'))
      if (raw.inheritsFrom) {
        // 有继承关系 → 带 modloader 的版本
        const id = (raw.id || versionId).toLowerCase()
        if (id.includes('fabric')) {
          modLoader = { type: 'fabric', version: raw.id || versionId }
          displayName = `${raw.inheritsFrom} Fabric`
        } else if (id.includes('neoforge')) {
          modLoader = { type: 'neoforge', version: raw.id || versionId }
          displayName = `${raw.inheritsFrom} NeoForge`
        } else if (id.includes('forge')) {
          modLoader = { type: 'forge', version: raw.id || versionId }
          displayName = `${raw.inheritsFrom} Forge`
        } else if (id.includes('quilt')) {
          modLoader = { type: 'quilt', version: raw.id || versionId }
          displayName = `${raw.inheritsFrom} Quilt`
        } else {
          displayName = raw.inheritsFrom ? `${raw.inheritsFrom} (${versionId})` : versionId
        }
      }
    } catch { /* ignore parse errors */ }

    const profile: GameProfile = {
      id: randomUUID(),
      name: displayName,
      gameDir,
      versionId,
      modLoader,
      javaPath: '',
      jvmArgs: getDefaultJvmArgs(),
      windowWidth: 1280,
      windowHeight: 720,
      accountId: '',
      createdAt: Date.now()
    }
    added.push(profile)
    existingKeys.add(key)
  }

  if (added.length > 0) {
    const profiles = store.get('profiles')
    profiles.push(...added)
    store.set('profiles', profiles)
  }

  return added
}
