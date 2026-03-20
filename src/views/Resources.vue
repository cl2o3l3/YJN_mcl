<script setup lang="ts">
import { onMounted, ref, computed, watch, nextTick } from 'vue'
import { useResourcesStore } from '../stores/resources'
import { useProfilesStore } from '../stores/profiles'
import { useVersionsStore } from '../stores/versions'
import { useTasksStore } from '../stores/tasks'
import { useNotificationsStore } from '../stores/notifications'
import ResourceCard from '../components/ResourceCard.vue'
import InstalledResources from '../components/InstalledResources.vue'
import type { ResourceProject, ResourceType, ResourceVersion, ResourceFile, GameProfile } from '../types'

const rs = useResourcesStore()
const profiles = useProfilesStore()
const versionsStore = useVersionsStore()
const tasksStore = useTasksStore()
const notifsStore = useNotificationsStore()

const tabs = ['browse', 'installed'] as const
const activeTab = ref<'browse' | 'installed'>('browse')

const typeTabs: { label: string; value: ResourceType | '' }[] = [
  { label: '全部', value: '' },
  { label: 'Mod', value: 'mod' },
  { label: '光影', value: 'shader' },
  { label: '资源包', value: 'resourcepack' },
  { label: '整合包', value: 'modpack' },
]

const sortOptions: { label: string; value: typeof rs.searchSort }[] = [
  { label: '相关度', value: 'relevance' },
  { label: '下载量', value: 'downloads' },
  { label: '最近更新', value: 'updated' },
  { label: '最新发布', value: 'newest' },
  { label: '关注数', value: 'follows' },
]

// Modrinth 按资源类型区分的标签（来自 Modrinth API /tag/category）
type Tag = { label: string; value: string }
const tagsByType: Record<string, Tag[]> = {
  '': [  // 全部 — 取各类型交集中高频的通用标签
    { label: '冒险', value: 'adventure' },
    { label: '优化', value: 'optimization' },
    { label: '科技', value: 'technology' },
    { label: '魔法', value: 'magic' },
    { label: '实用', value: 'utility' },
    { label: '装饰', value: 'decoration' },
  ],
  mod: [
    { label: '冒险', value: 'adventure' },
    { label: '装饰', value: 'decoration' },
    { label: '装备', value: 'equipment' },
    { label: '食物', value: 'food' },
    { label: '前置库', value: 'library' },
    { label: '魔法', value: 'magic' },
    { label: '生物', value: 'mobs' },
    { label: '优化', value: 'optimization' },
    { label: '存储', value: 'storage' },
    { label: '科技', value: 'technology' },
    { label: '交通', value: 'transportation' },
    { label: '实用', value: 'utility' },
    { label: '游戏机制', value: 'game-mechanics' },
    { label: '世界生成', value: 'worldgen' },
    { label: '社交', value: 'social' },
    { label: '经济', value: 'economy' },
    { label: '小游戏', value: 'minigame' },
    { label: '管理', value: 'management' },
  ],
  shader: [
    { label: '写实', value: 'realistic' },
    { label: '半写实', value: 'semi-realistic' },
    { label: '原版增强', value: 'vanilla-like' },
    { label: '卡通', value: 'cartoon' },
    { label: '高性能', value: 'performant' },
    { label: '低配', value: 'potato' },
    { label: '大气', value: 'atmosphere' },
    { label: '泛光', value: 'bloom' },
    { label: '奇幻', value: 'fantasy' },
    { label: '植被', value: 'foliage' },
    { label: '趣味', value: 'fun' },
    { label: '诡异', value: 'cursed' },
  ],
  resourcepack: [
    { label: '写实', value: 'realistic' },
    { label: '简约', value: 'simplistic' },
    { label: '主题', value: 'themed' },
    { label: '动画', value: 'animation' },
    { label: '音频', value: 'audio' },
    { label: '方块', value: 'blocks' },
    { label: '实体', value: 'entities' },
    { label: '环境', value: 'environment' },
    { label: '装备', value: 'equipment' },
    { label: 'GUI', value: 'gui' },
    { label: '物品', value: 'items' },
    { label: '模型', value: 'models' },
    { label: '字体', value: 'fonts' },
    { label: '本地化', value: 'locale' },
    { label: '实用', value: 'utility' },
    { label: '微调', value: 'tweaks' },
    { label: '模组适配', value: 'modded' },
  ],
  modpack: [
    { label: '冒险', value: 'adventure' },
    { label: '科技', value: 'technology' },
    { label: '魔法', value: 'magic' },
    { label: '优化', value: 'optimization' },
    { label: '任务', value: 'quests' },
    { label: '挑战', value: 'challenging' },
    { label: '战斗', value: 'combat' },
    { label: '联机', value: 'multiplayer' },
    { label: '轻量', value: 'lightweight' },
    { label: '整合', value: 'kitchen-sink' },
  ],
}
const currentTags = computed(() => tagsByType[rs.searchType] || tagsByType[''])

