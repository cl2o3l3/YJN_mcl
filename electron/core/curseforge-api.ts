import { net } from 'electron'
import type {
  ResourceSearchParams, ResourceProject, ResourceVersion,
  ResourceSearchResult, ResourceType, ResourceFile,
  ResourceDependency
} from '../../src/types'

const BASE = 'https://api.curseforge.com/v1'
const GAME_ID = 432 // Minecraft: Java Edition

// CurseForge classId 映射
const TYPE_TO_CLASS: Record<ResourceType, number> = {
  mod: 6,
  resourcepack: 12,
  shader: 6552,
  modpack: 4471,
}

const CLASS_TO_TYPE: Record<number, ResourceType> = {
  6: 'mod',
  12: 'resourcepack',
  6552: 'shader',
  4471: 'modpack',
}

// ========== 内存缓存 (10 分钟) ==========
const cache = new Map<string, { data: unknown; ts: number }>()
const CACHE_TTL = 10 * 60 * 1000

function getCached<T>(key: string): T | null {
  const entry = cache.get(key)
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data as T
  if (entry) cache.delete(key)
  return null
}

function setCache(key: string, data: unknown) {
  cache.set(key, { data, ts: Date.now() })
}

// ========== API Key ==========

let apiKey = ''

export function setCurseForgeApiKey(key: string) {
  apiKey = key
}

export function getCurseForgeApiKey(): string {
  return apiKey
}

// ========== HTTP 工具 ==========

async function cfFetch<T>(endpoint: string): Promise<T> {
  if (!apiKey) throw new Error('CurseForge API key not configured')
  const url = endpoint.startsWith('http') ? endpoint : `${BASE}${endpoint}`
  const resp = await net.fetch(url, {
    headers: {
      'x-api-key': apiKey,
      'Accept': 'application/json',
    }
  })
  if (!resp.ok) {
    throw new Error(`CurseForge API error: ${resp.status} ${await resp.text()}`)
  }
  return resp.json() as Promise<T>
}

// ========== CurseForge → 统一类型映射 ==========

interface CfMod {
  id: number
  name: string
  slug: string
  summary: string
  classId: number
  logo?: { url: string }
  downloadCount: number
  thumbsUpCount: number
  dateModified: string
  authors: { name: string }[]
  categories: { name: string }[]
  latestFilesIndexes: { gameVersion: string; modLoader?: number }[]
}

interface CfFile {
  id: number
  modId: number
  displayName: string
  fileName: string
  fileLength: number
  dateCreated: string
  downloadUrl: string | null
  releaseType: number // 1=release 2=beta 3=alpha
  gameVersions: string[]
  sortableGameVersions: { gameVersion: string; gameVersionName: string }[]
  dependencies: { modId: number; relationType: number }[]
  hashes: { value: string; algo: number }[] // 1=sha1, 2=md5
  isServerPack: boolean
}

// ModLoader enum from CF API
const CF_LOADER_MAP: Record<number, string> = {
  1: 'forge',
  2: 'cauldron',
  3: 'liteloader',
  4: 'fabric',
  5: 'quilt',
  6: 'neoforge',
}

function mapCfModToProject(mod: CfMod): ResourceProject {
  const loaderSet = new Set<string>()
  const versionSet = new Set<string>()
  for (const idx of mod.latestFilesIndexes) {
    if (idx.gameVersion) versionSet.add(idx.gameVersion)
    if (idx.modLoader !== undefined && CF_LOADER_MAP[idx.modLoader]) {
      loaderSet.add(CF_LOADER_MAP[idx.modLoader])
    }
  }

  return {
    id: String(mod.id),
    platform: 'curseforge',
    type: CLASS_TO_TYPE[mod.classId] || 'mod',
    title: mod.name,
    description: mod.summary,
    author: mod.authors?.[0]?.name || '',
    iconUrl: mod.logo?.url || '',
    downloads: mod.downloadCount,
    follows: mod.thumbsUpCount,
    lastUpdated: mod.dateModified,
    slug: mod.slug,
    categories: mod.categories?.map(c => c.name) || [],
    gameVersions: [...versionSet],
    loaders: [...loaderSet],
  }
}

