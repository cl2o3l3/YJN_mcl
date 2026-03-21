<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSettingsStore } from '../stores/settings'
import { useProfilesStore } from '../stores/profiles'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const settings = useSettingsStore()
const profiles = useProfilesStore()
const auth = useAuthStore()

// 向导步骤
type Step = 'welcome' | 'config' | 'installing' | 'done'
const step = ref<Step>('welcome')

// 配置项
const installDir = ref('')
const gameDir = ref('')
const createDesktopShortcut = ref(true)
const createStartMenuShortcut = ref(true)

// 安装状态
const installing = ref(false)
const installError = ref('')
const installProgress = ref('')

onMounted(async () => {
  const defaults = await window.api.installer.getDefaults()
  installDir.value = defaults.installDir
  gameDir.value = defaults.gameDir
})

async function browseInstallDir() {
  const dir = await window.api.installer.selectDir(installDir.value)
  if (dir) installDir.value = dir
}

async function browseGameDir() {
  const dir = await window.api.installer.selectDir(gameDir.value)
  if (dir) gameDir.value = dir
}

async function startInstall() {
  step.value = 'installing'
  installing.value = true
  installError.value = ''

  try {
    installProgress.value = '正在创建安装目录...'

    const opts = {
      installDir: installDir.value,
      createDesktopShortcut: createDesktopShortcut.value,
      createStartMenuShortcut: createStartMenuShortcut.value,
      gameDir: gameDir.value
    }
    console.log('[Setup] install opts', opts)

    const result = await window.api.installer.install(opts)
    console.log('[Setup] install result', result)

    if (!result.success) {
      installError.value = result.error || '安装失败'
      step.value = 'config'
      return
    }

    installProgress.value = '正在完成配置...'
    // 标记安装完成
    settings.completeSetup(gameDir.value)

    step.value = 'done'
  } catch (err: any) {
    console.error('[Setup] install error', err)
    installError.value = String(err?.message || err)
    step.value = 'config'
  } finally {
    installing.value = false
  }
}

async function enterApp() {
  // 初始化应用数据
  await profiles.fetchProfiles()
  for (const dir of settings.gameDirs) {
    await profiles.scanDir(dir)
  }
  await auth.init()
  router.replace('/')
}
</script>

<template>
  <div class="setup-container">
    <!-- 欢迎页 -->
    <div v-if="step === 'welcome'" class="setup-card">
      <div class="setup-icon">🎮</div>
      <h1 class="setup-title">欢迎使用 YJN</h1>
      <p class="setup-subtitle">Minecraft Java 版启动器</p>
      <p class="setup-desc">
        一键安装、启动、管理你的 Minecraft 游戏。<br />
        支持多版本、模组管理、P2P 联机等功能。
      </p>
      <button class="btn-primary setup-btn" @click="step = 'config'">
        开始安装
      </button>
    </div>

    <!-- 配置页 -->
    <div v-else-if="step === 'config'" class="setup-card wide">
      <h2 class="setup-title">安装配置</h2>
      <p class="setup-desc">请设置安装位置和游戏目录。</p>

      <div class="form-group">
        <label>安装位置</label>
        <p class="form-hint">程序文件将存放在此目录</p>
        <div class="path-row">
          <input class="path-input" v-model="installDir" readonly />
          <button class="btn-secondary" @click="browseInstallDir">浏览</button>
        </div>
      </div>

      <div class="form-group">
        <label>游戏目录 (.minecraft)</label>
        <p class="form-hint">Minecraft 的版本文件、存档、模组等将保存在此</p>
        <div class="path-row">
          <input class="path-input" v-model="gameDir" readonly />
          <button class="btn-secondary" @click="browseGameDir">浏览</button>
        </div>
      </div>

      <div class="form-group checkbox-group">
        <label class="checkbox-label">
          <input type="checkbox" v-model="createDesktopShortcut" />
          创建桌面快捷方式
        </label>
        <label class="checkbox-label">
          <input type="checkbox" v-model="createStartMenuShortcut" />
          创建开始菜单快捷方式
        </label>
      </div>

      <p v-if="installError" class="error-text">{{ installError }}</p>

      <div class="setup-actions">
        <button class="btn-text" @click="step = 'welcome'">返回</button>
        <button class="btn-primary setup-btn" @click="startInstall" :disabled="!installDir || !gameDir">
          安装
        </button>
      </div>
    </div>

    <!-- 安装中 -->
    <div v-else-if="step === 'installing'" class="setup-card">
      <div class="spinner-large"></div>
      <h2 class="setup-title">正在安装</h2>
      <p class="setup-desc">{{ installProgress }}</p>
    </div>

    <!-- 完成 -->
    <div v-else-if="step === 'done'" class="setup-card">
      <div class="setup-icon">✅</div>
      <h2 class="setup-title">安装完成</h2>
      <p class="setup-desc">YJN 已准备就绪，现在可以开始使用了。</p>
      <button class="btn-primary setup-btn" @click="enterApp">
        开始使用
      </button>
    </div>
  </div>
</template>

<style scoped>
.setup-container {
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 40px 24px;
}

.setup-card {
  background: var(--bg-card, #1e2233);
  border-radius: 16px;
  padding: 48px 40px;
  max-width: 440px;
  width: 100%;
  text-align: center;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}
.setup-card.wide {
  max-width: 520px;
  text-align: left;
}

.setup-icon {
  font-size: 56px;
  margin-bottom: 16px;
}

.setup-title {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--text-primary);
}

.setup-subtitle {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.setup-desc {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: 24px;
}

.setup-btn {
  padding: 10px 32px;
  font-size: 15px;
  border-radius: 8px;
  min-width: 140px;
}

.form-group {
  margin-bottom: 20px;
}
.form-group label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--text-primary);
}
.form-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.path-row {
  display: flex;
  gap: 8px;
}
.path-input {
  flex: 1;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color, #333);
  background: var(--bg-secondary, #161927);
  color: var(--text-primary);
  font-size: 13px;
  cursor: default;
}

.checkbox-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 400 !important;
  cursor: pointer;
  color: var(--text-primary);
}
.checkbox-label input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent-color, #4ecdc4);
}

.setup-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 24px;
}

.error-text {
  color: #e74c3c;
  font-size: 13px;
  margin-top: 8px;
}

.spinner-large {
  width: 48px;
  height: 48px;
  border: 4px solid var(--border-color, #333);
  border-top-color: var(--accent-color, #4ecdc4);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto 20px;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