// 游戏版本下拉列表（只显示正式版）
const gameVersionOptions = computed(() =>
  versionsStore.versions
    .filter(v => v.type === 'release')
    .map(v => v.id)
)

function toggleTag(tag: string) {
  const idx = rs.searchCategories.indexOf(tag)
  if (idx >= 0) {
    rs.searchCategories.splice(idx, 1)
  } else {
    rs.searchCategories.push(tag)
  }
  collapsePanel()
  rs.search()
}

// ======== 展开状态 ========
const expandedProject = ref<ResourceProject | null>(null)
const expandLoading = ref(false)
const allVersions = ref<ResourceVersion[]>([])

// 分步选择
const selectedLoader = ref('')
const selectedGameVersion = ref('')

// ======== 安装流程 ========
const showInstancePicker = ref(false)
const matchedProfiles = ref<GameProfile[]>([])
const pendingModInstall = ref<{ version: ResourceVersion; file: ResourceFile } | null>(null)
const installNotice = ref('')

// 从 allVersions 中提取可用的 loaders
const availableLoaders = computed(() => {
  const set = new Set<string>()
  for (const v of allVersions.value) {
    for (const l of v.loaders) set.add(l)
  }
  return Array.from(set).sort()
})

// 根据选中 loader 过滤出可用的 game versions
const availableGameVersions = computed(() => {
  if (!selectedLoader.value) return []
  const set = new Set<string>()
  for (const v of allVersions.value) {
    if (v.loaders.includes(selectedLoader.value)) {
      for (const gv of v.gameVersions) set.add(gv)
    }
  }
  return Array.from(set).sort((a, b) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pb[i] || 0) - (pa[i] || 0)
      if (diff !== 0) return diff
    }
    return 0
  })
})

// 根据选中 loader + game version 过滤出可用的 mod 版本
const filteredVersions = computed(() => {
  if (!selectedLoader.value || !selectedGameVersion.value) return []
  return allVersions.value.filter(v =>
    v.loaders.includes(selectedLoader.value) &&
    v.gameVersions.includes(selectedGameVersion.value)
  )
})

// 依赖
const deps = ref<{ required: ResourceProject[]; optional: ResourceProject[] }>({ required: [], optional: [] })
const showDeps = ref(false)
const pendingDepInstall = ref<{ version: ResourceVersion; file: ResourceFile; gameDir: string } | null>(null)

// 整合包安装状态
const modpackInstalling = ref(false)
const modpackProgress = ref<{ stage: string; message: string; fileProgress?: { total: number; completed: number; failed: number; speed: number } } | null>(null)

// 判断当前展开的项目是否是整合包
const isModpack = computed(() => expandedProject.value?.type === 'modpack')

// 可见列表
const visibleResults = computed(() => {
  if (!rs.searchResult) return []
  if (!expandedProject.value) return rs.searchResult.hits
  return rs.searchResult.hits.filter(p => p.id === expandedProject.value!.id)
})

