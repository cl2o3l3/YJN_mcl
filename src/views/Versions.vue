<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useVersionsStore } from '../stores/versions'
import { useSettingsStore } from '../stores/settings'
import { useModloaderStore } from '../stores/modloader'
import { useProfilesStore } from '../stores/profiles'
import { useTasksStore } from '../stores/tasks'
import { useNotificationsStore } from '../stores/notifications'
import type { GCType, ModLoaderType, JvmArgs, DownloadProgress } from '../types'
import { GC_PRESETS } from '../types'

const router = useRouter()
const store = useVersionsStore()
const settings = useSettingsStore()
const modloaderStore = useModloaderStore()
const profiles = useProfilesStore()

const search = ref('')
const expandedId = ref<string | null>(null)

// ======== 安装表单状态 ========
const instName = ref('')
const loaderType = ref<ModLoaderType | ''>('')
const loaderVersion = ref('')
const gameDir = ref('')
const javaPath = ref('')
const maxMemory = ref(4096)
const minMemory = ref(1024)
const gcType = ref<GCType>('G1GC')
const gcArgsText = ref(GC_PRESETS.G1GC.join('\n'))
const extraArgs = ref('-Dlog4j2.formatMsgNoLookups=true')
const windowWidth = ref(1280)
const windowHeight = ref(720)
const totalMemory = ref(0)
const javas = ref<{ path: string; version: string; majorVersion: number }[]>([])
const scanningJava = ref(false)
const showAdvanced = ref(false)

// 安装状态
const installing = ref(false)
const installingLoader = ref(false)
const downloadProgress = ref<DownloadProgress | null>(null)
const installError = ref('')
const installDone = ref(false)

let unsubProgress: (() => void) | null = null
let _vTaskId = ''

// Mod Loader 版本选项
const loaderVersionOptions = computed(() => {
  switch (loaderType.value) {
    case 'fabric': return modloaderStore.fabricVersions.map(v => ({ label: v.version + (v.stable ? '' : ' (unstable)'), value: v.version }))
    case 'quilt': return modloaderStore.quiltVersions.map(v => ({ label: v.version + (v.stable ? '' : ' (unstable)'), value: v.version }))
    case 'forge': return modloaderStore.forgeVersions.map(v => ({ label: v.version, value: v.version }))
    case 'neoforge': return modloaderStore.neoforgeVersions.map(v => ({ label: v.version + (v.stable ? '' : ' (unstable)'), value: v.version }))
    default: return []
  }
})

const progressPercent = computed(() => {
  if (!downloadProgress.value) return 0
  const { completed, total } = downloadProgress.value
  return total > 0 ? Math.round((completed / total) * 100) : 0
})

const displayList = computed(() => {
  let list = store.filtered
  if (search.value) {
    const q = search.value.toLowerCase()
    list = list.filter(v => v.id.toLowerCase().includes(q))
  }
  return list
})

const visibleList = computed(() => {
  if (!expandedId.value) return displayList.value
  return displayList.value.filter(v => v.id === expandedId.value)
})

// 当 loader type 变化时拉取 loader 版本
watch(() => loaderType.value, (lt) => {
  loaderVersion.value = ''
  if (lt && expandedId.value) {
    modloaderStore.fetchVersions(lt as ModLoaderType, expandedId.value)
  } else {
    modloaderStore.clear()
  }
})

// 自动选第一个 loader 版本
watch(loaderVersionOptions, (opts) => {
  if (opts.length > 0 && !loaderVersion.value) {
    loaderVersion.value = opts[0].value
  }
})

onMounted(async () => {
  await store.fetchVersions()
  totalMemory.value = await window.api.system.totalMemory()
  if (settings.defaultGameDir) {
    await store.fetchLocalVersions(settings.defaultGameDir)
  }
})

onUnmounted(() => {
  unsubProgress?.()
  modloaderStore.clear()
})

function scrollContentToTop() {
  const el = document.querySelector('.app-content')
  if (el) el.scrollTop = 0
  const vl = document.querySelector('.version-list')
  if (vl) vl.scrollTop = 0
}

