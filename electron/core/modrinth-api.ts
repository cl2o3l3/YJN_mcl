import { net } from 'electron'
import type {
  ResourceSearchParams, ResourceProject, ResourceVersion,
  ResourceSearchResult, ResourceType
} from '../../src/types'

const BASE = 'https://api.modrinth.com/v2'
const USER_AGENT = 'MCLauncher/1.0.0 (electron-mc-launcher)'

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

// ========== HTTP 工具 ==========

async function modrinthFetch<T>(endpoint: string): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${BASE}${endpoint}`
  const resp = await net.fetch(url, {
    headers: { 'User-Agent': USER_AGENT }
  })
  if (!resp.ok) {
    throw new Error(`Modrinth API error: ${resp.status} ${await resp.text()}`)
  }
  return resp.json() as Promise<T>
}

// ========== Modrinth → 统一类型映射 ==========

function mapProjectType(pt: string): ResourceType {
  switch (pt) {
    case 'mod': return 'mod'
    case 'shader': return 'shader'
    case 'resourcepack': return 'resourcepack'
    case 'modpack': return 'modpack'
    default: return 'mod'
  }
}

interface ModrinthHit {
  project_id: string
  project_type: string
  title: string
  description: string
  author: string
  icon_url: string
  downloads: number
  follows: number
  date_modified: string
  slug: string
  categories: string[]
  versions: string[]
  display_categories: string[]
}

interface ModrinthSearchResponse {
  hits: ModrinthHit[]
  offset: number
  limit: number
  total_hits: number
}

function mapHitToProject(h: ModrinthHit): ResourceProject {
  return {
    id: h.project_id,
    platform: 'modrinth',
    type: mapProjectType(h.project_type),
    title: h.title,
    description: h.description,
    author: h.author,
    iconUrl: h.icon_url || '',
    downloads: h.downloads,
    follows: h.follows,
    lastUpdated: h.date_modified,
    slug: h.slug,
    categories: h.display_categories || h.categories || [],
    gameVersions: h.versions || [],
    loaders: (h.categories || []).filter(c =>
      ['fabric', 'forge', 'neoforge', 'quilt'].includes(c)
    )
  }
}

interface ModrinthProject {
  id: string
  project_type: string
  title: string
  description: string
  body: string
  icon_url: string
  downloads: number
  followers: number
  updated: string
  slug: string
  categories: string[]
  game_versions: string[]
  loaders: string[]
  team: string
}

interface ModrinthTeamMember {
  user: { username: string }
  role: string
}

interface ModrinthVersion {
  id: string
  project_id: string
  name: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  version_type: 'release' | 'beta' | 'alpha'
  files: {
    url: string
    filename: string
    size: number
    hashes: { sha1?: string; sha512?: string }
    primary: boolean
  }[]
  dependencies: {
    project_id: string | null
    version_id: string | null
    dependency_type: string
  }[]
  date_published: string
  downloads: number
}

function mapVersion(v: ModrinthVersion): ResourceVersion {
  return {
    id: v.id,
    projectId: v.project_id,
    name: v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions,
    loaders: v.loaders,
    releaseType: v.version_type,
    files: v.files.map(f => ({
      url: f.url,
      filename: f.filename,
      size: f.size,
      sha1: f.hashes.sha1,
      sha512: f.hashes.sha512,
      primary: f.primary
    })),
    dependencies: v.dependencies
      .filter(d => d.project_id)
      .map(d => ({
        projectId: d.project_id!,
        versionId: d.version_id || undefined,
        dependencyType: d.dependency_type as 'required' | 'optional' | 'incompatible' | 'embedded'
      })),
    datePublished: v.date_published,
    downloads: v.downloads
  }
}

// ========== 公开 API ==========

/** 搜索项目 */
export async function searchProjects(params: ResourceSearchParams): Promise<ResourceSearchResult> {
  const facets: string[][] = []
  if (params.type) {
    facets.push([`project_type:${params.type}`])
  }
  if (params.gameVersion) {
    facets.push([`versions:${params.gameVersion}`])
  }
  if (params.loader) {
    facets.push([`categories:${params.loader}`])
  }
  if (params.categories?.length) {
    facets.push(params.categories.map(cat => `categories:${cat}`))
  }

  const page = params.page ?? 0
  const pageSize = params.pageSize ?? 20

  const qs = new URLSearchParams()
  if (params.query) qs.set('query', params.query)
  if (facets.length > 0) {
    qs.set('facets', JSON.stringify(facets))
  }
  qs.set('limit', String(pageSize))
  qs.set('offset', String(page * pageSize))
  qs.set('index', params.sortBy || 'relevance')

  const cacheKey = `search:${qs.toString()}`
  const cached = getCached<ResourceSearchResult>(cacheKey)
  if (cached) { return cached }

  const data = await modrinthFetch<ModrinthSearchResponse>(`/search?${qs}`)

  const result: ResourceSearchResult = {
    hits: data.hits.map(mapHitToProject),
    total: data.total_hits,
    page,
    pageSize
  }
  setCache(cacheKey, result)
  return result
}

/** 获取项目详情 */
export async function getProject(idOrSlug: string): Promise<ResourceProject> {
  const cacheKey = `project:${idOrSlug}`
  const cached = getCached<ResourceProject>(cacheKey)
  if (cached) return cached

  const p = await modrinthFetch<ModrinthProject>(`/project/${encodeURIComponent(idOrSlug)}`)

  // 获取作者名 — 从 team 查
  let author = ''
  try {
    const members = await modrinthFetch<ModrinthTeamMember[]>(`/project/${encodeURIComponent(idOrSlug)}/members`)
    const owner = members.find(m => m.role === 'Owner') || members[0]
    if (owner) author = owner.user.username
  } catch {
    // ignore
  }

  const project: ResourceProject = {
    id: p.id,
    platform: 'modrinth',
    type: mapProjectType(p.project_type),
    title: p.title,
    description: p.description,
    author,
    iconUrl: p.icon_url || '',
    downloads: p.downloads,
    follows: p.followers,
    lastUpdated: p.updated,
    slug: p.slug,
    categories: p.categories,
    gameVersions: p.game_versions,
    loaders: p.loaders
  }
  setCache(cacheKey, project)
  return project
}

/** 获取项目版本列表 */
export async function getProjectVersions(
  projectId: string,
  loaders?: string[],
  gameVersions?: string[]
): Promise<ResourceVersion[]> {
  const qs = new URLSearchParams()
  if (loaders?.length) qs.set('loaders', JSON.stringify(loaders))
  if (gameVersions?.length) qs.set('game_versions', JSON.stringify(gameVersions))

  const qStr = qs.toString()
  const cacheKey = `versions:${projectId}:${qStr}`
  const cached = getCached<ResourceVersion[]>(cacheKey)
  if (cached) return cached

  const endpoint = `/project/${encodeURIComponent(projectId)}/version${qStr ? '?' + qStr : ''}`
  const data = await modrinthFetch<ModrinthVersion[]>(endpoint)

  const versions = data.map(mapVersion)
  setCache(cacheKey, versions)
  return versions
}

/** 获取单个版本详情 */
export async function getVersion(versionId: string): Promise<ResourceVersion> {
  const data = await modrinthFetch<ModrinthVersion>(`/version/${encodeURIComponent(versionId)}`)
  return mapVersion(data)
}
