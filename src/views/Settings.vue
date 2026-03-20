<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useProfilesStore } from '../stores/profiles'

const settings = useSettingsStore()
const profiles = useProfilesStore()

const appVersion = __APP_VERSION__

// P2P 自定义 TURN 临时输入
const customTurnUrl = ref('')
const customTurnUser = ref('')
const customTurnPass = ref('')
const newRelayUrl = ref('')

// ========== 游戏目录管理 ==========
const gameDirExpanded = ref(false)
const scanning = ref(false)
const scanResults = ref<Record<string, number>>({})  // dir -> 扫描到的实例数

function toggleGameDirPanel() { gameDirExpanded.value = !gameDirExpanded.value }

async function handleAddGameDir() {
  const dir = await settings.addGameDir()
  if (dir) {
    scanning.value = true
    try {
      const added = await profiles.scanDir(dir)
      scanResults.value[dir] = added.length
    } finally {
      scanning.value = false
    }
  }
}

function profileCountForDir(dir: string): number {
  return profiles.profiles.filter(p => p.gameDir === dir).length
}

const themeOptions = [
  { value: 'dark' as const,   icon: '🌙', label: '暗色' },
  { value: 'light' as const,  icon: '☀️', label: '亮色' },
  { value: 'system' as const, icon: '💻', label: '跟随系统' },
]

function addTurn() {
  const url = customTurnUrl.value.trim()
  if (!url) return
  settings.addCustomTurn(url, customTurnUser.value.trim() || undefined, customTurnPass.value.trim() || undefined)
  customTurnUrl.value = ''
  customTurnUser.value = ''
  customTurnPass.value = ''
}

// ========== Java 下载管理 ==========
const javaDistros = ref<Array<{ id: string; name: string; description: string; versions: number[] }>>([])
const installedRuntimes = ref<Array<{ distro: string; majorVersion: number; javaPath: string }>>([])
const installing = ref<{ distro: string; version: number } | null>(null)
const installProgress = ref({ percent: 0, message: '' })
const installError = ref('')

// 级联展开状态
const javaExpanded = ref(false)
const selectedDistro = ref<string | null>(null)

onMounted(async () => {
  try {
    javaDistros.value = await window.api.java.distros()
    installedRuntimes.value = await window.api.java.installedRuntimes()
  } catch { /* ignore */ }
})

function isInstalled(distroId: string, majorVersion: number): boolean {
  return installedRuntimes.value.some(r => r.distro === distroId && r.majorVersion === majorVersion)
}

function toggleJavaPanel() {
  javaExpanded.value = !javaExpanded.value
  if (!javaExpanded.value) selectedDistro.value = null
}

function selectDistro(id: string) {
  selectedDistro.value = selectedDistro.value === id ? null : id
}

const activeDistro = () => javaDistros.value.find(d => d.id === selectedDistro.value)

async function installJava(distroId: string, majorVersion: number) {
  if (installing.value) return
  installing.value = { distro: distroId, version: majorVersion }
  installProgress.value = { percent: 0, message: '准备中...' }
  installError.value = ''

  const unsub = window.api.java.onInstallProgress((p) => {
    installProgress.value = { percent: p.percent, message: p.message }
    if (p.status === 'error') {
      installError.value = p.message
    }
  })

  try {
    await window.api.java.install(distroId, majorVersion)
    installedRuntimes.value = await window.api.java.installedRuntimes()
  } catch (e: unknown) {
    installError.value = e instanceof Error ? e.message : String(e)
  } finally {
    unsub()
    installing.value = null
  }
}

// ========== 自动更新 ==========
const updateStatus = ref<{
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  releaseNotes?: string
  progress?: { percent: number; bytesPerSecond: number; transferred: number; total: number }
  error?: string
}>({ status: 'idle' })

let unsubUpdater: (() => void) | null = null

onMounted(() => {
  unsubUpdater = window.api.updater.onStatus((s: any) => {
    updateStatus.value = s
  })
})