function resourceSubdir(type: ResourceType): string {
  switch (type) {
    case 'mod': return 'mods'
    case 'shader': return 'shaderpacks'
    case 'resourcepack': return 'resourcepacks'
    case 'modpack': return 'modpacks'
  }
}

function formatSize(bytes: number): string {
  if (bytes > 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB'
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

const releaseTypeLabels: Record<string, string> = {
  release: '正式版',
  beta: '测试版',
  alpha: 'Alpha'
}

function scrollContentToTop() {
  const el = document.querySelector('.app-content')
  if (el) el.scrollTop = 0
}

async function onCardClick(project: ResourceProject) {
  if (expandedProject.value?.id === project.id) {
    collapsePanel()
    return
  }
  // 先滚到顶部，让 FLIP 动画的起始位置正确
  scrollContentToTop()
  await nextTick()
  expandedProject.value = project
  expandLoading.value = true
  selectedLoader.value = ''
  selectedGameVersion.value = ''
  allVersions.value = []
  installNotice.value = ''
  try {
    allVersions.value = await window.api.resources.versions(project.platform, project.id)
  } finally {
    expandLoading.value = false
  }
}

function collapsePanel() {
  expandedProject.value = null
  allVersions.value = []
  selectedLoader.value = ''
  selectedGameVersion.value = ''
  installNotice.value = ''
}

watch(selectedLoader, () => {
  selectedGameVersion.value = ''
  installNotice.value = ''
})

watch(() => selectedGameVersion.value, () => {
  installNotice.value = ''
})

// ======== 安装核心流程 ========
async function onInstallClick(version: ResourceVersion) {
  const file = version.files.find(f => f.primary) || version.files[0]
  if (!file || !expandedProject.value) return

  // 检查是否有匹配该游戏版本的实例
  const matched = profiles.profiles.filter(p => p.versionId === selectedGameVersion.value)
  if (matched.length === 0) {
    installNotice.value = `你还没有安装 ${selectedGameVersion.value} 版本的游戏，请先到「版本」页面安装。`
    return
  }

  // 存储待安装信息，弹出实例选择器
  pendingModInstall.value = { version, file }
  matchedProfiles.value = matched
  showInstancePicker.value = true
}

async function onPickInstance(profile: GameProfile) {
  showInstancePicker.value = false
  if (!pendingModInstall.value || !expandedProject.value) return

  const type = expandedProject.value.type
  const defaultDir = profile.gameDir + '\\' + resourceSubdir(type)

  // 打开文件浏览器，默认位置为该实例的资源文件夹
  const selectedDir = await window.api.dialog.selectDirectoryAt(defaultDir)
  if (!selectedDir) {
    pendingModInstall.value = null
    return
  }

  const { version, file } = pendingModInstall.value

  // 检查依赖
  const requiredDeps = version.dependencies.filter(d => d.dependencyType === 'required')
  if (requiredDeps.length > 0) {
    pendingDepInstall.value = { version, file, gameDir: selectedDir }
    try {
      deps.value = await window.api.resources.dependencies(version, expandedProject.value.platform)
    } catch {
      deps.value = { required: [], optional: [] }
    }
    if (deps.value.required.length > 0) {
      showDeps.value = true
      pendingModInstall.value = null
      return
    }
  }

  await doInstall(version, file, selectedDir)
  pendingModInstall.value = null
}

function cancelInstancePick() {
  showInstancePicker.value = false
  pendingModInstall.value = null
}

async function doInstall(version: ResourceVersion, file: ResourceFile, gameDir: string) {
  if (!expandedProject.value) return
  const taskId = tasksStore.addTask('resource', expandedProject.value.title)
  try {
    await rs.install(file, expandedProject.value.type, gameDir, {
      projectId: expandedProject.value.id,
      platform: expandedProject.value.platform,
      versionId: version.id,
      versionNumber: version.versionNumber,
      title: expandedProject.value.title
    })
    tasksStore.completeTask(taskId)
    notifsStore.push('success', `${expandedProject.value.title} 安装完成`)
  } catch (e) {
    tasksStore.failTask(taskId, e instanceof Error ? e.message : String(e))
    notifsStore.push('error', `${expandedProject.value.title} 安装失败`)
  }
}

async function confirmInstallWithDeps() {
  showDeps.value = false
  if (!pendingDepInstall.value || !expandedProject.value) return

  const gameDir = pendingDepInstall.value.gameDir
  for (const dep of deps.value.required) {
    try {
      const versions = await window.api.resources.versions(
        dep.platform, dep.id,
        selectedLoader.value ? [selectedLoader.value] : undefined,
        selectedGameVersion.value ? [selectedGameVersion.value] : undefined
      )
      const latestVer = versions[0]
      if (latestVer) {
        const f = latestVer.files.find(f => f.primary) || latestVer.files[0]
        if (f) {
          await rs.install(f, dep.type, gameDir, {
            projectId: dep.id,
            platform: dep.platform,
            versionId: latestVer.id,
            versionNumber: latestVer.versionNumber,
            title: dep.title
          })
        }
      }
    } catch { /* skip */ }
  }

  const { version, file } = pendingDepInstall.value
  await doInstall(version, file, gameDir)
  pendingDepInstall.value = null
}

function skipDepsInstall() {
  showDeps.value = false
  if (pendingDepInstall.value) {
    doInstall(pendingDepInstall.value.version, pendingDepInstall.value.file, pendingDepInstall.value.gameDir)
    pendingDepInstall.value = null
  }
}

function cancelDeps() {
  showDeps.value = false
  pendingDepInstall.value = null
}

// ======== 整合包安装流程 ========
async function onModpackInstall(version: ResourceVersion) {
  const file = version.files.find(f => f.primary) || version.files[0]
  if (!file || !expandedProject.value) return

  // 选择游戏目录
  const selectedDir = await window.api.dialog.selectDirectory()
  if (!selectedDir) return

  modpackInstalling.value = true
  modpackProgress.value = { stage: 'downloading-pack', message: '准备安装...' }
  const taskId = tasksStore.addTask('modpack', expandedProject.value.title)

  // 监听进度
  const unsubProgress = window.api.modpack.onInstallProgress((p) => {
    modpackProgress.value = p
    if (p.fileProgress) {
      tasksStore.updateProgress(taskId, { completed: p.fileProgress.completed, total: p.fileProgress.total, speed: p.fileProgress.speed })
    }
  })

  try {
    const result = await window.api.modpack.install(
      file.url,
      file.filename,
      selectedDir,
      expandedProject.value.title
    )

    // 安装完成后创建实例
    await window.api.profiles.create({
      name: result.name,
      versionId: result.mcVersion,
      gameDir: result.instanceDir,
      modLoader: result.modLoader as any
    })
    await profiles.fetchProfiles()

    installNotice.value = `✅ 整合包「${result.name}」安装完成！`
    tasksStore.completeTask(taskId)
    notifsStore.push('success', `整合包「${result.name}」安装完成`)
  } catch (e) {
    installNotice.value = `❌ 安装失败: ${e instanceof Error ? e.message : String(e)}`
    tasksStore.failTask(taskId, e instanceof Error ? e.message : String(e))
    notifsStore.push('error', `整合包安装失败`)
  } finally {
    unsubProgress()
    modpackInstalling.value = false
    modpackProgress.value = null
  }
}

function onPlatformChange(platform: 'modrinth' | 'curseforge') {
  if (rs.searchPlatform === platform) return
  rs.searchPlatform = platform
  rs.searchCategories.length = 0
  rs.searchResult = null
  rs.search()
}

function onTypeChange(type: ResourceType | '') {
  rs.searchType = type
  rs.searchCategories.length = 0   // 切换类型时清空已选标签
  collapsePanel()
  rs.search()
}

function onSearchSubmit() {
  collapsePanel()
  rs.search()
}

function onSortChange() {
  collapsePanel()
  rs.search()
}

onMounted(() => {
  if (rs.autoGameVersion && !rs.searchGameVersion) {
    rs.searchGameVersion = rs.autoGameVersion
  }
  if (rs.autoLoader && !rs.searchLoader) {
    rs.searchLoader = rs.autoLoader
  }
  if (versionsStore.versions.length === 0) {
    versionsStore.fetchVersions()
  }
  rs.search()
})

function totalPages(): number {
  if (!rs.searchResult) return 0
  return Math.ceil(rs.searchResult.total / rs.searchResult.pageSize)
}
</script>

<template>
  <div class="resources-page">
    <!-- 顶部 Tab: 浏览 / 已安装 -->
    <div class="top-tabs">
      <button
        v-for="t in tabs" :key="t"
        class="top-tab"
        :class="{ active: activeTab === t }"
        @click="activeTab = t"
      >
        {{ t === 'browse' ? '🔍 浏览资源' : '📦 已安装' }}
      </button>
    </div>

    <!-- 浏览模式 -->
    <template v-if="activeTab === 'browse'">
      <!-- 平台切换 -->
      <div class="platform-tabs" v-show="!expandedProject">
        <button
          class="platform-tab"
          :class="{ active: rs.searchPlatform === 'modrinth' }"
          @click="onPlatformChange('modrinth')"
        >
          Modrinth
        </button>
        <button
          class="platform-tab"
          :class="{ active: rs.searchPlatform === 'curseforge' }"
          @click="onPlatformChange('curseforge')"
        >
          CurseForge
        </button>
      </div>

      <!-- 搜索栏 -->
      <div class="search-bar" v-show="!expandedProject">
        <input
          v-model="rs.searchQuery"
          placeholder="搜索 Mod、光影、资源包..."
          @keyup.enter="onSearchSubmit"
        />
        <button class="btn-primary" @click="onSearchSubmit">搜索</button>
      </div>

      <!-- 类型 Tabs -->
      <div class="type-tabs" v-show="!expandedProject">
        <button
          v-for="tt in typeTabs" :key="tt.value"
          class="type-tab"
          :class="{ active: rs.searchType === tt.value }"
          @click="onTypeChange(tt.value)"
        >
          {{ tt.label }}
        </button>
      </div>

      <!-- 筛选栏 -->
      <div class="filter-bar" v-show="!expandedProject">
        <select v-model="rs.searchGameVersion" class="filter-select" @change="rs.search()">
          <option value="">全部版本</option>
          <option v-for="gv in gameVersionOptions" :key="gv" :value="gv">{{ gv }}</option>
        </select>
        <select v-model="rs.searchLoader" class="filter-select" @change="rs.search()">
          <option value="">全部加载器</option>
          <option value="fabric">Fabric</option>
          <option value="forge">Forge</option>
          <option value="neoforge">NeoForge</option>
          <option value="quilt">Quilt</option>
        </select>
        <select v-model="rs.searchSort" class="filter-select" @change="onSortChange">
          <option v-for="s in sortOptions" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </div>

      <!-- Tag 过滤器 -->
      <div class="tag-filter" v-show="!expandedProject">
        <button
          v-for="t in currentTags" :key="t.value"
          class="tag-chip"
          :class="{ active: rs.searchCategories.includes(t.value) }"
          @click="toggleTag(t.value)"
        >
          {{ t.label }}
        </button>
      </div>

      <!-- 加载中 -->
      <div v-if="rs.searchLoading" class="loading-text">搜索中...</div>

      <!-- 结果列表 -->
      <div v-else-if="rs.searchResult" class="results">
        <div v-if="rs.searchResult.hits.length === 0" class="empty-text">
          未找到匹配的资源
        </div>
        <TransitionGroup name="rlist" tag="div" class="results-inner">
          <div v-for="p in visibleResults" :key="p.id" class="resource-entry">
            <ResourceCard
              :project="p"
              :class="{ 'card-expanded': expandedProject?.id === p.id }"
              @click="onCardClick"
            />

            <!-- 展开的安装面板 -->
            <Transition name="panel-expand">
            <div v-if="expandedProject?.id === p.id" class="install-panel" @click.stop>

              <!-- 加载中 -->
              <div v-if="expandLoading" class="panel-loading">加载版本信息中...</div>

              <template v-else>
                <!-- 安装提示 -->
                <Transition name="fade">
                <div v-if="installNotice" class="warn-text">
                  ⚠ {{ installNotice }}
                </div>
                </Transition>

                <!-- 整合包安装面板 -->
                <template v-if="isModpack">
                  <!-- 整合包安装进度 -->
                  <div v-if="modpackInstalling && modpackProgress" class="panel-section">
                    <label class="step-label">安装中...</label>
                    <div class="modpack-progress">
                      <div class="progress-message">{{ modpackProgress.message }}</div>
                      <div v-if="modpackProgress.fileProgress" class="progress-bar-wrap">
                        <div class="progress-bar" :style="{ width: (modpackProgress.fileProgress.completed / Math.max(modpackProgress.fileProgress.total, 1) * 100) + '%' }"></div>
                      </div>
                      <div v-if="modpackProgress.fileProgress" class="progress-meta">
                        {{ modpackProgress.fileProgress.completed }}/{{ modpackProgress.fileProgress.total }} 文件
                        · {{ formatSize(modpackProgress.fileProgress.speed) }}/s
                      </div>
                    </div>
                  </div>

                  <!-- 整合包版本列表 -->
                  <div v-if="!modpackInstalling" class="panel-section">
                    <label class="step-label">选择版本并安装</label>
                    <div class="mod-version-list">
                      <div v-for="v in allVersions.slice(0, 20)" :key="v.id" class="mod-version-row">
                        <div class="mv-info">
                          <span class="mv-name">{{ v.versionNumber }}</span>
                          <span class="mv-badge" :class="v.releaseType">{{ releaseTypeLabels[v.releaseType] || v.releaseType }}</span>
                          <span class="mv-size">{{ formatSize(v.files[0]?.size || 0) }}</span>
                          <span class="mv-meta" v-if="v.gameVersions.length">MC {{ v.gameVersions[0] }}</span>
                          <span class="mv-meta" v-if="v.loaders.length">{{ v.loaders.join(', ') }}</span>
                        </div>
                        <button
                          class="btn-primary btn-sm"
                          @click="onModpackInstall(v)"
                        >
                          安装
                        </button>
                      </div>
                    </div>
                  </div>
                </template>

                <!-- 普通资源安装面板 (Mod/光影/资源包) -->
                <template v-else>
                <!-- Step 1: 选择 Loader -->
                <div class="panel-section">
                  <label class="step-label">① 选择 Mod Loader</label>
                  <div class="step-chips">
                    <button
                      v-for="loader in availableLoaders" :key="loader"
                      class="chip"
                      :class="{ active: selectedLoader === loader }"
                      @click="selectedLoader = loader"
                    >
                      {{ loader }}
                    </button>
                  </div>
                  <div v-if="availableLoaders.length === 0" class="text-hint">此资源无 Loader 限制</div>
                </div>

                <!-- Step 2: 选择游戏版本 -->
                <Transition name="fade">
                <div v-if="selectedLoader" class="panel-section">
                  <label class="step-label">② 选择游戏版本</label>
                  <div class="step-chips game-version-chips">
                    <button
                      v-for="gv in availableGameVersions" :key="gv"
                      class="chip"
                      :class="{ active: selectedGameVersion === gv }"
                      @click="selectedGameVersion = gv"
                    >
                      {{ gv }}
                    </button>
                  </div>
                  <div v-if="availableGameVersions.length === 0" class="text-hint">无匹配的游戏版本</div>
                </div>
                </Transition>

                <!-- Step 3: 选择 Mod 版本并安装 -->
                <Transition name="fade">
                <div v-if="selectedGameVersion && filteredVersions.length > 0" class="panel-section">
                  <label class="step-label">③ 选择版本并安装 ({{ filteredVersions.length }})</label>
                  <div class="mod-version-list">
                    <div v-for="v in filteredVersions" :key="v.id" class="mod-version-row">
                      <div class="mv-info">
                        <span class="mv-name">{{ v.versionNumber }}</span>
                        <span class="mv-badge" :class="v.releaseType">{{ releaseTypeLabels[v.releaseType] || v.releaseType }}</span>
                        <span class="mv-size">{{ formatSize(v.files[0]?.size || 0) }}</span>
                      </div>
                      <button
                        class="btn-primary btn-sm"
                        :disabled="rs.installingFiles.has(v.files[0]?.filename || '')"
                        @click="onInstallClick(v)"
                      >
                        {{ rs.installingFiles.has(v.files[0]?.filename || '') ? '安装中...' : '安装' }}
                      </button>
                    </div>
                  </div>
                </div>
                </Transition>

                <Transition name="fade">
                <div v-if="selectedGameVersion && filteredVersions.length === 0" class="empty-hint">
                  无匹配的 Mod 版本
                </div>
                </Transition>
                </template>
              </template>

              <div class="panel-actions">
                <button class="btn-secondary" @click="collapsePanel">▲ 收起</button>
              </div>
            </div>
            </Transition>
          </div>
        </TransitionGroup>

        <!-- 分页 -->
        <div v-if="totalPages() > 1 && !expandedProject" class="pagination">
          <button class="btn-secondary" :disabled="rs.searchPage <= 0" @click="rs.prevPage()">上一页</button>
          <span class="page-info">{{ rs.searchPage + 1 }} / {{ totalPages() }}</span>
          <button class="btn-secondary" :disabled="rs.searchPage >= totalPages() - 1" @click="rs.nextPage()">下一页</button>
        </div>
      </div>
    </template>

    <!-- 已安装模式 -->
    <template v-if="activeTab === 'installed'">
      <InstalledResources />
    </template>

    <!-- 实例选择弹窗 -->
    <Transition name="fade">
    <div v-if="showInstancePicker" class="deps-overlay" @click.self="cancelInstancePick">
      <div class="deps-panel card">
        <h3>选择安装位置</h3>
        <p class="deps-hint">以下实例使用 {{ selectedGameVersion }} 版本，请选择要安装到哪个实例：</p>
        <div class="instance-list">
          <button
            v-for="p in matchedProfiles" :key="p.id"
            class="instance-item"
            @click="onPickInstance(p)"
          >
            <span class="instance-name">{{ p.name }}</span>
            <span class="instance-meta">{{ p.versionId }}{{ p.modLoader ? ' · ' + p.modLoader : '' }}</span>
          </button>
        </div>
        <div class="deps-actions">
          <button class="btn-secondary" @click="cancelInstancePick">取消</button>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 依赖确认弹窗 -->
    <Transition name="fade">
    <div v-if="showDeps" class="deps-overlay" @click.self="cancelDeps">
      <div class="deps-panel card">
        <h3>需要安装依赖</h3>
        <p class="deps-hint">此资源需要以下前置 Mod：</p>
        <div v-for="d in deps.required" :key="d.id" class="dep-item">
          <img v-if="d.iconUrl" :src="d.iconUrl" class="dep-icon" alt="" />
          <span>{{ d.title }}</span>
        </div>
        <div class="deps-actions">
          <button class="btn-primary" @click="confirmInstallWithDeps">一并安装</button>
          <button class="btn-secondary" @click="skipDepsInstall">跳过依赖</button>
          <button class="btn-secondary" @click="cancelDeps">取消</button>
        </div>
      </div>
    </div>
    </Transition>
  </div>
</template>

<style scoped>
.resources-page {
  max-width: 700px;
}

.top-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
}
.top-tab {
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: var(--bg-card);
  cursor: pointer;
  font-size: 13px;
}
.top-tab.active {
  background: var(--accent);
  color: #fff;
}

.search-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.search-bar input {
  flex: 1;
}

.type-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
}
.type-tab {
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-primary);
}
.type-tab.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.platform-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.platform-tab {
  padding: 5px 16px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  transition: all .15s;
}
.platform-tab.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.filter-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.filter-input {
  width: 140px;
}
.filter-select {
  min-width: 120px;
}