function toggleExpand(versionId: string) {
  if (installing.value) return
  if (expandedId.value === versionId) {
    // 收起
    expandedId.value = null
    resetForm()
    return
  }
  // 先滚到顶部，让 FLIP 动画的起始位置正确
  scrollContentToTop()
  // 展开新版本
  expandedId.value = versionId
  resetForm()
  instName.value = `Minecraft ${versionId}`
  gameDir.value = settings.defaultGameDir || ''
  if (!gameDir.value) {
    window.api.system.defaultGameDir().then(d => { gameDir.value = d })
  }
  scanJava()
}

function resetForm() {
  instName.value = ''
  loaderType.value = ''
  loaderVersion.value = ''
  javaPath.value = ''
  maxMemory.value = 4096
  minMemory.value = 1024
  gcType.value = 'G1GC'
  gcArgsText.value = GC_PRESETS.G1GC.join('\n')
  extraArgs.value = '-Dlog4j2.formatMsgNoLookups=true'
  windowWidth.value = 1280
  windowHeight.value = 720
  showAdvanced.value = false
  installError.value = ''
  installDone.value = false
  downloadProgress.value = null
  modloaderStore.clear()
}

async function scanJava() {
  scanningJava.value = true
  try { javas.value = await window.api.java.scan() }
  finally { scanningJava.value = false }
}

async function selectGameDir() {
  const dir = await window.api.dialog.selectDirectory()
  if (dir) gameDir.value = dir
}

async function selectJava() {
  const file = await window.api.dialog.selectFile([{ name: 'Java', extensions: ['exe'] }])
  if (file) {
    const info = await window.api.java.validate(file)
    if (info) javaPath.value = file
  }
}

function onGcChange() {
  if (gcType.value !== 'custom') {
    gcArgsText.value = GC_PRESETS[gcType.value as keyof typeof GC_PRESETS]?.join('\n') || ''
  }
}

async function startInstall() {
  if (!expandedId.value || !instName.value || installing.value) return
  const versionId = expandedId.value

  installing.value = true
  installError.value = ''
  installDone.value = false
  _vTaskId = useTasksStore().addTask('game', `安装 ${versionId}`)

  try {
    const jvmArgs: JvmArgs = {
      maxMemory: maxMemory.value,
      minMemory: minMemory.value,
      gcType: gcType.value,
      gcArgs: gcArgsText.value.split('\n').map(s => s.trim()).filter(Boolean),
      extraArgs: extraArgs.value.split(' ').filter(Boolean)
    }
    const modLoader = loaderType.value && loaderVersion.value
      ? { type: loaderType.value as ModLoaderType, version: loaderVersion.value }
      : undefined

    const profile = await profiles.createProfile({
      name: instName.value,
      versionId,
      gameDir: gameDir.value,
      javaPath: javaPath.value,
      jvmArgs,
      modLoader
    })

    let targetVersionId = versionId
    if (modLoader) {
      installingLoader.value = true
      try {
        targetVersionId = await modloaderStore.install(
          modLoader.type, versionId, modLoader.version,
          gameDir.value, javaPath.value || undefined
        )
      } finally { installingLoader.value = false }
    }

    unsubProgress = window.api.download.onProgress((p) => {
      downloadProgress.value = p
      useTasksStore().updateProgress(_vTaskId, { completed: p.completed, total: p.total, speed: p.speed })
    })
    await window.api.download.installVersion(targetVersionId, gameDir.value)
    unsubProgress?.()
    unsubProgress = null
    downloadProgress.value = null

    await store.fetchLocalVersions(gameDir.value)
    profiles.selectedId = profile.id
    installDone.value = true
    useTasksStore().completeTask(_vTaskId)
    useNotificationsStore().push('success', `版本 ${versionId} 安装完成`)
  } catch (e: unknown) {
    installError.value = e instanceof Error ? e.message : String(e)
    useTasksStore().failTask(_vTaskId, installError.value)
    useNotificationsStore().push('error', `安装失败: ${installError.value}`)
  } finally {
    installing.value = false
  }
}

function goHome() {
  router.push({ name: 'home' })
}
</script>

