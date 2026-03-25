import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { GameProfile, JvmArgs, ModLoaderInfo, VersionIsolationMode } from '../../src/types'
import { getDefaultJvmArgs } from '../../src/types'
import { getDefaultMinecraftDir } from './platform'
import { loadSettings } from './settings-store'
import { parseStoreJson } from './store-utils'

const store = new Store<{ profiles: GameProfile[] }>({
  name: 'profiles',
  defaults: { profiles: [] },
  deserialize: (value) => parseStoreJson<{ profiles: GameProfile[] }>(value)
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

function looksLikeEmbeddedInstanceDir(dirPath: string): boolean {
  const markers = [
    'mods',
    'config',
    'options.txt',
    'saves',
    'resourcepacks',
    'shaderpacks',
    'PCL',
    'launcher_profiles.json'
  ]
  return markers.some(marker => fs.existsSync(path.join(dirPath, marker)))
}

function parseScannedVersion(versionId: string, raw: any): { name: string; modLoader?: ModLoaderInfo } {
  let modLoader: ModLoaderInfo | undefined
  let displayName = versionId

  if (raw?.inheritsFrom) {
    const id = String(raw.id || versionId).toLowerCase()
    const parentVersion = String(raw.inheritsFrom)
    if (id.includes('fabric')) {
      modLoader = { type: 'fabric', version: String(raw.id || versionId) }
      displayName = `${parentVersion} Fabric`
    } else if (id.includes('neoforge')) {
      modLoader = { type: 'neoforge', version: String(raw.id || versionId) }
      displayName = `${parentVersion} NeoForge`
    } else if (id.includes('forge')) {
      modLoader = { type: 'forge', version: String(raw.id || versionId) }
      displayName = `${parentVersion} Forge`
    } else if (id.includes('quilt')) {
      modLoader = { type: 'quilt', version: String(raw.id || versionId) }
      displayName = `${parentVersion} Quilt`
    } else {
      displayName = parentVersion ? `${parentVersion} (${versionId})` : versionId
    }
  }

  return { name: displayName, modLoader }
}

function readVersionDescriptor(gameDir: string, versionId: string): { name: string; modLoader?: ModLoaderInfo } | null {
  const jsonFile = path.join(gameDir, 'versions', versionId, `${versionId}.json`)
  if (!fs.existsSync(jsonFile)) return null

  try {
    const raw = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'))
    return parseScannedVersion(versionId, raw)
  } catch {
    return { name: versionId }
  }
}

function createScannedProfile(gameDir: string, versionId: string, name: string, modLoader?: ModLoaderInfo): GameProfile {
  return {
    id: randomUUID(),
    name,
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
}

function scanVersionEntries(gameDir: string, existingKeys: Set<string>): GameProfile[] {
  const versionsDir = path.join(gameDir, 'versions')
  if (!fs.existsSync(versionsDir)) return []

  const added: GameProfile[] = []
  const entries = fs.readdirSync(versionsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const versionId = entry.name
    const versionInfo = readVersionDescriptor(gameDir, versionId)
    if (!versionInfo) continue

    const versionDir = path.join(versionsDir, versionId)
    const scannedGameDir = looksLikeEmbeddedInstanceDir(versionDir) ? versionDir : gameDir

    const key = `${scannedGameDir}|${versionId}`
    if (existingKeys.has(key)) continue

    added.push(createScannedProfile(scannedGameDir, versionId, versionInfo.name, versionInfo.modLoader))
    existingKeys.add(key)
  }

  return added
}

function resolveLegacyEmbeddedInstanceDir(profile: GameProfile): string | null {
  const rootDir = profile.baseGameDir || profile.gameDir
  if (!rootDir) return null

  const currentDir = profile.gameDir
  const directVersionDir = path.join(rootDir, 'versions', profile.versionId)
  if (directVersionDir !== currentDir && looksLikeEmbeddedInstanceDir(directVersionDir)) {
    return directVersionDir
  }

  return null
}

function readLauncherPreferredVersion(gameDir: string): { versionId: string; name?: string } | null {
  const launcherProfilesPath = path.join(gameDir, 'launcher_profiles.json')
  if (!fs.existsSync(launcherProfilesPath)) return null

  try {
    const raw = JSON.parse(fs.readFileSync(launcherProfilesPath, 'utf-8')) as {
      selectedProfile?: string
      profiles?: Record<string, { name?: string; lastVersionId?: string }>
    }
    const profiles = raw.profiles || {}
    const selected = raw.selectedProfile ? profiles[raw.selectedProfile] : undefined
    const fallback = Object.values(profiles).find(profile => typeof profile?.lastVersionId === 'string' && profile.lastVersionId.trim())
    const preferred = selected && selected.lastVersionId ? selected : fallback
    if (!preferred?.lastVersionId) return null

    return {
      versionId: preferred.lastVersionId,
      name: preferred.name?.trim() || undefined
    }
  } catch {
    return null
  }
}

function scanLauncherInstanceDir(instanceDir: string, existingKeys: Set<string>): GameProfile[] {
  const preferred = readLauncherPreferredVersion(instanceDir)
  if (!preferred) {
    return scanVersionEntries(instanceDir, existingKeys)
  }

  const key = `${instanceDir}|${preferred.versionId}`
  if (existingKeys.has(key)) return []

  const versionInfo = readVersionDescriptor(instanceDir, preferred.versionId)
  if (!versionInfo) return scanVersionEntries(instanceDir, existingKeys)

  const instanceName = preferred.name || sanitizeDirName(path.basename(instanceDir)) || preferred.versionId
  existingKeys.add(key)
  return [createScannedProfile(instanceDir, preferred.versionId, instanceName, versionInfo.modLoader)]
}

function normalizeProfile(profile: GameProfile): GameProfile {
  const settings = loadSettings()
  const migratedBaseGameDir = resolveLegacyEmbeddedInstanceDir(profile) || profile.baseGameDir || profile.gameDir || getDefaultMinecraftDir()
  const baseGameDir = migratedBaseGameDir
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
  const existing = store.get('profiles')
  const existingKeys = new Set(existing.map(p => `${p.gameDir}|${p.versionId}`))
  const added: GameProfile[] = []

  added.push(...scanVersionEntries(gameDir, existingKeys))

  const instancesDir = path.join(gameDir, 'instances')
  if (fs.existsSync(instancesDir)) {
    const instanceEntries = fs.readdirSync(instancesDir, { withFileTypes: true })
    for (const entry of instanceEntries) {
      if (!entry.isDirectory()) continue
      const instanceDir = path.join(instancesDir, entry.name)
      if (!fs.existsSync(path.join(instanceDir, 'versions'))) continue
      added.push(...scanLauncherInstanceDir(instanceDir, existingKeys))
    }
  }

  if (added.length > 0) {
    const profiles = getAllProfiles()
    profiles.push(...added)
    saveProfiles(profiles)
  }

  return added
}
