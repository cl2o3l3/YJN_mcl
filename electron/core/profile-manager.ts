import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { GameProfile, JvmArgs, ModLoaderInfo, VersionIsolationMode } from '../../src/types'
import { getDefaultJvmArgs } from '../../src/types'
import { getDefaultMinecraftDir } from './platform'
import { loadSettings } from './settings-store'

const store = new Store<{ profiles: GameProfile[] }>({
  name: 'profiles',
  defaults: { profiles: [] }
})

function sanitizeDirName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 60) || 'instance'
}

function isIsolationEnabled(mode: VersionIsolationMode | undefined, fallback: boolean): boolean {
  if (mode === 'enabled') return true
  if (mode === 'disabled') return false
  return fallback
}

function buildIsolatedGameDir(baseGameDir: string, profileId: string, profileName: string): string {
  return path.join(baseGameDir, 'instances', `${sanitizeDirName(profileName)}-${profileId.slice(0, 8)}`)
}

function normalizeProfile(profile: GameProfile): GameProfile {
  const settings = loadSettings()
  const baseGameDir = profile.baseGameDir || profile.gameDir || getDefaultMinecraftDir()
  const versionIsolation: VersionIsolationMode = profile.versionIsolation || (profile.baseGameDir ? 'inherit' : 'disabled')
  const gameDir = isIsolationEnabled(versionIsolation, settings.defaultVersionIsolation)
    ? buildIsolatedGameDir(baseGameDir, profile.id, profile.name)
    : baseGameDir

  return {
    ...profile,
    baseGameDir,
    versionIsolation,
    gameDir,
  }
}

function saveProfiles(profiles: GameProfile[]): void {
  store.set('profiles', profiles.map(normalizeProfile))
}

/** 获取所有实例 */
export function getAllProfiles(): GameProfile[] {
  const profiles = store.get('profiles')
  const normalized = profiles.map(normalizeProfile)
  if (JSON.stringify(profiles) !== JSON.stringify(normalized)) {
    store.set('profiles', normalized)
  }
  return normalized
}

/** 按 ID 获取 */
export function getProfile(id: string): GameProfile | undefined {
  return getAllProfiles().find(p => p.id === id)
}

/** 创建新实例 */
export function createProfile(opts: {
  name: string
  versionId: string
  gameDir?: string
  baseGameDir?: string
  versionIsolation?: VersionIsolationMode
  javaPath?: string
  jvmArgs?: Partial<JvmArgs>
  modLoader?: ModLoaderInfo
  accountId?: string
  iconPath?: string
  windowWidth?: number
  windowHeight?: number
  tags?: string[]
}): GameProfile {
  const settings = loadSettings()
  const id = randomUUID()
  const baseGameDir = opts.baseGameDir || opts.gameDir || getDefaultMinecraftDir()
  const versionIsolation: VersionIsolationMode = opts.versionIsolation || 'inherit'
  const gameDir = isIsolationEnabled(versionIsolation, settings.defaultVersionIsolation)
    ? buildIsolatedGameDir(baseGameDir, id, opts.name)
    : baseGameDir

  const profile: GameProfile = {
    id,
    name: opts.name,
    gameDir,
    baseGameDir,
    versionIsolation,
    versionId: opts.versionId,
    modLoader: opts.modLoader,
    javaPath: opts.javaPath || '',
    jvmArgs: { ...getDefaultJvmArgs(), ...opts.jvmArgs },
    windowWidth: opts.windowWidth || 1280,
    windowHeight: opts.windowHeight || 720,
    accountId: opts.accountId || '',
    createdAt: Date.now(),
    iconPath: opts.iconPath,
    tags: opts.tags
  }

  const profiles = getAllProfiles()
  profiles.push(profile)
  saveProfiles(profiles)
  return profile
}

/** 更新实例 */
export function updateProfile(id: string, updates: Partial<GameProfile>): GameProfile | null {
  const profiles = getAllProfiles()
  const index = profiles.findIndex(p => p.id === id)
  if (index === -1) return null

  profiles[index] = normalizeProfile({ ...profiles[index], ...updates })
  saveProfiles(profiles)
  return profiles[index]
}

/** 删除实例 */
export function deleteProfile(id: string): boolean {
  const profiles = getAllProfiles()
  const filtered = profiles.filter(p => p.id !== id)
  if (filtered.length === profiles.length) return false
  saveProfiles(filtered)
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
    baseGameDir: source.baseGameDir || source.gameDir,
    versionIsolation: source.versionIsolation,
    javaPath: source.javaPath,
    jvmArgs: { ...source.jvmArgs },
    modLoader: source.modLoader ? { ...source.modLoader } : undefined,
    accountId: source.accountId,
    windowWidth: source.windowWidth,
    windowHeight: source.windowHeight,
    iconPath: source.iconPath,
    tags: source.tags ? [...source.tags] : undefined
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
      baseGameDir: gameDir,
      versionIsolation: 'disabled',
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
    const profiles = getAllProfiles()
    profiles.push(...added)
    saveProfiles(profiles)
  }

  return added
}