<template>
  <div class="versions-page">
    <div class="header">
      <h2>版本管理</h2>
      <div class="header-controls" v-show="!expandedId">
        <input v-model="search" class="search-input" placeholder="搜索版本号..." />
        <div class="filter-tabs">
          <button
            v-for="f in (['release', 'snapshot', 'all'] as const)"
            :key="f"
            :class="['btn-secondary', { active: store.filter === f }]"
            @click="store.filter = f"
          >
            {{ f === 'release' ? '正式版' : f === 'snapshot' ? '快照' : '全部' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="store.loading" class="loading">加载中...</div>

    <div class="version-list">
      <TransitionGroup name="vlist" tag="div" class="version-list-inner">
        <div v-for="v in visibleList" :key="v.id" class="version-entry">
          <!-- 版本卡片（可点击） -->
          <div
            class="card version-item"
            :class="{ expanded: expandedId === v.id }"
            @click="toggleExpand(v.id)"
          >
            <div class="version-info">
              <div class="version-main">
                <span class="version-id">{{ v.id }}</span>
                <span class="version-type" :class="v.type">
                  {{ v.type === 'release' ? '正式版' : v.type === 'snapshot' ? '快照' : v.type }}
                </span>
                <span v-if="store.isInstalled(v.id)" class="installed-badge">✓ 已安装</span>
              </div>
              <span class="version-date">{{ new Date(v.releaseTime).toLocaleDateString('zh-CN') }}</span>
            </div>
            <span class="expand-arrow">{{ expandedId === v.id ? '▲ 收起' : '▼ 点击安装' }}</span>
          </div>

          <!-- 展开的安装配置面板 -->
          <Transition name="panel-expand">
          <div v-if="expandedId === v.id" class="install-panel" @click.stop>

            <!-- 安装完成 -->
            <div v-if="installDone" class="done-section">
              <div class="done-icon">✅</div>
              <h3>安装完成!</h3>
              <p>实例「{{ instName }}」已创建并准备就绪</p>
              <div class="done-actions">
                <button class="btn-secondary" @click="toggleExpand(v.id)">返回列表</button>
                <button class="btn-primary" @click="goHome">前往主页启动</button>
              </div>
            </div>

            <!-- 安装表单 -->
            <template v-else>
              <!-- 基本配置 -->
              <div class="panel-section">
                <div class="form-group">
                  <label>实例名称</label>
                  <input v-model="instName" :placeholder="`Minecraft ${v.id}`" :disabled="installing" />
                </div>

                <div class="form-group">
                  <label>Mod Loader <span class="text-hint">（可选）</span></label>
                  <div class="loader-row">
                    <select v-model="loaderType" class="loader-type-select" :disabled="installing">
                      <option value="">无 (原版)</option>
                      <option value="fabric">Fabric</option>
                      <option value="forge">Forge</option>
                      <option value="neoforge">NeoForge</option>
                      <option value="quilt">Quilt</option>
                    </select>
                    <template v-if="loaderType">
                      <div v-if="modloaderStore.loading" class="text-hint loader-status">加载版本中…</div>
                      <div v-else-if="modloaderStore.error" class="loader-status text-error">{{ modloaderStore.error }}</div>
                      <select
                        v-else v-model="loaderVersion" class="loader-version-select"
                        :disabled="loaderVersionOptions.length === 0 || installing"
                      >
                        <option value="" disabled>选择 Loader 版本</option>
                        <option v-for="opt in loaderVersionOptions" :key="opt.value" :value="opt.value">
                          {{ opt.label }}
                        </option>
                      </select>
                    </template>
                  </div>
                </div>

                <div class="form-group">
                  <label>游戏目录</label>
                  <div class="input-row">
                    <input v-model="gameDir" readonly class="flex-input" />
                    <button class="btn-secondary" @click.stop="selectGameDir" :disabled="installing">浏览...</button>
                  </div>
                </div>
              </div>

              <!-- 高级设置 -->
              <div class="panel-section">
                <div class="section-header" @click.stop="showAdvanced = !showAdvanced">
                  <span class="section-label">⚙️ 高级设置</span>
                  <span class="toggle-icon">{{ showAdvanced ? '▲' : '▼' }}</span>
                </div>

                <div v-show="showAdvanced" class="advanced-body">
                  <div class="form-group">
                    <label>Java 路径 <span class="text-hint">(留空自动检测)</span></label>
                    <div class="input-row">
                      <select v-model="javaPath" class="flex-input" :disabled="installing">
                        <option value="">自动检测</option>
                        <option v-for="j in javas" :key="j.path" :value="j.path">
                          Java {{ j.majorVersion }} ({{ j.version }}) - {{ j.path }}
                        </option>
                      </select>
                      <button class="btn-secondary" @click.stop="selectJava" :disabled="installing">手动</button>
                      <button class="btn-secondary" @click.stop="scanJava" :disabled="scanningJava || installing">
                        {{ scanningJava ? '扫描中...' : '扫描' }}
                      </button>
                    </div>
                  </div>

                  <div class="form-row">
                    <div class="form-group">
                      <label>最大内存 (MB)</label>
                      <input type="number" v-model.number="maxMemory" :max="totalMemory" min="512" step="256" :disabled="installing" />
                      <span class="text-hint">系统: {{ totalMemory }} MB</span>
                    </div>
                    <div class="form-group">
                      <label>最小内存 (MB)</label>
                      <input type="number" v-model.number="minMemory" :max="maxMemory" min="256" step="256" :disabled="installing" />
                    </div>
                  </div>

                  <div class="form-group">
                    <label>GC 类型</label>
                    <select v-model="gcType" @change="onGcChange" :disabled="installing">
                      <option value="G1GC">G1GC (推荐)</option>
                      <option value="ZGC">ZGC (大内存)</option>
                      <option value="ShenandoahGC">Shenandoah (低延迟)</option>
                      <option value="ParallelGC">Parallel GC</option>
                      <option value="SerialGC">Serial GC</option>
                      <option value="custom">自定义</option>
                    </select>
                  </div>

                  <div class="form-group">
                    <label>GC 参数 <span class="text-hint">(每行一个)</span></label>
                    <textarea v-model="gcArgsText" rows="3" class="mono-input" :disabled="installing" />
                  </div>

                  <div class="form-group">
                    <label>额外 JVM 参数 <span class="text-hint">(空格分隔)</span></label>
                    <input v-model="extraArgs" :disabled="installing" />
                  </div>

                  <div class="form-row">
                    <div class="form-group">
                      <label>窗口宽度</label>
                      <input type="number" v-model.number="windowWidth" min="800" :disabled="installing" />
                    </div>
                    <div class="form-group">
                      <label>窗口高度</label>
                      <input type="number" v-model.number="windowHeight" min="600" :disabled="installing" />
                    </div>
                  </div>
                </div>
              </div>

              <!-- 安装进度 -->
              <div v-if="installing" class="panel-section progress-section">
                <div v-if="installingLoader" class="progress-info">正在安装 Mod Loader…</div>
                <div v-if="downloadProgress" class="progress-detail">
                  <div class="progress-bar"><div class="progress-fill" :style="{ width: `${progressPercent}%` }" /></div>
                  <div class="progress-info">
                    <span>{{ downloadProgress.completed }} / {{ downloadProgress.total }} 文件</span>
                    <span>{{ progressPercent }}%</span>
                  </div>
                  <div v-if="downloadProgress.currentFile" class="progress-file">{{ downloadProgress.currentFile }}</div>
                </div>
              </div>

              <!-- 错误 -->
              <div v-if="installError" class="panel-section error-section">
                <p class="error-text">安装失败: {{ installError }}</p>
              </div>

              <!-- 操作栏 -->
              <div class="panel-actions">
                <button class="btn-secondary" @click.stop="toggleExpand(v.id)" :disabled="installing">取消</button>
                <button class="btn-primary" @click.stop="startInstall" :disabled="installing || !instName">
                  {{ installing ? '安装中...' : '开始安装' }}
                </button>
              </div>
            </template>
          </div>
          </Transition>
        </div>
      </TransitionGroup>

      <div v-if="!store.loading && displayList.length === 0" class="empty-state">
        暂无版本数据，请检查网络连接
      </div>
    </div>
  </div>
</template>

<style scoped>
.versions-page { max-width: 800px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
.header-controls { display: flex; align-items: center; gap: 8px; }
.search-input {
  width: 180px; padding: 6px 10px; font-size: 13px;
  background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text-primary);
}
.search-input:focus { border-color: var(--accent); outline: none; }
.filter-tabs { display: flex; gap: 4px; }
.filter-tabs button.active { background: var(--accent); color: #fff; }

.version-list { display: flex; flex-direction: column; gap: 4px; max-height: calc(100vh - 170px); overflow-y: auto; }
.version-list-inner { display: flex; flex-direction: column; gap: 4px; }
.version-entry { transition: all 0.3s ease; }

/* version list transition */
.vlist-enter-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.vlist-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; position: absolute; width: 100%; }
.vlist-enter-from { opacity: 0; transform: translateY(10px); }
.vlist-leave-to { opacity: 0; transform: translateY(-10px); }
.vlist-move { transition: transform 0.3s ease; }

.version-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 16px; cursor: pointer; transition: all 0.2s;
}
.version-item:hover { background: var(--bg-hover); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
.version-item.expanded { border-color: var(--accent); background: var(--bg-hover); transform: none; box-shadow: none; }
.version-info { display: flex; flex-direction: column; gap: 2px; }
.version-main { display: flex; align-items: center; gap: 8px; }
.version-id { font-weight: 600; }
.version-type { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg-hover); }
.version-type.release { color: var(--accent); }
.version-type.snapshot { color: #f39c12; }
.version-date { color: var(--text-muted); font-size: 12px; }
.installed-badge { font-size: 11px; color: #2ecc71; font-weight: 500; }
.expand-arrow { font-size: 12px; color: var(--text-muted); white-space: nowrap; }

/* ====== 安装面板 ====== */
.install-panel {
  background: var(--bg-card); border: 1px solid var(--accent);
  border-top: none; border-radius: 0 0 var(--radius) var(--radius);
  padding: 16px 20px; margin-top: -4px;
  display: flex; flex-direction: column; gap: 12px;
}

.panel-section { padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.panel-section:last-of-type { border-bottom: none; }

.form-group { margin-bottom: 10px; }
.form-group label { display: block; margin-bottom: 4px; font-size: 13px; color: var(--text-secondary); }
.form-group input, .form-group select, .form-group textarea { width: 100%; }
.form-row { display: flex; gap: 12px; }
.form-row .form-group { flex: 1; }
.input-row { display: flex; gap: 6px; }
.flex-input { flex: 1; }
.text-hint { color: var(--text-muted); font-size: 11px; }
.text-error { color: var(--danger); font-size: 12px; }

.loader-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.loader-type-select { width: 150px; flex-shrink: 0; }
.loader-version-select { flex: 1; min-width: 180px; }
.loader-status { padding: 4px 0; }

.section-header {
  display: flex; justify-content: space-between; align-items: center;
  cursor: pointer; user-select: none; padding: 4px 0;
}
.section-label { font-size: 13px; font-weight: 500; }
.toggle-icon { color: var(--text-muted); font-size: 12px; }
.advanced-body { margin-top: 10px; }

.mono-input {
  background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text-primary); padding: 8px; font-family: 'Cascadia Mono', monospace; font-size: 12px;
  resize: vertical;
}
textarea:focus { border-color: var(--accent); outline: none; }

.progress-section { }
.progress-detail { display: flex; flex-direction: column; gap: 4px; }
.progress-bar { height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden; }
.progress-fill {
  height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.3s ease;
  background-image: linear-gradient(
    -45deg,
    rgba(255, 255, 255, 0.1) 25%, transparent 25%,
    transparent 50%, rgba(255, 255, 255, 0.1) 50%,
    rgba(255, 255, 255, 0.1) 75%, transparent 75%
  );
  background-size: 30px 30px;
  animation: stripe-scroll 0.8s linear infinite;
}
.progress-info { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-secondary); }
.progress-file { font-size: 11px; color: var(--text-muted); word-break: break-all; }

.error-section { }
.error-text { color: var(--danger); font-size: 13px; }

.done-section { text-align: center; padding: 20px 0; }
.done-icon { font-size: 36px; margin-bottom: 8px; }
.done-section h3 { font-size: 18px; margin-bottom: 4px; }
.done-section p { color: var(--text-secondary); margin-bottom: 16px; font-size: 13px; }
.done-actions { display: flex; gap: 8px; justify-content: center; }

.panel-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }

.loading { text-align: center; padding: 40px; color: var(--text-secondary); }
.empty-state { text-align: center; padding: 40px; color: var(--text-secondary); }
</style>
