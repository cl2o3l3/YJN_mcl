<script setup lang="ts">
import { onMounted } from 'vue'
import { useSettingsStore } from './stores/settings'
import { useProfilesStore } from './stores/profiles'
import { useAuthStore } from './stores/auth'
import Sidebar from './components/Sidebar.vue'
import TitleBar from './components/TitleBar.vue'
import RightBar from './components/RightBar.vue'

const settings = useSettingsStore()
const profiles = useProfilesStore()
const auth = useAuthStore()

// 立刻应用保存的主题（避免闪白）
settings.applyTheme(settings.theme)
// 监听系统主题变化（system 模式下自动切换）
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'system') settings.applyTheme('system')
})
onMounted(async () => {
  await settings.init()
  await profiles.fetchProfiles()
  // 自动扫描所有游戏目录中的已有实例
  for (const dir of settings.gameDirs) {
    await profiles.scanDir(dir)
  }
  await auth.init()
})
</script>

<template>
  <div class="app-layout">
    <TitleBar />
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
</style>