function mapCfFileToVersion(file: CfFile): ResourceVersion {
  const loaderSet = new Set<string>()
  const gameVersions: string[] = []

  for (const gv of file.gameVersions) {
    const lower = gv.toLowerCase()
    // CurseForge puts loader names in gameVersions array
    if (['forge', 'fabric', 'quilt', 'neoforge'].includes(lower)) {
      loaderSet.add(lower)
    } else {
      gameVersions.push(gv)
    }
  }

  const files: ResourceFile[] = []
  if (file.downloadUrl) {
    const sha1 = file.hashes.find(h => h.algo === 1)?.value
    files.push({
      url: file.downloadUrl,
      filename: file.fileName,
      size: file.fileLength,
      sha1,
      primary: true,
    })
  }

  const releaseMap: Record<number, 'release' | 'beta' | 'alpha'> = {
    1: 'release', 2: 'beta', 3: 'alpha'
  }

  const deps: ResourceDependency[] = file.dependencies
    .filter(d => d.relationType <= 3) // 1=embedded 2=optional 3=required
    .map(d => ({
      projectId: String(d.modId),
      dependencyType: d.relationType === 3 ? 'required' as const
        : d.relationType === 2 ? 'optional' as const
        : 'embedded' as const,
    }))

  return {
    id: String(file.id),
    projectId: String(file.modId),
    name: file.displayName,
    versionNumber: file.fileName.replace(/\.jar$/, ''),
    gameVersions,
    loaders: [...loaderSet],
    releaseType: releaseMap[file.releaseType] || 'release',
    files,
    dependencies: deps,
    datePublished: file.dateCreated,
    downloads: 0, // CF doesn't provide per-file downloads in this endpoint
  }
}

// ========== 公开 API ==========

export async function searchProjects(params: ResourceSearchParams): Promise<ResourceSearchResult> {
  const page = params.page ?? 0
  const pageSize = params.pageSize ?? 20

  const qs = new URLSearchParams()
  qs.set('gameId', String(GAME_ID))
  qs.set('searchFilter', params.query || '')
  qs.set('index', String(page * pageSize))
  qs.set('pageSize', String(pageSize))

  if (params.type) {
    qs.set('classId', String(TYPE_TO_CLASS[params.type] || 6))
  }

  if (params.gameVersion) {
    qs.set('gameVersion', params.gameVersion)
  }

  if (params.loader) {
    const loaderIdx = Object.entries(CF_LOADER_MAP).find(([, v]) => v === params.loader)?.[0]
    if (loaderIdx) qs.set('modLoaderType', loaderIdx)
  }

  // Sort
  const sortMap: Record<string, number> = {
    relevance: 1, downloads: 6, updated: 3, newest: 11, follows: 2
  }
  qs.set('sortField', String(sortMap[params.sortBy || 'relevance'] || 1))
  qs.set('sortOrder', 'desc')

  const cacheKey = `cf:search:${qs.toString()}`
  const cached = getCached<ResourceSearchResult>(cacheKey)
  if (cached) return cached

  const data = await cfFetch<{ data: CfMod[]; pagination: { totalCount: number } }>(`/mods/search?${qs}`)

  const result: ResourceSearchResult = {
    hits: data.data.map(mapCfModToProject),
    total: data.pagination.totalCount,
    page,
    pageSize,
  }
  setCache(cacheKey, result)
  return result
}

export async function getProject(id: string): Promise<ResourceProject> {
  const cacheKey = `cf:mod:${id}`
  const cached = getCached<ResourceProject>(cacheKey)
  if (cached) return cached

  const data = await cfFetch<{ data: CfMod }>(`/mods/${id}`)
  const project = mapCfModToProject(data.data)
  setCache(cacheKey, project)
  return project
}

export async function getProjectVersions(
  projectId: string,
  loaders?: string[],
  gameVersions?: string[]
): Promise<ResourceVersion[]> {
  const qs = new URLSearchParams()
  if (gameVersions?.length) qs.set('gameVersion', gameVersions[0])
  if (loaders?.length) {
    const loaderIdx = Object.entries(CF_LOADER_MAP).find(([, v]) => v === loaders[0])?.[0]
    if (loaderIdx) qs.set('modLoaderType', loaderIdx)
  }

  const cacheKey = `cf:files:${projectId}:${qs.toString()}`
  const cached = getCached<ResourceVersion[]>(cacheKey)
  if (cached) return cached

  const data = await cfFetch<{ data: CfFile[] }>(`/mods/${projectId}/files?${qs}`)
  const versions = data.data
    .filter(f => !f.isServerPack)
    .map(mapCfFileToVersion)
  setCache(cacheKey, versions)
  return versions
}

export async function getVersion(fileId: string, modId: string): Promise<ResourceVersion> {
  const data = await cfFetch<{ data: CfFile }>(`/mods/${modId}/files/${fileId}`)
  return mapCfFileToVersion(data.data)
}