.tag-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 12px;
}
.tag-chip {
  padding: 2px 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: none;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}
.tag-chip:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}
.tag-chip.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.loading-text, .empty-text {
  color: var(--text-muted);
  text-align: center;
  padding: 32px;
  font-size: 14px;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.results-inner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
}

/* resource list transitions */
.rlist-enter-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.rlist-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; position: absolute; width: 100%; }
.rlist-enter-from { opacity: 0; transform: translateY(10px); }
.rlist-leave-to { opacity: 0; transform: translateY(-10px); }
.rlist-move { transition: transform 0.3s ease; }

.resource-entry { }
.card-expanded { border-color: var(--accent); }

/* ====== 安装面板 ====== */
.install-panel {
  background: var(--bg-card);
  border: 1px solid var(--accent);
  border-top: none;
  border-radius: 0 0 var(--radius) var(--radius);
  padding: 16px 20px;
  margin-top: -4px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.panel-loading {
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
  padding: 12px;
}

.warn-text {
  color: #e8a838;
  font-size: 13px;
  padding: 8px 12px;
  background: rgba(232, 168, 56, 0.1);
  border-radius: 6px;
}

.panel-section {
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.panel-section:last-of-type {
  border-bottom: none;
}

.step-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.step-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.game-version-chips {
  max-height: 120px;
  overflow-y: auto;
}

.chip {
  padding: 4px 12px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.chip:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}
.chip.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.text-hint {
  color: var(--text-muted);
  font-size: 11px;
  padding: 4px 0;
}

.empty-hint {
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
  padding: 12px;
}

/* Mod 版本列表 */
.mod-version-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  overflow-y: auto;
}

.mod-version-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--bg-secondary);
  transition: background 0.15s;
}
.mod-version-row:hover {
  background: var(--bg-hover);
}

