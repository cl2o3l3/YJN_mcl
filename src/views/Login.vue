<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import type { MinecraftAccount, YggdrasilServerInfo } from '../types'

const auth = useAuthStore()
const offlineUsername = ref('')

/** 根据用户名生成一个稳定的色相值 */
function nameHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

/** 生成内联 SVG data URI 作为默认头像 */
function defaultAvatar(account: MinecraftAccount): string {
  const hue = nameHue(account.username)
  const letter = account.username[0]?.toUpperCase() || '?'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
    <rect width="64" height="64" rx="8" fill="hsl(${hue},45%,35%)"/>
    <text x="32" y="42" text-anchor="middle" fill="#fff" font-size="28" font-family="sans-serif" font-weight="bold">${letter}</text>
  </svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

/** 头像缓存 */
const avatarCache = ref<Record<string, string>>({})

async function loadAvatar(account: MinecraftAccount) {
  if (avatarCache.value[account.id]) return
  avatarCache.value[account.id] = defaultAvatar(account)

  const urls: string[] = []
  if (account.type === 'microsoft') {
    const raw = account.uuid.replace(/-/g, '')
    urls.push(
      `https://crafatar.com/avatars/${raw}?overlay&size=64`,
      `https://mc-heads.net/avatar/${raw}/64`
    )
  } else if (account.type === 'yggdrasil' && account.yggdrasilServer) {
    // 第三方皮肤站: 通过 Yggdrasil API 获取头像
    const raw = account.uuid.replace(/-/g, '')
    const serverBase = account.yggdrasilServer.replace(/\/api\/yggdrasil\/?$/, '')
    urls.push(
      `${account.yggdrasilServer}textures/avatar/${raw}?size=64`,
      `${serverBase}/avatar/${raw}?size=64`,
      `https://crafatar.com/avatars/${raw}?overlay&size=64`
    )
  } else {
    urls.push(
      `https://minotar.net/helm/${encodeURIComponent(account.username)}/64`,
      `https://mc-heads.net/avatar/${encodeURIComponent(account.username)}/64`
    )
  }

  for (const url of urls) {
    try {
      const dataUri = await window.api.auth.fetchAvatar(url)
      if (dataUri) {
        avatarCache.value[account.id] = dataUri
        return
      }
    } catch { /* try next */ }
  }
}

function getAvatar(account: MinecraftAccount): string {
  if (!avatarCache.value[account.id]) loadAvatar(account)
  return avatarCache.value[account.id] || defaultAvatar(account)
}

watch(() => auth.accounts, (accs) => {
  for (const a of accs) loadAvatar(a)
}, { immediate: true })

function loginOffline() {
  if (!offlineUsername.value.trim()) return
  auth.addOfflineAccount(offlineUsername.value.trim())
  offlineUsername.value = ''
}

function startMsLogin() {
  auth.startMsLogin()
}

function cancelMsLogin() {
  auth.cancelMsLogin()
  showGuideModal.value = false
}

/** 引导弹窗 */
const showGuideModal = ref(false)

watch(() => auth.deviceCode, (code) => {
  if (code) showGuideModal.value = true
})

async function confirmAndOpenBrowser() {
  if (auth.deviceCode) {
    await navigator.clipboard.writeText(auth.deviceCode)
  }
  if (auth.verificationUri) {
    window.api.auth.openUrl(auth.verificationUri)
  }
  showGuideModal.value = false
}

const stateText: Record<string, string> = {
  waitingForCode: '正在获取验证码...',
  polling: '等待浏览器授权...',
  exchanging: '正在验证令牌...',
  success: '登录成功！',
  error: '登录失败'
}

// ========== 第三方登录 ==========
const yggServerInput = ref('')
const yggUsername = ref('')
const yggPassword = ref('')
const yggSelectedServer = ref<YggdrasilServerInfo | null>(null)
const presetServers = ref<{ name: string; url: string; homepage?: string; register?: string }[]>([])
const showAddServerModal = ref(false)
const addServerLoading = ref(false)
const addServerError = ref('')

onMounted(async () => {
  try {
    presetServers.value = await auth.getPresetServers()
  } catch { /* ignore */ }
})

function accountBadge(type: string): { label: string; cls: string } {
  if (type === 'microsoft') return { label: '正版', cls: 'badge-ms' }
  if (type === 'yggdrasil') return { label: '外置', cls: 'badge-ygg' }
  return { label: '离线', cls: 'badge-offline' }
}

async function addServerFromInput() {
  addServerLoading.value = true
  addServerError.value = ''
  try {
    await auth.addYggdrasilServer(yggServerInput.value.trim())
    yggServerInput.value = ''
    showAddServerModal.value = false
  } catch (err: unknown) {
    addServerError.value = err instanceof Error ? err.message : String(err)
  } finally {
    addServerLoading.value = false
  }
}

async function addPresetServer(preset: { name: string; url: string; homepage?: string; register?: string }) {
  addServerLoading.value = true
  addServerError.value = ''
  try {
    await auth.addYggdrasilServer(preset.url)
    showAddServerModal.value = false
  } catch (err: unknown) {
    addServerError.value = err instanceof Error ? err.message : String(err)
  } finally {
    addServerLoading.value = false
  }
}

async function doYggdrasilLogin() {
  if (!yggSelectedServer.value || !yggUsername.value.trim() || !yggPassword.value) return
  try {
    await auth.yggdrasilLogin(yggSelectedServer.value.url, yggUsername.value.trim(), yggPassword.value)
    yggUsername.value = ''
    yggPassword.value = ''
  } catch { /* error shown via store */ }
}

function openUrl(url: string) {
  window.api.auth.openUrl(url)
}
</script>

<template>
  <div class="login-page">
    <h2>账号管理</h2>

    <!-- 账号卡片列表 (点击选中) -->
    <div class="account-grid">
      <div
        v-for="a in auth.accounts"
        :key="a.id"
        class="card account-card"
        :class="{ active: auth.selectedAccountId === a.id }"
        @click="auth.selectAccount(a.id)"
      >
        <img class="avatar" :src="getAvatar(a)" :alt="a.username" />
        <div class="card-body">
          <span class="card-name">{{ a.username }}</span>
          <span class="card-badge" :class="accountBadge(a.type).cls">
            {{ accountBadge(a.type).label }}
          </span>
        </div>
        <button class="remove-btn" title="移除" @click.stop="auth.removeAccount(a.id)">&times;</button>
      </div>
    </div>

    <p v-if="auth.accounts.length === 0" class="text-muted" style="margin-bottom:16px">
      还没有账号，请在下方添加
    </p>

    <!-- 离线登录 -->
    <div class="card login-section">
      <h3>离线登录</h3>
      <div class="input-row">
        <input v-model="offlineUsername" placeholder="输入用户名" @keyup.enter="loginOffline" />
        <button class="btn-primary" @click="loginOffline">添加</button>
      </div>
    </div>

    <!-- 微软登录 -->
    <div class="card login-section">
      <h3>微软正版登录</h3>

      <template v-if="auth.loginState === 'idle' || auth.loginState === 'success'">
        <p class="text-muted">使用微软账号登录以验证正版身份</p>
        <button class="btn-primary" @click="startMsLogin">微软登录</button>
      </template>

      <template v-else-if="auth.loginState === 'waitingForCode' || auth.loginState === 'polling'">
        <div v-if="auth.deviceCode" class="polling-status">
          <p class="text-muted pulse">{{ stateText[auth.loginState] }}</p>
          <p class="text-muted">验证码: <strong class="code-inline">{{ auth.deviceCode }}</strong></p>
        </div>
        <div v-else>
          <p class="text-muted">正在获取验证码...</p>
        </div>
        <button class="btn-danger btn-sm" @click="cancelMsLogin" style="margin-top:8px">取消</button>
      </template>

      <template v-else-if="auth.loginState === 'exchanging'">
        <p class="text-muted">正在验证令牌，请稍候...</p>
      </template>

      <template v-else-if="auth.loginState === 'error'">
        <p class="error-text">{{ auth.loginError || '登录失败，请重试' }}</p>
        <button class="btn-primary" @click="startMsLogin" style="margin-top:8px">重试</button>
      </template>
    </div>

    <!-- 第三方登录 (Yggdrasil / authlib-injector) -->
    <div class="card login-section">
      <h3>第三方登录 (外置登录)</h3>
      <p class="text-muted" style="margin-bottom:10px">使用 LittleSkin 等第三方皮肤站账号登录</p>

      <!-- 已添加的服务器列表 -->
      <div v-if="auth.yggdrasilServers.length > 0" class="ygg-server-list">
        <div
          v-for="srv in auth.yggdrasilServers"
          :key="srv.url"
          class="ygg-server-item"
          :class="{ active: yggSelectedServer?.url === srv.url }"
          @click="yggSelectedServer = srv"
        >
          <div class="ygg-server-info">
            <span class="ygg-server-name">{{ srv.name }}</span>
            <span class="ygg-server-url">{{ srv.url }}</span>
          </div>
          <button class="remove-btn" title="移除" @click.stop="auth.removeYggdrasilServer(srv.url); if (yggSelectedServer?.url === srv.url) yggSelectedServer = null">&times;</button>
        </div>
      </div>

      <div class="ygg-actions">
        <button class="btn-secondary btn-sm" @click="showAddServerModal = true">+ 添加认证服务器</button>
      </div>

      <!-- 登录表单: 选中服务器后显示 -->
      <div v-if="yggSelectedServer" class="ygg-login-form">
        <p class="text-muted" style="margin-bottom:6px">
          登录到 <strong>{{ yggSelectedServer.name }}</strong>
          <a v-if="yggSelectedServer.register" class="link-inline" @click.prevent="openUrl(yggSelectedServer.register!)">注册账号</a>
        </p>
        <div class="input-row">
          <input v-model="yggUsername" placeholder="邮箱或角色名" @keyup.enter="doYggdrasilLogin" />
        </div>
        <div class="input-row" style="margin-top:6px">
          <input v-model="yggPassword" type="password" placeholder="密码" @keyup.enter="doYggdrasilLogin" />
          <button class="btn-primary" :disabled="auth.yggdrasilLoading" @click="doYggdrasilLogin">
            {{ auth.yggdrasilLoading ? '登录中...' : '登录' }}
          </button>
        </div>
        <p v-if="auth.yggdrasilError" class="error-text" style="margin-top:6px">{{ auth.yggdrasilError }}</p>
      </div>
    </div>

    <!-- 添加认证服务器弹窗 -->
    <Teleport to="body">
      <div v-if="showAddServerModal" class="modal-overlay" @click.self="showAddServerModal = false">
        <div class="modal-box">
          <h3>添加认证服务器</h3>

          <!-- 预设服务器 -->
          <div v-if="presetServers.length > 0" class="preset-section">
            <p class="text-muted" style="margin-bottom:8px">常用服务器（一键添加）</p>
            <div class="preset-list">
              <button
                v-for="p in presetServers"
                :key="p.url"
                class="preset-btn"
                :disabled="addServerLoading"
                @click="addPresetServer(p)"
              >
                {{ p.name }}
              </button>
            </div>
          </div>

          <div class="divider-text"><span>或手动输入</span></div>

          <div class="input-row">
            <input
              v-model="yggServerInput"
              placeholder="认证服务器地址 (如 littleskin.cn)"
              @keyup.enter="addServerFromInput"
            />
            <button class="btn-primary" :disabled="addServerLoading || !yggServerInput.trim()" @click="addServerFromInput">
              {{ addServerLoading ? '解析中...' : '添加' }}
            </button>
          </div>
          <p class="text-muted" style="margin-top:6px;font-size:12px">
            支持输入皮肤站地址或 Yggdrasil API 地址，会自动解析
          </p>
          <p v-if="addServerError" class="error-text" style="margin-top:6px">{{ addServerError }}</p>

          <div class="modal-actions" style="margin-top:16px">
            <button class="btn-secondary" @click="showAddServerModal = false">关闭</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 引导弹窗 -->
    <Teleport to="body">
      <div v-if="showGuideModal" class="modal-overlay" @click.self="showGuideModal = false">
        <div class="modal-box">
          <h3>微软账号登录</h3>
          <div class="guide-steps">
            <div class="guide-step">
              <span class="step-num">1</span>
              <span>点击下方按钮后，浏览器将自动打开微软登录页面</span>
            </div>
            <div class="guide-step">
              <span class="step-num">2</span>
              <span>验证码已自动复制到剪贴板，在网页中粘贴即可</span>
            </div>
            <div class="guide-step">
              <span class="step-num">3</span>
              <span>在浏览器中完成微软账号登录，启动器将自动检测</span>
            </div>
          </div>
          <div class="guide-code">
            <span class="guide-code-label">你的验证码</span>
            <span class="guide-code-value">{{ auth.deviceCode }}</span>
          </div>
          <div class="modal-actions">
            <button class="btn-secondary" @click="showGuideModal = false">取消</button>
            <button class="btn-primary" @click="confirmAndOpenBrowser">打开浏览器并复制验证码</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.login-page { max-width: 560px; }
h2 { margin-bottom: 16px; }
.text-muted { color: var(--text-muted); font-size: 13px; }

/* === 账号卡片网格 === */
.account-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  margin-bottom: 16px;
}
.account-card {
  position: relative;
  display: flex; flex-direction: column; align-items: center;
  padding: 16px 12px 12px;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
  text-align: center;
}
.account-card:hover { border-color: var(--text-muted); transform: translateY(-2px); }
.account-card.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), 0 0 12px rgba(78, 204, 163, 0.15);
}
.avatar {
  width: 48px; height: 48px;
  border-radius: 6px;
  image-rendering: pixelated;
  background: var(--bg-primary);
  margin-bottom: 8px;
}
.card-body { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.card-name { font-weight: 600; font-size: 14px; word-break: break-all; }
.card-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600;
}
.badge-ms { background: #166534; color: #4ade80; }
.badge-offline { background: #1e3a5f; color: #60a5fa; }
.badge-ygg { background: #6b21a8; color: #c084fc; }
.remove-btn {
  position: absolute; top: 4px; right: 6px;
  background: none; border: none; color: var(--text-muted);
  font-size: 18px; cursor: pointer; line-height: 1;
  opacity: 0; transition: opacity 0.15s;
}
.account-card:hover .remove-btn { opacity: 1; }
.remove-btn:hover { color: var(--danger); }

/* === 登录区 === */
.login-section { margin-bottom: 12px; }
.login-section h3 { font-size: 15px; margin-bottom: 8px; }
.input-row { display: flex; gap: 8px; }
.input-row input { flex: 1; }

.polling-status { margin: 6px 0; }
.code-inline {
  font-family: 'Consolas', monospace;
  color: var(--accent); letter-spacing: 2px;
}
.btn-sm { font-size: 12px; padding: 4px 10px; }
.error-text { color: #ef4444; font-size: 13px; }
.pulse { animation: pulse-fade 2s ease-in-out infinite; }
@keyframes pulse-fade {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

/* === 引导弹窗 === */
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
  animation: overlay-in 0.2s ease;
}
.modal-box {
  background: var(--bg-secondary, #1e1e2e);
  border: 1px solid var(--border, #333);
  border-radius: 12px;
  padding: 24px 28px;
  max-width: 440px; width: 90%;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  animation: modal-scale-in 0.22s ease;
}
@keyframes overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes modal-scale-in {
  from { opacity: 0; transform: scale(0.92); }
  to { opacity: 1; transform: scale(1); }
}
.modal-box h3 { font-size: 18px; margin-bottom: 16px; }
.guide-steps { display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; }
.guide-step { display: flex; align-items: flex-start; gap: 10px; font-size: 14px; line-height: 1.5; }
.step-num {
  flex-shrink: 0;
  width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  background: var(--accent); color: #fff;
  font-size: 13px; font-weight: 700;
}
.guide-code {
  display: flex; flex-direction: column; align-items: center;
  gap: 6px; margin-bottom: 20px;
  padding: 12px; border-radius: 8px;
  background: var(--bg-primary, #181825);
}
.guide-code-label { font-size: 12px; color: var(--text-muted); }
.guide-code-value {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 32px; font-weight: 700;
  letter-spacing: 6px; color: var(--accent);
}
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; }

/* === 第三方登录 === */
.ygg-server-list {
  display: flex; flex-direction: column; gap: 4px;
  margin-bottom: 10px;
}
.ygg-server-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; border-radius: 6px;
  background: var(--bg-primary, #181825);
  border: 1px solid transparent;
  cursor: pointer; transition: border-color 0.2s;
}
.ygg-server-item:hover { border-color: var(--text-muted); }
.ygg-server-item.active { border-color: var(--accent); background: rgba(78,204,163,0.06); }
.ygg-server-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ygg-server-name { font-size: 13px; font-weight: 600; }
.ygg-server-url { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ygg-server-item .remove-btn { opacity: 0; position: static; }
.ygg-server-item:hover .remove-btn { opacity: 1; }
.ygg-actions { margin-bottom: 10px; }
.ygg-login-form {
  padding-top: 10px;
  border-top: 1px solid var(--border, #333);
}
.link-inline {
  color: var(--accent); cursor: pointer;
  font-size: 12px; margin-left: 6px;
  text-decoration: underline;
}
.link-inline:hover { opacity: 0.8; }

/* === 添加服务器弹窗 === */
.preset-section { margin-bottom: 12px; }
.preset-list { display: flex; flex-wrap: wrap; gap: 6px; }
.preset-btn {
  padding: 6px 14px; border-radius: 6px;
  background: var(--bg-primary, #181825);
  border: 1px solid var(--border, #333);
  color: var(--text-primary); font-size: 13px;
  cursor: pointer; transition: border-color 0.2s, background 0.2s;
}
.preset-btn:hover { border-color: var(--accent); background: rgba(78,204,163,0.08); }
.preset-btn:disabled { opacity: 0.5; cursor: default; }
.divider-text {
  display: flex; align-items: center; gap: 8px;
  margin: 12px 0; color: var(--text-muted); font-size: 12px;
}
.divider-text::before, .divider-text::after {
  content: ''; flex: 1; height: 1px;
  background: var(--border, #333);
}
</style>
