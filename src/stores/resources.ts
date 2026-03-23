import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  ResourceSearchParams, ResourceSearchResult, ResourceProject,
  ResourceVersion, ResourceType, ResourcePlatform, InstalledResource
} from '../types'
import { useProfilesStore } from './profiles'

export const useResourcesStore = defineStore('resources', () => {
  // 搜索状态
  const searchPlatform = ref<ResourcePlatform>('modrinth')
  const searchQuery = ref('')
  const searchType = ref<ResourceType | ''>('')
  const searchGameVersion = ref('')
  const searchLoader = ref('')
  const searchCategories = ref<string[]>([])
  const searchSort = ref<ResourceSearchParams['sortBy']>('relevance')
  const searchPage = ref(0)
  const searchPageSize = ref(20)
  const searchLoading = ref(false)
  const searchResult = ref<ResourceSearchResult | null>(null)

  // 详情状态
  const currentProject = ref<ResourceProject | null>(null)
  const currentVersions = ref<ResourceVersion[]>([])
  const detailLoading = ref(false)

  // 已安装
  const installedList = ref<InstalledResource[]>([])
  const installedLoading = ref(false)

  // 安装进度
  const installingFiles = ref<Set<string>>(new Set())

  // 根据当前 profile 预填筛选条件
  const profiles = useProfilesStore()
  const autoGameVersion = computed(() => profiles.selected?.versionId || '')
  const autoLoader = computed(() => profiles.selected?.modLoader?.type || '')

  /** 执行搜索 */
  async function search(resetPage = true) {
    if (resetPage) searchPage.value = 0
    searchLoading.value = true
    try {
      const params: ResourceSearchParams = {
        query: searchQuery.value,
        type: searchType.value || undefined,
        gameVersion: searchGameVersion.value || undefined,
        loader: searchLoader.value || undefined,
        categories: searchCategories.value.length > 0 ? [...searchCategories.value] : undefined,
        sortBy: searchSort.value,
        page: searchPage.value,
        pageSize: searchPageSize.value,
        platform: searchPlatform.value
      }
      searchResult.value = await window.api.resources.search(params)
    } finally {
      searchLoading.value = false
    }
  }

  /** 加载项目详情 + 版本列表 */
  async function loadDetail(platform: ResourcePlatform, projectId: string) {
    detailLoading.value = true
    currentProject.value = null
    currentVersions.value = []
    try {
      const [project, versions] = await Promise.all([
        window.api.resources.detail(platform, projectId),
        window.api.resources.versions(
          platform,
          projectId,
          searchLoader.value ? [searchLoader.value] : undefined,
          searchGameVersion.value ? [searchGameVersion.value] : undefined
        )
      ])
      currentProject.value = project
      currentVersions.value = versions
    } finally {
      detailLoading.value = false
    }
  }

  /** 安装资源文件 */
  async function install(
    file: { url: string; filename: string; size: number; sha1?: string; sha512?: string; primary: boolean },
    type: ResourceType,
    gameDir: string,
    meta: { projectId: string; platform: ResourcePlatform; versionId: string; versionNumber: string; title: string }
  ) {
    installingFiles.value.add(file.filename)
    try {
      await window.api.resources.install(file, type, gameDir, meta)
    } finally {
      installingFiles.value.delete(file.filename)
    }
  }

  /** 加载已安装资源列表 */
  async function loadInstalled(type: ResourceType, gameDir: string) {
    installedLoading.value = true
    try {
      installedList.value = await window.api.resources.installed(type, gameDir)
    } finally {
      installedLoading.value = false
    }
  }

  /** 删除已安装资源 */
  async function remove(type: ResourceType, gameDir: string, filename: string) {
    await window.api.resources.remove(type, gameDir, filename)
    installedList.value = installedList.value.filter(r => r.filename !== filename)
  }

  /** 启用/禁用已安装资源 */
  async function toggle(type: ResourceType, gameDir: string, filename: string, enabled: boolean) {
    await window.api.resources.toggle(type, gameDir, filename, enabled)
    const item = installedList.value.find(r => r.filename === filename && r.type === type)
    if (item) item.enabled = enabled
  }

  /** 翻页 */
  function nextPage() {
    if (!searchResult.value) return
    const totalPages = Math.ceil(searchResult.value.total / searchResult.value.pageSize)
    if (searchPage.value < totalPages - 1) {
      searchPage.value++
      search(false)
    }
  }

  function prevPage() {
    if (searchPage.value > 0) {
      searchPage.value--
      search(false)
    }
  }

  return {
    // 搜索
    searchPlatform, searchQuery, searchType, searchGameVersion, searchLoader, searchCategories,
    searchSort, searchPage, searchPageSize, searchLoading, searchResult,
    // 详情
    currentProject, currentVersions, detailLoading,
    // 已安装
    installedList, installedLoading,
    // 安装进度
    installingFiles,
    // 自动填充
    autoGameVersion, autoLoader,
    // Actions
    search, loadDetail, install, loadInstalled, remove, toggle,
    nextPage, prevPage
  }
})