onUnmounted(() => {
  unsubUpdater?.()
})

function checkUpdate() {
  window.api.updater.check()
}

function downloadUpdate() {
  window.api.updater.download()
}

function installUpdateNow() {
  window.api.updater.install()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}
</script>

<template>
  <div class="settings-page">
    <h2>设置</h2>

    <!-- 主题 -->
    <div class="card setting-group">
      <h3>主题</h3>
      <div class="theme-switcher">
        <button
          v-for="t in themeOptions"
          :key="t.value"
          class="theme-btn"
          :class="{ active: settings.theme === t.value }"
          @click="settings.setTheme(t.value)"
        >
          <span class="theme-icon">{{ t.icon }}</span>
          <span>{{ t.label }}</span>
        </button>
      </div>
    </div>

    <!-- 下载源 -->
    <div class="card setting-group">
      <h3>下载源</h3>
      <div class="radio-group">
        <label><input type="radio" v-model="settings.mirrorSource" value="bmclapi" @change="settings.setMirrorSource(settings.mirrorSource)" /> BMCLAPI (推荐)</label>
        <label><input type="radio" v-model="settings.mirrorSource" value="official" @change="settings.setMirrorSource(settings.mirrorSource)" /> 官方源</label>
        <label><input type="radio" v-model="settings.mirrorSource" value="tsinghua" @change="settings.setMirrorSource(settings.mirrorSource)" /> 清华镜像</label>
      </div>
    </div>

    <!-- 默认Java路径 -->
    <div class="card setting-group">
      <h3>默认 Java 路径</h3>
      <div class="input-row">
        <input :value="settings.defaultJavaPath" readonly placeholder="使用自动检测" />
        <button class="btn-secondary" @click="settings.browseDefaultJava">浏览</button>
      </div>
    </div>

    <!-- Java 运行时下载 -->
    <div class="card setting-group java-panel-wrapper" :class="{ 'panel-open': javaExpanded }">
      <div class="java-panel-trigger" @click="toggleJavaPanel">
        <div class="trigger-info">
          <h3>通过启动器安装 Java</h3>
          <p class="text-hint">一键下载并安装 Java 运行时，无需手动配置环境</p>
        </div>
        <span class="trigger-arrow" :class="{ open: javaExpanded }">▾</span>
      </div>

      <Transition name="jdrop">
        <div v-if="javaExpanded" class="java-cascade">
          <!-- 三个发行版卡片 -->
          <div class="distro-cards">
            <div
              v-for="distro in javaDistros" :key="distro.id"
              class="distro-card"
              :class="{ active: selectedDistro === distro.id }"
              @click.stop="selectDistro(distro.id)"
            >
              <strong>{{ distro.name }}</strong>
              <span class="distro-desc">{{ distro.description }}</span>
            </div>
          </div>

          <!-- 版本列表 -->
          <Transition name="jdrop">
            <div v-if="selectedDistro && activeDistro()" class="java-version-list">
              <div
                v-for="ver in activeDistro()!.versions" :key="ver"
                class="java-version-row"
              >
                <span class="jv-name">Java {{ ver }}</span>
                <span v-if="isInstalled(selectedDistro!, ver)" class="jv-installed">✓ 已安装</span>
                <div class="jv-right">
                  <button
                    v-if="!isInstalled(selectedDistro!, ver)"
                    class="btn-install"
                    :disabled="!!installing"
                    @click.stop="installJava(selectedDistro!, ver)"
                  >
                    {{ installing?.distro === selectedDistro && installing?.version === ver ? '安装中...' : '安装' }}
                  </button>
                </div>
              </div>

              <!-- 安装进度 -->
              <div v-if="installing && installing.distro === selectedDistro" class="install-progress">
                <div class="progress-bar">
                  <div class="progress-fill" :style="{ width: installProgress.percent + '%' }"></div>
                </div>
                <span class="progress-text">{{ installProgress.message }}</span>
              </div>
              <div v-if="installError" class="install-error">{{ installError }}</div>
            </div>
          </Transition>
        </div>
      </Transition>
    </div>

    <!-- 默认JVM参数 -->
    <div class="card setting-group">
      <h3>默认内存</h3>
      <div class="memory-row">
        <label>最小: {{ settings.defaultMinMemory }} MB</label>
        <input type="range" v-model.number="settings.defaultMinMemory" :min="256" :max="settings.defaultMaxMemory" :step="128" />
      </div>
      <div class="memory-row">
        <label>最大: {{ settings.defaultMaxMemory }} MB</label>
        <input type="range" v-model.number="settings.defaultMaxMemory" :min="settings.defaultMinMemory" :max="settings.totalMemory" :step="128" />
      </div>
    </div>

    <!-- 游戏目录管理 -->
    <div class="card setting-group java-panel-wrapper" :class="{ 'panel-open': gameDirExpanded }">
      <div class="java-panel-trigger" @click="toggleGameDirPanel">
        <div class="trigger-info">
          <h3>游戏目录管理</h3>
          <p class="text-hint">管理多个游戏目录，自动扫描已有实例</p>
        </div>
        <span class="trigger-arrow" :class="{ open: gameDirExpanded }">▾</span>
      </div>

      <Transition name="jdrop">
        <div v-if="gameDirExpanded" class="java-cascade">
          <!-- 目录列表 -->
          <div class="gamedir-list">
            <div
              v-for="dir in settings.gameDirs" :key="dir"
              class="gamedir-row"
            >
              <div class="gamedir-info">
                <span class="gamedir-path">{{ dir }}</span>
                <span class="gamedir-meta">
                  {{ profileCountForDir(dir) }} 个实例
                  <span v-if="dir === settings.defaultGameDir" class="gamedir-badge">默认</span>
                </span>
              </div>
              <div class="gamedir-actions">
                <button
                  v-if="dir !== settings.defaultGameDir"
                  class="btn-remove"
                  @click.stop="settings.removeGameDir(dir)"
                  title="移除此目录"
                >✕</button>
              </div>
            </div>
          </div>

          <!-- 添加目录按钮 -->
          <button class="btn-secondary gamedir-add-btn" :disabled="scanning" @click="handleAddGameDir">
            {{ scanning ? '扫描中...' : '+ 添加游戏目录' }}
          </button>
        </div>
      </Transition>
    </div>

    <!-- 并行下载 -->
    <div class="card setting-group">
      <h3>并行下载数</h3>
      <div class="memory-row">
        <label>{{ settings.downloadConcurrency }}</label>
        <input type="range" v-model.number="settings.downloadConcurrency" :min="1" :max="64" :step="1" />
      </div>
    </div>

    <!-- Azure Client ID -->
    <div class="card setting-group">
      <h3>Azure Client ID</h3>
      <p class="hint">用于微软账号登录的 Azure AD 应用 Client ID。如遇到 403 "Invalid app registration" 错误，请更换为已在 Xbox 开发者中心注册的 Client ID。</p>
      <div class="input-row">
        <input
          :value="settings.clientId"
          placeholder="c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb"
          @change="settings.setClientIdValue(($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>

    <!-- P2P 联机设置 -->
    <div class="card setting-group">
      <h3>P2P 联机</h3>

      <label class="field-label">信令服务器</label>
      <input v-model="settings.signalingServer" placeholder="wss://your-signaling-server.example.com" class="full-input" />
      <p class="hint">WebSocket 信令服务器地址，用于房间管理和 NAT 穿透协商。</p>

      <label class="field-label mt-field">STUN 服务器</label>
      <div class="tag-list">
        <span v-for="(s, i) in settings.stunServers" :key="i" class="tag">
          {{ s }}
          <button class="tag-remove" @click="settings.stunServers.splice(i, 1)" title="移除">&times;</button>
        </span>
      </div>
      <p class="hint">用于 NAT 穿透的 STUN 服务器列表。</p>

      <label class="field-label mt-field">TURN 中继服务器</label>
      <div class="turn-list">
        <div v-for="(t, i) in settings.turnServers" :key="i" class="turn-item">
          <span class="turn-url">{{ Array.isArray(t.urls) ? t.urls[0] : t.urls }}</span>
          <span class="turn-source">{{ t.source }}</span>
          <button v-if="t.source === 'custom'" class="tag-remove" @click="settings.removeCustomTurn(i)" title="移除">&times;</button>
        </div>
      </div>

      <details class="mt-field">
        <summary class="add-turn-label">+ 添加自定义 TURN</summary>
        <div class="add-turn-form">
          <input v-model="customTurnUrl" placeholder="turn:host:port?transport=tcp" class="full-input" />
          <div class="input-row mt-sm">
            <input v-model="customTurnUser" placeholder="用户名 (可选)" />
            <input v-model="customTurnPass" type="password" placeholder="密码 (可选)" />
          </div>
          <button class="btn-secondary mt-sm" @click="addTurn" :disabled="!customTurnUrl.trim()">添加</button>
        </div>
      </details>

      <div class="toggle-row mt-field">
        <label><input type="checkbox" v-model="settings.enableIPv6" /> 启用 IPv6</label>
        <p class="hint">校园网环境下推荐开启，可提升 NAT 穿透成功率。</p>
      </div>

      <div class="toggle-row mt-field">
        <label><input type="checkbox" v-model="settings.relayFallback" /> 启用 WS 中继回退</label>
        <p class="hint">WebRTC 连接失败时通过中继服务器转发数据，延迟较高但保证连通。</p>
      </div>

      <label class="field-label mt-field">中继服务器列表</label>
      <p class="hint">独立的 WebSocket 中继端点，当信令服务器中继失败时依次尝试。可部署在国内云函数 (腾讯云 SCF / 阿里云 FC) 或 Cloudflare Worker。</p>
      <div class="tag-list" v-if="settings.relayServers.length">
        <span v-for="(r, i) in settings.relayServers" :key="i" class="tag">
          {{ r }}
          <button class="tag-remove" @click="settings.removeRelayServer(i)" title="移除">&times;</button>
        </span>
      </div>
      <div class="input-row mt-sm">
        <input v-model="newRelayUrl" placeholder="wss://service-xxx.gz.apigw.tencentcs.com/release/" class="full-input" @keyup.enter="settings.addRelayServer(newRelayUrl.trim()); newRelayUrl = ''" />
        <button class="btn-secondary" @click="settings.addRelayServer(newRelayUrl.trim()); newRelayUrl = ''" :disabled="!newRelayUrl.trim()">添加</button>
      </div>
    </div>

    <!-- 自动更新 -->
    <div class="card setting-group">
      <h3>软件更新</h3>
      <p class="hint" style="margin-bottom: 8px">当前版本: v{{ appVersion }}</p>

      <div v-if="updateStatus.status === 'idle'" class="update-row">
        <span class="text-muted">点击检查是否有新版本</span>
        <button class="btn-secondary" @click="checkUpdate">检查更新</button>
      </div>

      <div v-else-if="updateStatus.status === 'checking'" class="update-row">
        <span class="text-muted">正在检查...</span>
      </div>

      <div v-else-if="updateStatus.status === 'not-available'" class="update-row">
        <span class="text-muted">✅ 当前已是最新版本</span>
        <button class="btn-secondary" @click="checkUpdate">重新检查</button>
      </div>

      <div v-else-if="updateStatus.status === 'available'" class="update-info">
        <p><strong>发现新版本 {{ updateStatus.version }}</strong></p>
        <p v-if="updateStatus.releaseNotes" class="hint release-notes">{{ updateStatus.releaseNotes }}</p>
        <button class="btn-primary" @click="downloadUpdate">下载更新</button>
      </div>

      <div v-else-if="updateStatus.status === 'downloading'" class="update-info">
        <p class="text-muted">正在下载 {{ updateStatus.version }}...</p>
        <div v-if="updateStatus.progress" class="update-progress">
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: updateStatus.progress.percent.toFixed(1) + '%' }"></div>
          </div>
          <span class="progress-text">
            {{ updateStatus.progress.percent.toFixed(1) }}% · {{ formatBytes(updateStatus.progress.bytesPerSecond) }}/s
            · {{ formatBytes(updateStatus.progress.transferred) }} / {{ formatBytes(updateStatus.progress.total) }}
          </span>
        </div>
      </div>

      <div v-else-if="updateStatus.status === 'downloaded'" class="update-info">
        <p><strong>✅ 下载完成</strong></p>
        <p class="hint">点击「立即安装」将退出并安装更新。</p>
        <button class="btn-primary" @click="installUpdateNow">立即安装</button>
      </div>

      <div v-else-if="updateStatus.status === 'error'" class="update-info">
        <p class="error-text">更新失败: {{ updateStatus.error }}</p>
        <button class="btn-secondary" @click="checkUpdate">重试</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-page { max-width: 560px; }
