<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, toRaw } from 'vue'
import { useProfilesStore } from '../stores/profiles'
import { useAuthStore } from '../stores/auth'
import { useLaunchStore } from '../stores/launch'
import { useModloaderStore } from '../stores/modloader'
import { useTasksStore } from '../stores/tasks'
import { useNotificationsStore } from '../stores/notifications'
import type { MinecraftAccount } from '../types'

const profiles = useProfilesStore()
const auth = useAuthStore()
const launch = useLaunchStore()
const modloader = useModloaderStore()
const tasksStore = useTasksStore()
const notifsStore = useNotificationsStore()

const installingLoader = ref(false)

/** 账号头像 */
function nameHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

function defaultAvatar(account: MinecraftAccount): string {
  const hue = nameHue(account.username)
  const letter = account.username[0]?.toUpperCase() || '?'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">
    <rect width="48" height="48" rx="6" fill="hsl(${hue},45%,35%)"/>
    <text x="24" y="32" text-anchor="middle" fill="#fff" font-size="22" font-family="sans-serif" font-weight="bold">${letter}</text>
  </svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

const avatarCache = ref<Record<string, string>>({})

async function loadAvatar(account: MinecraftAccount) {
  if (avatarCache.value[account.id]) return
  avatarCache.value[account.id] = defaultAvatar(account)
  const urls: string[] = []
  if (account.type === 'microsoft') {
    const raw = account.uuid.replace(/-/g, '')
    urls.push(`https://crafatar.com/avatars/${raw}?overlay&size=48`, `https://mc-heads.net/avatar/${raw}/48`)
  } else if (account.type === 'yggdrasil' && account.yggdrasilServer) {
    const raw = account.uuid.replace(/-/g, '')
    const serverBase = account.yggdrasilServer.replace(/\/api\/yggdrasil\/?$/, '')
    urls.push(`${serverBase}/avatar/${raw}?size=48`, `https://crafatar.com/avatars/${raw}?overlay&size=48`)
  } else {
    urls.push(`https://minotar.net/helm/${encodeURIComponent(account.username)}/48`, `https://mc-heads.net/avatar/${encodeURIComponent(account.username)}/48`)
  }
  for (const url of urls) {
    try {
      const dataUri = await window.api.auth.fetchAvatar(url)
      if (dataUri) { avatarCache.value[account.id] = dataUri; return }
    } catch { /* next */ }
  }
}

function getAvatar(account: MinecraftAccount): string {
  if (!avatarCache.value[account.id]) loadAvatar(account)
  return avatarCache.value[account.id] || defaultAvatar(account)
}

const selectedAvatar = computed(() => auth.selectedAccount ? getAvatar(auth.selectedAccount) : '')

watch(() => auth.selectedAccount, (acc) => { if (acc) loadAvatar(acc) }, { immediate: true })

let cleanupEvents: (() => void) | null = null

onMounted(() => {
  cleanupEvents = launch.listenGameEvents()
})

onUnmounted(() => {
  cleanupEvents?.()
})

async function handleLaunch() {
  if (!profiles.selected) return
  if (!auth.selectedAccount) {
    alert('请先在账号页面登录')
    return
  }

  launch.isLaunching = true
  launch.error = ''

  try {
    const profile = profiles.selected
    let versionId = profile.versionId

    // 如果设置了 Mod Loader，先安装 loader（生成版本 JSON）
    if (profile.modLoader) {
      installingLoader.value = true
      try {
        versionId = await modloader.install(
          profile.modLoader.type,
          profile.versionId,
          profile.modLoader.version,
          profile.gameDir,
          profile.javaPath || undefined
        )
      } finally {
        installingLoader.value = false
      }
    }

    // 安装/补全游戏文件
    const taskId = tasksStore.addTask('game', `启动 ${profile.name}`)
    const unsubProgress = window.api.download.onProgress((p) => {
      launch.downloadProgress = p
      tasksStore.updateProgress(taskId, { completed: p.completed, total: p.total, speed: p.speed })
    })
    await window.api.download.installVersion(versionId, profile.gameDir)
    unsubProgress()
    launch.downloadProgress = null
    tasksStore.completeTask(taskId)

    // 如果 modLoader 安装改变了 versionId，更新 profile 以便后续启动用正确的 id
    if (profile.modLoader && versionId !== profile.versionId) {
      // 启动时使用 loader 版本 id
    }

    // 启动游戏
    launch.isRunning = true
    // toRaw: 移除 Vue reactive proxy，避免 IPC structured clone 失败
    const rawAccount = JSON.parse(JSON.stringify(toRaw(auth.selectedAccount)))
    await window.api.launch.start(profile.id, rawAccount)
  } catch (e: unknown) {
    launch.error = e instanceof Error ? e.message : String(e)
    launch.isRunning = false
    notifsStore.push('error', `启动失败: ${launch.error}`)
  } finally {
    launch.isLaunching = false
  }
}
</script>

<template>
  <div class="home">
    <h1>MC Launcher</h1>
    <p class="subtitle">Minecraft Java 版启动器</p>

    <div class="launch-section card" v-if="profiles.selected">
      <div class="profile-info">
        <h3>{{ profiles.selected.name }}</h3>
        <p class="text-muted">
          {{ profiles.selected.versionId }}
          {{ profiles.selected.modLoader ? ` · ${profiles.selected.modLoader.type} ${profiles.selected.modLoader.version}` : '' }}
          · {{ profiles.selected.gameDir }}
        </p>
      </div>

      <!-- 当前账号 -->
      <div v-if="auth.selectedAccount" class="account-row">
        <img class="account-avatar" :src="selectedAvatar" :alt="auth.selectedAccount.username" />
        <div class="account-info">
          <span class="account-name">{{ auth.selectedAccount.username }}</span>
          <span class="account-type-badge" :class="auth.selectedAccount.type === 'microsoft' ? 'type-ms' : auth.selectedAccount.type === 'yggdrasil' ? 'type-ygg' : 'type-offline'">
            {{ auth.selectedAccount.type === 'microsoft' ? '正版' : auth.selectedAccount.type === 'yggdrasil' ? '外置' : '离线' }}
          </span>
        </div>
        <router-link to="/login" class="switch-link">切换</router-link>
      </div>
      <div v-else class="account-row">
        <router-link to="/login" class="btn-secondary btn-sm">去登录</router-link>
      </div>

      <!-- Mod Loader 安装中 -->
      <div v-if="installingLoader" class="progress-section">
        <span class="progress-text">正在安装 Mod Loader…</span>
      </div>

      <!-- 下载进度 -->
      <div v-if="launch.downloadProgress" class="progress-section">
        <div class="progress-bar">
          <div
            class="progress-fill"
            :style="{ width: `${(launch.downloadProgress.completed / launch.downloadProgress.total) * 100}%` }"
          />
        </div>
        <span class="progress-text">
          {{ launch.downloadProgress.completed }} / {{ launch.downloadProgress.total }}
          {{ launch.downloadProgress.currentFile ? `· ${launch.downloadProgress.currentFile}` : '' }}
        </span>
      </div>

      <button
        class="btn-primary launch-btn"
        @click="handleLaunch"
        :disabled="launch.isLaunching || launch.isRunning"
      >
        {{ launch.isLaunching ? '准备中...' : launch.isRunning ? '游戏运行中' : '启动游戏' }}
      </button>

      <p v-if="launch.error" class="error-text">{{ launch.error }}</p>
    </div>

    <div v-else class="card">
      <p>还没有游戏实例，前往 <router-link to="/profiles">实例管理</router-link> 创建一个</p>
    </div>

    <!-- 游戏日志 -->
    <div v-if="launch.gameLogs.length > 0" class="card log-card">
      <h4>游戏日志</h4>
      <pre class="log-output">{{ launch.gameLogs.slice(-50).join('') }}</pre>
    </div>
  </div>
</template>

<style scoped>
.home { max-width: 700px; }
h1 { font-size: 28px; margin-bottom: 4px; }
.subtitle { color: var(--text-secondary); margin-bottom: 24px; }
.launch-section { display: flex; flex-direction: column; gap: 12px; transition: transform 0.2s, box-shadow 0.2s; }
.launch-section:hover { transform: translateY(-2px); box-shadow: 0 4px 16px rgba(0,0,0,0.2); }
.profile-info h3 { font-size: 18px; }
.text-muted { color: var(--text-muted); font-size: 13px; }
.launch-btn {
  font-size: 16px; padding: 12px 32px; align-self: flex-start;
}
.progress-section { display: flex; flex-direction: column; gap: 4px; }
.progress-bar {
  height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden;
}
.progress-fill {
  height: 100%; background: var(--accent); transition: width 0.3s;
  background-image: linear-gradient(
    -45deg,
    rgba(255, 255, 255, 0.1) 25%, transparent 25%,
    transparent 50%, rgba(255, 255, 255, 0.1) 50%,
    rgba(255, 255, 255, 0.1) 75%, transparent 75%
  );
  background-size: 30px 30px;
  animation: stripe-scroll 0.8s linear infinite;
}
.progress-text { font-size: 12px; color: var(--text-muted); }
.error-text { color: var(--danger); font-size: 13px; }
.log-card { margin-top: 16px; }

/* === 账号行 === */
.account-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.account-avatar {
  width: 36px; height: 36px;
  border-radius: 4px;
  image-rendering: pixelated;
  flex-shrink: 0;
}
.account-info { display: flex; align-items: center; gap: 8px; flex: 1; }
.account-name { font-weight: 600; font-size: 14px; }
.account-type-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600;
}
.type-ms { background: #166534; color: #4ade80; }
.type-offline { background: #1e3a5f; color: #60a5fa; }
.type-ygg { background: #6b21a8; color: #c084fc; }
.switch-link { font-size: 12px; color: var(--accent); text-decoration: none; }
.switch-link:hover { text-decoration: underline; }
.log-output {
  background: var(--bg-secondary); padding: 8px; border-radius: 4px;
  font-size: 11px; max-height: 200px; overflow-y: auto; white-space: pre-wrap;
  color: var(--text-secondary); font-family: 'Cascadia Mono', monospace;
}
</style>