.mv-info {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mv-name {
  font-weight: 600;
  font-size: 13px;
}
.mv-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
}
.mv-badge.release { background: rgba(78, 204, 163, 0.15); color: var(--accent); }
.mv-badge.beta { background: rgba(243, 156, 18, 0.15); color: #f0b643; }
.mv-badge.alpha { background: rgba(231, 76, 60, 0.15); color: #e67e73; }
.mv-size {
  font-size: 11px;
  color: var(--text-muted);
}

.btn-sm {
  font-size: 11px;
  padding: 3px 10px;
}

.panel-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

/* 依赖弹窗 */
.deps-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 200;
  animation: overlay-in 0.2s ease;
}
@keyframes overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.deps-panel {
  padding: 20px;
  width: 380px;
  animation: modal-scale-in 0.22s ease;
}
@keyframes modal-scale-in {
  from { opacity: 0; transform: scale(0.92); }
  to { opacity: 1; transform: scale(1); }
}
.deps-panel h3 {
  margin-bottom: 8px;
}
.deps-hint {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 8px;
}
.dep-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.dep-icon {
  width: 24px;
  height: 24px;
  border-radius: 4px;
}
.deps-actions {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}

.instance-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
}
.instance-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.instance-item:hover {
  border-color: var(--accent);
  background: rgba(78, 204, 163, 0.06);
}
.instance-name {
  font-weight: 500;
  font-size: 13px;
}
.instance-meta {
  font-size: 11px;
  color: var(--text-muted);
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px 0;
}
.page-info {
  font-size: 13px;
  color: var(--text-muted);
}

/* 整合包安装进度 */
.modpack-progress {
  padding: 8px 0;
}
.progress-message {
  font-size: 13px;
  margin-bottom: 6px;
  color: var(--text-primary);
}
.progress-bar-wrap {
  height: 6px;
  background: var(--bg-primary);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 4px;
}
.progress-bar {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.3s ease;
}
.progress-meta {
  font-size: 12px;
  color: var(--text-muted);
}
.mv-meta {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 4px;
}
</style>