h2 { margin-bottom: 16px; }
.setting-group { margin-bottom: 12px; }
.setting-group h3 { font-size: 15px; margin-bottom: 8px; }

/* 主题切换 */
.theme-switcher {
  display: flex; gap: 8px;
}
.theme-btn {
  flex: 1;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 10px 0;
  background: var(--bg-secondary);
  border: 2px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: 13px;
  transition: all 0.2s;
}
.theme-btn:hover {
  border-color: var(--text-muted);
  color: var(--text-primary);
}
.theme-btn.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--bg-hover);
}
.theme-icon { font-size: 16px; }

.radio-group { display: flex; flex-direction: column; gap: 6px; }
.radio-group label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.input-row { display: flex; gap: 8px; }
.input-row input { flex: 1; }
.memory-row { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
.memory-row label { min-width: 140px; font-size: 13px; }
.memory-row input[type=range] { flex: 1; }
.hint { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
.full-input { width: 100%; }
.field-label { font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px; }
.mt-field { margin-top: 12px; }
.mt-sm { margin-top: 6px; }
.tag-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
.tag {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--bg-secondary, #2a2a2a); border-radius: 4px;
  padding: 3px 8px; font-size: 12px; font-family: monospace;
}
.tag-remove {
  background: none; border: none; color: var(--text-muted); cursor: pointer;
  font-size: 14px; line-height: 1; padding: 0 2px;
}
.tag-remove:hover { color: var(--danger); }
.turn-list { margin-bottom: 4px; }
.turn-item {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 0; font-size: 12px; font-family: monospace;
}
.turn-url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.turn-source {
  font-size: 11px; padding: 1px 6px; border-radius: 3px;
  background: var(--bg-secondary); color: var(--text-muted); font-family: sans-serif;
}
.add-turn-label { font-size: 13px; color: var(--primary, #5b9bd5); cursor: pointer; }
.add-turn-form { margin-top: 8px; }
.toggle-row label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.toggle-row .hint { margin-top: 2px; margin-bottom: 0; }

/* Java 运行时下载 - 级联面板 */
.java-panel-wrapper { padding: 0; overflow: hidden; }
.java-panel-trigger {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; cursor: pointer; user-select: none;
  transition: background 0.15s;
}
.java-panel-trigger:hover { background: var(--bg-hover); }
.trigger-info h3 { font-size: 15px; margin-bottom: 2px; }
.trigger-info .text-hint { margin: 0; }
.trigger-arrow {
  font-size: 18px; color: var(--text-muted);
  transition: transform 0.25s ease;
}
.trigger-arrow.open { transform: rotate(180deg); }

.java-cascade { padding: 0 20px 16px; display: flex; flex-direction: column; gap: 12px; }

/* 发行版卡片 */
.distro-cards { display: flex; gap: 8px; }
.distro-card {
  flex: 1; display: flex; flex-direction: column; gap: 2px;
  padding: 12px 14px; border-radius: var(--radius);
  border: 1.5px solid var(--border); background: var(--bg-secondary);
  cursor: pointer; transition: all 0.2s; user-select: none;
}
.distro-card:hover { border-color: var(--text-muted); background: var(--bg-hover); }
.distro-card.active { border-color: var(--accent); background: var(--bg-hover); }
.distro-card strong { font-size: 13px; color: var(--text-primary); }
.distro-desc { font-size: 11px; color: var(--text-muted); line-height: 1.3; }

/* 版本列表 */
.java-version-list {
  display: flex; flex-direction: column; gap: 4px;
}
.java-version-row {
  display: flex; align-items: center;
  padding: 8px 14px; border-radius: 6px;
  background: var(--bg-secondary);
  transition: background 0.15s;
}
.java-version-row:hover { background: var(--bg-hover); }
.jv-name { font-size: 13px; font-weight: 600; color: var(--text-primary); flex: 1; }
.jv-installed { font-size: 12px; color: var(--accent); font-weight: 500; margin-right: 4px; }
.jv-right { margin-left: auto; }
.btn-install {
  padding: 4px 16px; font-size: 12px; border-radius: 4px;
  background: var(--accent); color: #fff; cursor: pointer; border: none;
  transition: background 0.2s; white-space: nowrap;
}
.btn-install:hover { background: var(--accent-hover); }
.btn-install:disabled { opacity: 0.5; cursor: not-allowed; }

/* 安装进度 */
.install-progress { margin-top: 4px; }
.progress-bar {
  height: 6px; border-radius: 3px; background: var(--bg-secondary); overflow: hidden; margin-bottom: 4px;
}
.progress-fill {
  height: 100%; background: var(--accent); border-radius: 3px;
  transition: width 0.3s ease;
}
.progress-text { font-size: 11px; color: var(--text-muted); }
.install-error {
  margin-top: 4px; padding: 8px 12px; border-radius: 6px;
  background: rgba(231, 76, 60, 0.1); color: var(--danger); font-size: 13px;
}

/* 展开动画 */
.jdrop-enter-active, .jdrop-leave-active {
  transition: all 0.25s ease;
  overflow: hidden;
}
.jdrop-enter-from, .jdrop-leave-to {
  opacity: 0; max-height: 0; padding-top: 0; padding-bottom: 0;
}
.jdrop-enter-to, .jdrop-leave-from {
  opacity: 1; max-height: 600px;
}

/* 游戏目录管理 */
.gamedir-list {
  display: flex; flex-direction: column; gap: 4px;
}
.gamedir-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-radius: 6px;
  background: var(--bg-secondary);
  transition: background 0.15s;
}
.gamedir-row:hover { background: var(--bg-hover); }
.gamedir-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.gamedir-path {
  font-size: 13px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gamedir-meta { font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.gamedir-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 3px;
  background: var(--accent); color: #fff; font-weight: 600;
}
.gamedir-actions { margin-left: 8px; flex-shrink: 0; }
.btn-remove {
  background: none; border: none; color: var(--text-muted); cursor: pointer;
  font-size: 14px; padding: 4px 6px; border-radius: 4px;
  transition: all 0.15s;
}
.btn-remove:hover { color: var(--danger); background: rgba(231, 76, 60, 0.1); }
.gamedir-add-btn { width: 100%; text-align: center; }

/* 自动更新 */
.update-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.update-info { display: flex; flex-direction: column; gap: 8px; }
.update-progress { margin-top: 4px; }
.release-notes {
  max-height: 80px; overflow-y: auto; white-space: pre-wrap;
  background: var(--bg-secondary); border-radius: 4px; padding: 8px;
}
.error-text { color: var(--danger, #e74c3c); font-size: 13px; }
</style>
