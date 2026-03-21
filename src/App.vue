<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSettingsStore } from './stores/settings'
import { useProfilesStore } from './stores/profiles'
import { useAuthStore } from './stores/auth'
import { globalUpdateStatus } from './composables/useUpdateStatus'
import Sidebar from './components/Sidebar.vue'
import TitleBar from './components/TitleBar.vue'
import RightBar from './components/RightBar.vue'

const router = useRouter()
const settings = useSettingsStore()
const profiles = useProfilesStore()
const auth = useAuthStore()

// 更新 toast
const showUpdateToast = ref(false)
const updateToastVersion = ref('')

// 立刻应用保存的主题（避免闪白）
settings.applyTheme(settings.theme)
// 监听系统主题变化（system 模式下自动切换）
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'system') settings.applyTheme('system')
})

// 全局监听自动更新状态
window.api.updater.onStatus((s: any) => {
  globalUpdateStatus.value = s
  if (s.status === 'available' && s.version) {
    updateToastVersion.value = s.version
    showUpdateToast.value = true
  }
})

function goToUpdate() {
  showUpdateToast.value = false
  router.push('/settings')
}

function dismissToast() {
  showUpdateToast.value = false
}

onMounted(async () => {
  await settings.init()
  await profiles.fetchProfiles()
  for (const dir of settings.gameDirs) {
    await profiles.scanDir(dir)
  }
  await auth.init()
})
</script>

<template>
  <div class="app-layout">
    <TitleBar />
    <!-- 更新提示 toast -->
    <Transition name="toast">
      <div v-if="showUpdateToast" class="update-toast">
        <span>🎉 发现新版本 <strong>{{ updateToastVersion }}</strong></span>
        <div class="toast-actions">
          <button class="toast-btn primary" @click="goToUpdate">前往更新</button>
          <button class="toast-btn" @click="dismissToast">稍后</button>
        </div>
      </div>
    </Transition>
    <div class="app-body">
      <Sidebar />
      <main class="app-content">
        <router-view v-slot="{ Component }">
          <Transition name="page" mode="out-in">
            <component :is="Component" :key="$route.path" />
          </Transition>
        </router-view>
      </main>
      <RightBar />
    </div>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-primary);
  color: var(--text-primary);
}
.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.app-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}
/* 更新 toast */
.update-toast {
  position: fixed;
  top: 40px;
  right: 16px;
  z-index: 9999;
  background: var(--bg-card, #1e2233);
  border: 1px solid var(--accent, #4ade80);
  border-radius: 12px;
  padding: 14px 18px;
  display: flex;
  align-items: center;
  gap: 14px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.4);
  font-size: 14px;
  color: var(--text-primary);
}
.toast-actions {
  display: flex;
  gap: 8px;
}
.toast-btn {
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--border, #333);
  background: transparent;
  color: var(--text-secondary, #aaa);
  cursor: pointer;
  font-size: 13px;
}
.toast-btn.primary {
  background: var(--accent, #4ade80);
  color: #000;
  border-color: transparent;
  font-weight: 600;
}
.toast-btn:hover {
  opacity: 0.85;
}
.toast-enter-active, .toast-leave-active {
  transition: all 0.3s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(40px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(40px);
}
</style>
