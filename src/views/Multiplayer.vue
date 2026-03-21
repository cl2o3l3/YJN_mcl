<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import { useMultiplayerStore } from '../stores/multiplayer'
import { useAuthStore } from '../stores/auth'
import { useSettingsStore } from '../stores/settings'
import { diffModLists } from '../services/mod-sync'
import SkinPreview from '../components/SkinPreview.vue'
import type { ConnectionTier, MinecraftAccount, InstalledResource } from '../types'

const mp = useMultiplayerStore()
const auth = useAuthStore()
const settings = useSettingsStore()

const joinCode = ref('')
const showDiagModal = ref(false)
const logContainer = ref<HTMLElement | null>(null)
const manualOfferInput = ref('')
const manualAnswerInput = ref('')
const modSyncLocalDiff = ref<{ missing: InstalledResource[]; extra: InstalledResource[]; matched: InstalledResource[] } | null>(null)
const overlayVisible = ref(false)

// Overlay 切换
async function toggleOverlay() {
  overlayVisible.value = !overlayVisible.value
  if (overlayVisible.value) {
    await window.api.overlay.show()
    await window.api.overlay.updatePeers(mp.peers)
  } else {
    await window.api.overlay.hide()
  }
}

const showSkinPreview = ref(false)

function getSkinUrl(account: MinecraftAccount | null): string {
  if (!account) return ''
  if (account.type === 'microsoft') {
    const raw = account.uuid.replace(/-/g, '')
    return `https://crafatar.com/skins/${raw}`
  }
  return `https://minotar.net/skin/${encodeURIComponent(account.username)}`
}

// Mod 同步：房主发送
async function handleSendModSync() {
  if (!settings.defaultGameDir) return
  await mp.sendModSync(settings.defaultGameDir)
}

// Mod 同步：客人对比本地
async function handleDiffMods() {
  if (!settings.defaultGameDir || mp.hostModList.length === 0) return
  const localMods = await window.api.resources.installed('mod', settings.defaultGameDir)
  modSyncLocalDiff.value = diffModLists(mp.hostModList, localMods)
}

// 模式选择: null = 主菜单, 'signaling' = 房间码模式, 'direct' = 直连模式
// 如果已有房间/连接中，直接推断模式；否则为 null 让用户选
const selectedMode = ref<'signaling' | 'direct' | null>(
  mp.state !== 'idle'
    ? (mp.manualPhase !== 'idle' ? 'direct' : 'signaling')
    : null
)

// 在模式内部: 'menu' = 创建/加入选择, 'create' = 创建中, 'join' = 加入中
const modeAction = ref<'menu' | 'create' | 'join'>('menu')

watch(() => mp.logs.length, () => {
  nextTick(() => {
    if (logContainer.value) logContainer.value.scrollTop = logContainer.value.scrollHeight
  })
})

// 自动恢复 selectedMode（热更新 / 路由回来时 state 不是 idle 但 selectedMode 丢失）
watch(() => mp.state, (s) => {
  if (s !== 'idle' && !selectedMode.value) {
    selectedMode.value = (mp.manualPhase !== 'idle') ? 'direct' : 'signaling'
  }
}, { immediate: true })

// 回到主菜单
function goHome() {
  if (mp.state !== 'idle') {
    mp.leaveRoom()
  }
  selectedMode.value = null
  modeAction.value = 'menu'
  manualOfferInput.value = ''
  manualAnswerInput.value = ''
  joinCode.value = ''
}

// 信令模式
async function handleCreateRoom() {
  if (!auth.selectedAccount) return
  try {
    await mp.createRoom(playerDisplayName())
  } catch { /* error 已在 store 中处理 */ }
}

async function handleJoinRoom() {
  if (!joinCode.value.trim() || !auth.selectedAccount) return
  try {
    await mp.joinRoom(joinCode.value.trim().toUpperCase(), playerDisplayName())
  } catch { /* error 已在 store 中处理 */ }
}

// 直连模式
async function handleManualCreate() {
  if (!auth.selectedAccount) return
  await mp.createManualRoom(playerDisplayName())
}

async function handleManualJoin() {
  if (!manualOfferInput.value.trim() || !auth.selectedAccount) return
  await mp.joinManualRoom(manualOfferInput.value.trim(), playerDisplayName())
}

async function handleManualSubmitAnswer() {
  if (!manualAnswerInput.value.trim()) return
  await mp.submitManualAnswer(manualAnswerInput.value.trim())
}

function copyManualCode(text: string) {
  navigator.clipboard.writeText(text)
}

// ---- 头像系统 ----
function nameHue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

function defaultAvatar(account: MinecraftAccount): string {
  const hue = nameHue(account.username)
  const letter = account.username[0]?.toUpperCase() || '?'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
    <rect width="64" height="64" rx="8" fill="hsl(${hue},45%,35%)"/>
    <text x="32" y="42" text-anchor="middle" fill="#fff" font-size="28" font-family="sans-serif" font-weight="bold">${letter}</text>
  </svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

function defaultAvatarByName(name: string): string {
  const hue = nameHue(name)
  const letter = name[0]?.toUpperCase() || '?'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
    <rect width="64" height="64" rx="8" fill="hsl(${hue},45%,35%)"/>
    <text x="32" y="42" text-anchor="middle" fill="#fff" font-size="28" font-family="sans-serif" font-weight="bold">${letter}</text>
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
    urls.push(`https://crafatar.com/avatars/${raw}?overlay&size=64`, `https://mc-heads.net/avatar/${raw}/64`)
  } else if (account.type === 'yggdrasil' && account.yggdrasilServer) {
    const raw = account.uuid.replace(/-/g, '')
    const serverBase = account.yggdrasilServer.replace(/\/api\/yggdrasil\/?$/, '')
    urls.push(`${account.yggdrasilServer}textures/avatar/${raw}?size=64`, `${serverBase}/avatar/${raw}?size=64`, `https://crafatar.com/avatars/${raw}?overlay&size=64`)
  } else {
    urls.push(`https://minotar.net/helm/${encodeURIComponent(account.username)}/64`, `https://mc-heads.net/avatar/${encodeURIComponent(account.username)}/64`)
  }
  for (const url of urls) {
    try {
      const dataUri = await window.api.auth.fetchAvatar(url)
      if (dataUri) { avatarCache.value[account.id] = dataUri; return }
    } catch { /* try next */ }
  }
}

function getAvatar(account: MinecraftAccount): string {
  if (!avatarCache.value[account.id]) loadAvatar(account)
  return avatarCache.value[account.id] || defaultAvatar(account)
}

// 玩家（Peer）头像：只有名字，无 uuid
const peerAvatarCache = ref<Record<string, string>>({})

async function loadPeerAvatar(name: string) {
  if (peerAvatarCache.value[name]) return
  peerAvatarCache.value[name] = defaultAvatarByName(name)
  const urls = [
    `https://minotar.net/helm/${encodeURIComponent(name)}/64`,
    `https://mc-heads.net/avatar/${encodeURIComponent(name)}/64`
  ]
  for (const url of urls) {
    try {
      const dataUri = await window.api.auth.fetchAvatar(url)
      if (dataUri) { peerAvatarCache.value[name] = dataUri; return }
    } catch { /* try next */ }
  }
}

function getPeerAvatar(name: string): string {
  if (!peerAvatarCache.value[name]) loadPeerAvatar(name)
  return peerAvatarCache.value[name] || defaultAvatarByName(name)
}

function accountBadge(type: string): { label: string; cls: string } {
  if (type === 'microsoft') return { label: '正版', cls: 'badge-ms' }
  if (type === 'yggdrasil') return { label: '外置', cls: 'badge-ygg' }
  return { label: '离线', cls: 'badge-offline' }
}

/** 当前用于联机的玩家名 */
function playerDisplayName(): string {
  return auth.selectedAccount?.username || 'Player'
}

function copyAddr() {
  if (mp.localPort > 0) {
    navigator.clipboard.writeText(`localhost:${mp.localPort}`)
  }
}

function handleDiagnostics() {
  showDiagModal.value = true
  mp.runDiagnostics()
}

function tierIcon(tier?: ConnectionTier): string {
  switch (tier) {
    case 'direct': return '🟢'
    case 'turn': return '🟡'
    case 'relay': return ''
    default: return '⚪'
  }
}

function rttClass(rtt: number): string {
  if (rtt <= 0) return 'rtt-unknown'
  if (rtt < 50) return 'rtt-good'
  if (rtt < 150) return 'rtt-ok'
  return 'rtt-bad'
}
</script>

<template>
  <div class="multiplayer-page">
    <h2>联机大厅</h2>

    <!-- ==================== 主菜单：模式选择 ==================== -->
    <template v-if="!selectedMode && mp.state === 'idle'">
      <!-- 当前账号 -->
      <div v-if="auth.selectedAccount" class="current-account-card card">
        <img
          class="avatar"
          :src="getAvatar(auth.selectedAccount)"
          :alt="auth.selectedAccount.username"
          @click="showSkinPreview = !showSkinPreview"
          title="点击查看 3D 皮肤"
          style="cursor: pointer;"
        />
        <div class="card-body">
          <span class="card-name">{{ auth.selectedAccount.username }}</span>
          <span class="card-badge" :class="accountBadge(auth.selectedAccount.type).cls">
            {{ accountBadge(auth.selectedAccount.type).label }}
          </span>
        </div>
        <SkinPreview
          v-if="showSkinPreview && auth.selectedAccount"
          :skinUrl="getSkinUrl(auth.selectedAccount)"
          :width="120"
          :height="200"
          class="skin-preview-popup"
        />
      </div>
      <div v-else class="current-account-card card no-account">
        <span class="text-muted">未选择账号，请先在账号页面登录</span>
      </div>

      <div class="mode-grid">
        <!-- 房间码模式 -->
        <button class="mode-card" @click="selectedMode = 'signaling'; modeAction = 'menu'">
          <div class="mode-icon">📡</div>
          <div class="mode-content">
            <h3>房间码联机</h3>
            <p>通过信令服务器创建/加入房间，使用 6 位房间码邀请好友。延迟低、连接稳定。</p>
          </div>
          <span class="mode-arrow">›</span>
        </button>

        <!-- 直连模式 -->
        <button class="mode-card" @click="selectedMode = 'direct'; modeAction = 'menu'">
          <div class="mode-icon">🔗</div>
          <div class="mode-content">
            <h3>直连模式</h3>
            <p>不依赖服务器，通过 QQ/微信互发连接码建立 P2P 连接。适合信令不可用时使用。</p>
          </div>
          <span class="mode-arrow">›</span>
        </button>
      </div>

      <button class="btn-text diag-btn" @click="handleDiagnostics">🔍 网络诊断</button>
    </template>

    <!-- ==================== 房间码模式 ==================== -->
    <template v-if="selectedMode === 'signaling'">

      <!-- 空闲：创建/加入选择 -->
      <template v-if="mp.state === 'idle'">
        <button class="back-btn" @click="goHome">← 返回</button>

        <template v-if="modeAction === 'menu'">
          <div class="action-grid">
            <button class="action-card" @click="modeAction = 'create'">
              <span class="action-icon">🏠</span>
              <h4>创建房间</h4>
              <p>创建房间后启动 MC 开启局域网，将房间码发给朋友</p>
            </button>
            <button class="action-card" @click="modeAction = 'join'">
              <span class="action-icon">🚪</span>
              <h4>加入房间</h4>
              <p>输入房主提供的 6 位房间码加入游戏</p>
            </button>
          </div>
        </template>

        <template v-if="modeAction === 'create'">
          <div class="card inner-card">
            <h3>创建房间</h3>
            <p class="text-muted mb">启动 MC 后打开「对局域网开放」，将房间码发给朋友即可联机。</p>
            <button class="btn-primary" @click="handleCreateRoom" :disabled="!auth.selectedAccount">创建房间</button>
          </div>
        </template>

        <template v-if="modeAction === 'join'">
          <div class="card inner-card">
            <h3>加入房间</h3>
            <p class="text-muted mb">输入房主提供的 6 位房间码。</p>
            <div class="input-row">
              <input
                v-model="joinCode"
                placeholder="6 位房间码"
                maxlength="6"
                class="code-input"
                @keyup.enter="handleJoinRoom"
              />
              <button class="btn-primary" @click="handleJoinRoom" :disabled="joinCode.trim().length < 6 || !auth.selectedAccount">
                加入
              </button>
            </div>
          </div>
        </template>

        <p v-if="mp.error" class="error-text mt">{{ mp.error }}</p>
      </template>

      <!-- 连接中 -->
      <template v-if="mp.state === 'connecting' && mp.manualPhase === 'idle'">
        <div class="card center-card">
          <div class="spinner" />
          <p>正在连接信令服务器...</p>
          <p class="text-muted text-sm">首次连接或服务器休眠时可能需要等待较长时间</p>
          <p v-if="mp.error" class="error-text">{{ mp.error }}</p>
          <button class="btn-text mt-sm" @click="goHome">取消</button>
        </div>
      </template>

      <!-- 在房间中 -->
      <template v-if="mp.state === 'in-room' && mp.manualPhase === 'idle'">
        <div class="room-view">
          <!-- 房间头部 -->
          <div class="card room-header-card">
            <div class="room-header">
              <div>
                <h3>{{ mp.isHost ? '你的房间' : '已加入房间' }}</h3>
                <div v-if="mp.roomCode" class="room-code-row">
                  <span class="room-code" @click="mp.copyRoomCode()" title="点击复制">{{ mp.roomCode }}</span>
                  <button class="btn-copy" @click="mp.copyRoomCode()">复制</button>
                </div>
              </div>
              <div class="tier-badge" :class="'tier-' + mp.connectionTier">
                {{ tierIcon(mp.connectionTier) }} {{ mp.tierLabel(mp.connectionTier) }}
              </div>
            </div>
          </div>

          <!-- 房主: LAN 端口 -->
          <div v-if="mp.isHost" class="card mt">
            <h3>MC 局域网</h3>
            <p v-if="mp.mcLanPort > 0" class="text-muted">
              ✅ 检测到 LAN 端口: <strong>{{ mp.mcLanPort }}</strong>
            </p>
            <div v-else>
              <p class="text-muted">⏳ 请在 MC 中打开「对局域网开放」...</p>
              <p class="text-muted text-xs">进入单人世界 → Esc → 对局域网开放 → 创建</p>
            </div>
          </div>

          <!-- 客人: 连接地址 -->
          <div v-if="mp.isGuest && mp.localPort > 0" class="card mt highlight-card">
            <h3>✅ 已连接</h3>
            <p class="text-muted mb">服务器已自动显示在 MC 多人游戏列表，直接加入即可。</p>
            <div class="connect-addr" @click="copyAddr" title="点击复制">
              <code>localhost:{{ mp.localPort }}</code>
              <span class="copy-hint">📋</span>
            </div>
          </div>
          <div v-else-if="mp.isGuest" class="card mt">
            <p class="text-muted">正在与房主建立连接...</p>
          </div>

          <!-- 玩家列表 -->
          <div class="card mt">
            <h3>玩家 ({{ mp.peers.length + 1 }})</h3>
            <div class="player-grid">
              <div class="player-card self">
                <img class="player-avatar" :src="auth.selectedAccount ? getAvatar(auth.selectedAccount) : defaultAvatarByName(mp.playerName)" />
                <span class="player-name">{{ mp.playerName }}</span>
                <span class="player-tag">你{{ mp.isHost ? ' 👑' : '' }}</span>
              </div>
              <div v-for="p in mp.peers" :key="p.id" class="player-card">
                <img class="player-avatar" :src="getPeerAvatar(p.name)" />
                <span class="player-name">{{ p.name }}</span>
                <span class="player-meta">
                  <span class="state-dot" :class="'state-' + p.state" />
                  <span v-if="p.rtt > 0" class="rtt-badge" :class="rttClass(p.rtt)">{{ p.rtt }}ms</span>
                  <span v-else-if="p.state === 'connected'" class="rtt-badge rtt-unknown">测量中</span>
                </span>
              </div>
            </div>
          </div>

          <!-- Mod 同步 -->
          <div class="card mt" v-if="mp.peers.some(p => p.state === 'connected')">
            <h3>Mod 同步</h3>
            <div v-if="mp.isHost">
              <p class="text-muted mb">将当前游戏目录的 mod 列表发送给所有客人。</p>
              <button class="btn-secondary" @click="handleSendModSync" :disabled="mp.modSyncStatus === 'syncing'">
                {{ mp.modSyncStatus === 'syncing' ? '发送中...' : '发送 Mod 列表' }}
              </button>
            </div>
            <div v-if="mp.isGuest">
              <template v-if="mp.hostModList.length > 0">
                <p class="text-muted mb">收到房主 mod 列表 ({{ mp.hostModList.length }} 个)</p>
                <button class="btn-secondary" @click="handleDiffMods" v-if="!modSyncLocalDiff">对比本地 Mod</button>
                <div v-if="modSyncLocalDiff" class="mod-diff">
                  <p v-if="modSyncLocalDiff.missing.length === 0 && modSyncLocalDiff.extra.length === 0" class="text-muted">✅ Mod 完全一致</p>
                  <div v-if="modSyncLocalDiff.missing.length > 0" class="diff-section">
                    <p class="diff-label diff-missing">缺少 {{ modSyncLocalDiff.missing.length }} 个:</p>
                    <div v-for="m in modSyncLocalDiff.missing" :key="m.projectId" class="diff-item">{{ m.title }}</div>
                  </div>
                  <div v-if="modSyncLocalDiff.extra.length > 0" class="diff-section">
                    <p class="diff-label diff-extra">多出 {{ modSyncLocalDiff.extra.length }} 个:</p>
                    <div v-for="m in modSyncLocalDiff.extra" :key="m.projectId" class="diff-item">{{ m.title }}</div>
                  </div>
                </div>
              </template>
              <p v-else class="text-muted">等待房主发送 mod 列表...</p>
            </div>
          </div>

          <!-- 日志 -->
          <div class="card mt">
            <h3>日志</h3>
            <div ref="logContainer" class="log-box">
              <div v-for="(log, i) in mp.logs" :key="i" class="log-line">{{ log }}</div>
              <div v-if="mp.logs.length === 0" class="text-muted">暂无日志</div>
            </div>
          </div>

          <div class="mt room-actions">
            <button class="btn-danger" @click="goHome">离开房间</button>
            <button class="btn-secondary" @click="toggleOverlay">{{ overlayVisible ? '关闭悬浮窗' : '显示悬浮窗' }}</button>
          </div>
        </div>
      </template>
    </template>

    <!-- ==================== 直连模式 ==================== -->
    <template v-if="selectedMode === 'direct'">

      <!-- 空闲 -->
      <template v-if="mp.state === 'idle'">
        <button class="back-btn" @click="goHome">← 返回</button>

        <template v-if="modeAction === 'menu'">
          <div class="action-grid">
            <button class="action-card" @click="modeAction = 'create'">
              <span class="action-icon">🏠</span>
              <h4>创建房间</h4>
              <p>生成邀请码发给对方，再粘贴对方的应答码</p>
            </button>
            <button class="action-card" @click="modeAction = 'join'">
              <span class="action-icon">🚪</span>
              <h4>加入房间</h4>
              <p>粘贴房主的邀请码，生成应答码发回</p>
            </button>
          </div>
        </template>

        <template v-if="modeAction === 'create'">
          <div class="card inner-card">
            <h3>创建房间（直连）</h3>
            <p class="text-muted mb">将生成邀请码，通过 QQ/微信发给朋友。</p>
            <button class="btn-primary" @click="handleManualCreate" :disabled="!auth.selectedAccount">生成邀请码</button>
          </div>
        </template>

        <template v-if="modeAction === 'join'">
          <div class="card inner-card">
            <h3>加入房间（直连）</h3>
            <p class="text-muted mb">粘贴房主发来的邀请码：</p>
            <textarea class="code-area" v-model="manualOfferInput" placeholder="粘贴邀请码" />
            <button class="btn-primary mt-sm" @click="handleManualJoin" :disabled="!manualOfferInput.trim() || !auth.selectedAccount">
              连接
            </button>
          </div>
        </template>

        <p v-if="mp.error" class="error-text mt">{{ mp.error }}</p>
      </template>

      <!-- 连接中：手动交换各阶段 -->
      <template v-if="mp.state === 'connecting'">

        <div v-if="mp.manualPhase === 'host-generating'" class="card center-card">
          <div class="spinner" />
          <p>正在生成邀请码...</p>
        </div>

        <template v-else-if="mp.manualPhase === 'host-offer'">
          <div class="card inner-card">
            <h3>Step 1: 复制邀请码发给朋友</h3>
            <textarea class="code-area" readonly :value="mp.manualOfferCode" @click="copyManualCode(mp.manualOfferCode)" />
            <button class="btn-primary mt-sm" @click="copyManualCode(mp.manualOfferCode)">📋 复制邀请码</button>
          </div>
          <div class="card mt inner-card">
            <h3>Step 2: 粘贴朋友的应答码</h3>
            <textarea class="code-area" v-model="manualAnswerInput" placeholder="粘贴应答码" />
            <button class="btn-primary mt-sm" @click="handleManualSubmitAnswer" :disabled="!manualAnswerInput.trim()">连接</button>
          </div>
          <p v-if="mp.error" class="error-text mt">{{ mp.error }}</p>
          <button class="btn-text mt" @click="goHome">取消</button>
        </template>

        <div v-else-if="mp.manualPhase === 'host-connecting'" class="card center-card">
          <div class="spinner" />
          <p>正在建立连接...</p>
          <button class="btn-text mt-sm" @click="goHome">取消</button>
        </div>

        <div v-else-if="mp.manualPhase === 'guest-generating'" class="card center-card">
          <div class="spinner" />
          <p>正在生成应答码...</p>
        </div>

        <template v-else-if="mp.manualPhase === 'guest-answer'">
          <div class="card inner-card">
            <h3>复制应答码发回给房主</h3>
            <textarea class="code-area" readonly :value="mp.manualAnswerCode" @click="copyManualCode(mp.manualAnswerCode)" />
            <button class="btn-primary mt-sm" @click="copyManualCode(mp.manualAnswerCode)">📋 复制应答码</button>
            <p class="text-muted mt-sm">复制后发给房主，等待对方确认即可自动连接</p>
          </div>
          <div class="card mt center-card">
            <div class="spinner" />
            <p>等待房主确认...</p>
          </div>
          <p v-if="mp.error" class="error-text mt">{{ mp.error }}</p>
          <button class="btn-text mt" @click="goHome">取消</button>
        </template>

        <div v-else-if="mp.manualPhase === 'guest-connecting'" class="card center-card">
          <div class="spinner" />
          <p>正在连接...</p>
          <button class="btn-text mt-sm" @click="goHome">取消</button>
        </div>

        <!-- 非手动的信令连接中状态 (不应出现在这里，fallback) -->
        <div v-else class="card center-card">
          <div class="spinner" />
          <p>正在连接...</p>
          <button class="btn-text mt-sm" @click="goHome">取消</button>
        </div>
      </template>

      <!-- 在房间中 -->
      <template v-if="mp.state === 'in-room'">
        <div class="room-view">
          <div class="card room-header-card">
            <div class="room-header">
              <div>
                <h3>{{ mp.isHost ? '你的房间' : '已加入房间' }}</h3>
                <p class="text-muted">直连模式</p>
              </div>
              <div class="tier-badge" :class="'tier-' + mp.connectionTier">
                {{ tierIcon(mp.connectionTier) }} {{ mp.tierLabel(mp.connectionTier) }}
              </div>
            </div>
          </div>

          <div v-if="mp.isHost" class="card mt">
            <h3>MC 局域网</h3>
            <p v-if="mp.mcLanPort > 0" class="text-muted">
              ✅ 检测到 LAN 端口: <strong>{{ mp.mcLanPort }}</strong>
            </p>
            <div v-else>
              <p class="text-muted">⏳ 请在 MC 中打开「对局域网开放」...</p>
              <p class="text-muted text-xs">进入单人世界 → Esc → 对局域网开放 → 创建</p>
            </div>
          </div>

          <div v-if="mp.isGuest && mp.localPort > 0" class="card mt highlight-card">
            <h3>✅ 已连接</h3>
            <p class="text-muted mb">服务器已自动显示在 MC 多人游戏列表。</p>
            <div class="connect-addr" @click="copyAddr" title="点击复制">
              <code>localhost:{{ mp.localPort }}</code>
              <span class="copy-hint">📋</span>
            </div>
          </div>
          <div v-else-if="mp.isGuest" class="card mt">
            <p class="text-muted">正在与房主建立连接...</p>
          </div>

          <div class="card mt">
            <h3>玩家 ({{ mp.peers.length + 1 }})</h3>
            <div class="player-grid">
              <div class="player-card self">
                <img class="player-avatar" :src="auth.selectedAccount ? getAvatar(auth.selectedAccount) : defaultAvatarByName(mp.playerName)" />
                <span class="player-name">{{ mp.playerName }}</span>
                <span class="player-tag">你{{ mp.isHost ? ' 👑' : '' }}</span>
              </div>
              <div v-for="p in mp.peers" :key="p.id" class="player-card">
                <img class="player-avatar" :src="getPeerAvatar(p.name)" />
                <span class="player-name">{{ p.name }}</span>
                <span class="player-meta">
                  <span class="state-dot" :class="'state-' + p.state" />
                  <span v-if="p.rtt > 0" class="rtt-badge" :class="rttClass(p.rtt)">{{ p.rtt }}ms</span>
                  <span v-else-if="p.state === 'connected'" class="rtt-badge rtt-unknown">测量中</span>
                </span>
              </div>
            </div>
          </div>

          <!-- Mod 同步 (直连) -->
          <div class="card mt">
            <h3>Mod 同步</h3>
            <div v-if="mp.isHost">
              <p class="text-muted mb">将当前 mod 列表发送给对方。</p>
              <button class="btn-secondary" @click="handleSendModSync" :disabled="mp.modSyncStatus === 'syncing'">
                {{ mp.modSyncStatus === 'syncing' ? '发送中...' : '发送 Mod 列表' }}
              </button>
            </div>
            <div v-if="mp.isGuest">
              <template v-if="mp.hostModList.length > 0">
                <p class="text-muted mb">收到房主 mod 列表 ({{ mp.hostModList.length }} 个)</p>
                <button class="btn-secondary" @click="handleDiffMods" v-if="!modSyncLocalDiff">对比本地 Mod</button>
                <div v-if="modSyncLocalDiff" class="mod-diff">
                  <p v-if="modSyncLocalDiff.missing.length === 0 && modSyncLocalDiff.extra.length === 0" class="text-muted">✅ Mod 完全一致</p>
                  <div v-if="modSyncLocalDiff.missing.length > 0" class="diff-section">
                    <p class="diff-label diff-missing">缺少 {{ modSyncLocalDiff.missing.length }} 个:</p>
                    <div v-for="m in modSyncLocalDiff.missing" :key="m.projectId" class="diff-item">{{ m.title }}</div>
                  </div>
                  <div v-if="modSyncLocalDiff.extra.length > 0" class="diff-section">
                    <p class="diff-label diff-extra">多出 {{ modSyncLocalDiff.extra.length }} 个:</p>
                    <div v-for="m in modSyncLocalDiff.extra" :key="m.projectId" class="diff-item">{{ m.title }}</div>
                  </div>
                </div>
              </template>
              <p v-else class="text-muted">等待房主发送 mod 列表...</p>
            </div>
          </div>

          <div class="card mt">
            <h3>日志</h3>
            <div ref="logContainer" class="log-box">
              <div v-for="(log, i) in mp.logs" :key="i" class="log-line">{{ log }}</div>
              <div v-if="mp.logs.length === 0" class="text-muted">暂无日志</div>
            </div>
          </div>

          <div class="mt room-actions">
            <button class="btn-danger" @click="goHome">离开房间</button>
            <button class="btn-secondary" @click="toggleOverlay">{{ overlayVisible ? '关闭悬浮窗' : '显示悬浮窗' }}</button>
          </div>
        </div>
      </template>
    </template>

    <!-- ==================== 诊断弹窗 ==================== -->
    <Teleport to="body">
      <div v-if="showDiagModal" class="modal-mask" @click.self="showDiagModal = false">
        <div class="modal-body">
          <h3>网络诊断</h3>

          <div v-if="mp.diagnosing" class="center-card">
            <div class="spinner" />
            <p>正在检测...</p>
          </div>

          <template v-else-if="mp.diagnostics">
            <div class="diag-row">
              <span>信令服务器</span>
              <span :class="mp.diagnostics.signaling.ok ? 'ok' : 'fail'">
                {{ mp.diagnostics.signaling.ok ? `✅ ${mp.diagnostics.signaling.latency}ms` : `❌ ${mp.diagnostics.signaling.error}` }}
              </span>
            </div>
            <div class="diag-row">
              <span>STUN (NAT 穿透)</span>
              <span :class="mp.diagnostics.stun.ok ? 'ok' : 'fail'">
                {{ mp.diagnostics.stun.ok ? `✅ ${mp.diagnostics.stun.ip}` : `❌ ${mp.diagnostics.stun.error}` }}
              </span>
            </div>
            <div class="diag-row">
              <span>TURN 中继</span>
              <span :class="mp.diagnostics.turn.ok ? 'ok' : mp.diagnostics.turn.error?.includes('不影响') ? 'warn' : 'fail'">
                {{ mp.diagnostics.turn.ok ? `✅ ${mp.diagnostics.turn.provider}` : `⚠️ ${mp.diagnostics.turn.error}` }}
              </span>
            </div>
            <div class="diag-row">
              <span>IPv6</span>
              <span :class="mp.diagnostics.ipv6.ok ? 'ok' : 'fail'">
                {{ mp.diagnostics.ipv6.ok ? '✅ 可用' : '❌ 不可用' }}
              </span>
            </div>
            <div class="diag-row">
              <span>代理</span>
              <span :class="mp.diagnostics.proxy.detected ? 'warn' : 'ok'">
                {{ mp.diagnostics.proxy.detected ? `⚠️ ${mp.diagnostics.proxy.url}` : '✅ 未检测到' }}
              </span>
            </div>
            <div class="diag-row">
              <span>NAT 类型</span>
              <span>{{ mp.diagnostics.nat.type }}</span>
            </div>
          </template>

          <div class="modal-actions">
            <button class="btn-secondary" @click="mp.runDiagnostics()" :disabled="mp.diagnosing">重新检测</button>
            <button class="btn-text" @click="showDiagModal = false">关闭</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.multiplayer-page { max-width: 600px; }
h2 { margin-bottom: 16px; }
h3 { font-size: 15px; margin-bottom: 8px; }
h4 { font-size: 14px; margin-bottom: 4px; }
.text-muted { color: var(--text-muted); font-size: 13px; }
.text-xs { font-size: 12px; opacity: 0.8; margin-top: 4px; }
.mt { margin-top: 12px; }
.mb { margin-bottom: 8px; }
.mt-sm { margin-top: 6px; }
.error-text { color: #e74c3c; font-size: 13px; }

/* 当前账号卡片 */
.current-account-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 16px;
}
.current-account-card .avatar {
  width: 48px; height: 48px;
  border-radius: 6px;
  image-rendering: pixelated;
  background: var(--bg-primary);
  flex-shrink: 0;
}
.current-account-card .card-body {
  display: flex; flex-direction: column; gap: 4px;
}
.current-account-card .card-name {
  font-weight: 600; font-size: 15px;
}
.current-account-card .card-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600;
  width: fit-content;
}
.badge-ms { background: #166534; color: #4ade80; }
.badge-offline { background: #1e3a5f; color: #60a5fa; }
.badge-ygg { background: #6b21a8; color: #c084fc; }
.no-account {
  justify-content: center;
  padding: 18px 16px;
}

/* 模式选择卡片 */
.mode-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mode-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s, transform 0.15s;
  text-align: left;
}
.mode-card:hover {
  border-color: var(--accent);
  background: rgba(78, 204, 163, 0.04);
  transform: translateY(-1px);
}
.mode-icon {
  font-size: 28px;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: rgba(78, 204, 163, 0.1);
}
.mode-content {
  flex: 1;
  min-width: 0;
}
.mode-content h3 {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
}
.mode-content p {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
  margin: 0;
}
.mode-arrow {
  font-size: 20px;
  color: var(--text-muted);
  flex-shrink: 0;
}

/* 操作选择卡片（创建/加入） */
.action-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 8px;
}
.action-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 20px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s, transform 0.15s;
}
.action-card:hover {
  border-color: var(--accent);
  background: rgba(78, 204, 163, 0.04);
  transform: translateY(-1px);
}
.action-icon {
  font-size: 24px;
  margin-bottom: 8px;
}
.action-card h4 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}
.action-card p {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
  margin: 0;
}

/* 内部卡片 */
.inner-card {
  margin-top: 8px;
}

/* 返回按钮 */
.back-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  padding: 4px 0;
  margin-bottom: 8px;
  transition: color 0.15s;
}
.back-btn:hover {
  color: var(--accent);
}

/* 网络诊断按钮 */
.diag-btn {
  margin-top: 16px;
}

/* 输入相关 */
.code-input { flex: 1; font-family: monospace; letter-spacing: 2px; text-transform: uppercase; }
.input-row { display: flex; gap: 8px; }

/* 房间视图 */
.room-view {}
.room-header-card {}
.room-header {
  display: flex; justify-content: space-between; align-items: center;
}
.room-code {
  font-family: monospace; font-size: 20px; font-weight: 700;
  letter-spacing: 3px; cursor: pointer; user-select: all;
  color: var(--accent);
}
.room-code:hover { text-decoration: underline; }
.room-code-row { display: flex; align-items: center; gap: 12px; margin-top: 2px; }
.btn-copy {
  font-size: 12px; padding: 4px 10px; border-radius: 4px;
  background: var(--bg-secondary); border: 1px solid var(--border);
  color: var(--text-muted); cursor: pointer;
  transition: background 0.15s;
}
.btn-copy:hover { background: var(--border); color: var(--text-primary); }

/* 连接层级 */
.tier-badge {
  font-size: 12px; padding: 4px 10px; border-radius: 12px;
  white-space: nowrap;
}
.tier-direct { background: rgba(46, 204, 113, 0.15); color: #27ae60; }
.tier-turn   { background: rgba(241, 196, 15, 0.15); color: #f39c12; }
.tier-relay  { background: rgba(231, 76, 60, 0.15);  color: #e74c3c; }

/* 连接地址 */
.highlight-card {
  border: 1px solid rgba(78, 204, 163, 0.3);
  background: rgba(78, 204, 163, 0.04);
}
.connect-addr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-radius: 6px; cursor: pointer;
  background: var(--bg-secondary); transition: background 0.15s;
}
.connect-addr:hover { background: var(--bg-hover); }
.connect-addr code {
  font-size: 18px; font-weight: 700; color: var(--text-primary);
  user-select: all; letter-spacing: 1px;
}
.connect-addr .copy-hint { font-size: 12px; color: var(--text-muted); }

/* 玩家列表 - 横向卡片 */
.player-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.player-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  min-width: 0;
  transition: border-color 0.2s;
}
.player-card:hover { border-color: var(--text-muted); }
.player-card.self { border-color: var(--accent); background: rgba(78, 204, 163, 0.06); }
.player-avatar {
  width: 32px; height: 32px;
  border-radius: 4px;
  image-rendering: pixelated;
  background: var(--bg-primary);
  flex-shrink: 0;
}
.player-name {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100px;
}
.player-tag {
  font-size: 10px;
  color: var(--accent);
  white-space: nowrap;
}
.player-meta {
  display: flex; align-items: center; gap: 4px; font-size: 11px;
}
.rtt { color: var(--text-muted); }
.rtt-badge {
  display: inline-block; padding: 1px 7px; border-radius: 8px;
  font-size: 11px; font-weight: 600; font-family: monospace;
}
.rtt-good { background: rgba(46, 204, 113, 0.18); color: #27ae60; }
.rtt-ok   { background: rgba(241, 196, 15, 0.18); color: #f39c12; }
.rtt-bad  { background: rgba(231, 76, 60, 0.18); color: #e74c3c; }
.rtt-unknown { background: rgba(149, 165, 166, 0.18); color: #95a5a6; }
.state-dot {
  width: 8px; height: 8px; border-radius: 50%;
}
.state-connecting { background: #f39c12; }
.state-connected  { background: #27ae60; }
.state-disconnected { background: #e74c3c; }

/* 日志 */
.log-box {
  max-height: 180px; overflow-y: auto; font-size: 12px; font-family: monospace;
  background: var(--bg-secondary); border-radius: 4px; padding: 8px;
}
.log-line { padding: 1px 0; word-break: break-all; }

/* 加载 */
.center-card { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 20px; }
.spinner {
  width: 28px; height: 28px; border: 3px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* 按钮 */
.btn-danger {
  background: #e74c3c; color: #fff; border: none; padding: 8px 16px;
  border-radius: 4px; cursor: pointer; font-size: 13px;
}
.btn-danger:hover { background: #c0392b; }
.btn-text {
  background: none; border: none; color: var(--accent);
  cursor: pointer; font-size: 13px; padding: 6px 0;
}
.btn-text:hover { text-decoration: underline; }

/* 手动交换 */
.btn-row { display: flex; gap: 8px; }
.code-area {
  width: 100%; min-height: 80px; max-height: 120px; resize: vertical;
  font-family: monospace; font-size: 11px; word-break: break-all;
  background: var(--bg-secondary); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: 4px; padding: 8px;
}
.code-area:read-only { cursor: pointer; }

/* 诊断弹窗 */
.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modal-body {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 24px;
  min-width: 380px; max-width: 460px;
}
.modal-body h3 { margin-bottom: 16px; }
.diag-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px;
}
.diag-row:last-of-type { border-bottom: none; }
.ok { color: #27ae60; }
.fail { color: #e74c3c; }
.warn { color: #f39c12; }
.modal-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 16px; }

/* Mod 同步 */
.mod-diff { margin-top: 8px; }
.diff-section { margin-top: 6px; }
.diff-label { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.diff-missing { color: #e74c3c; }
.diff-extra { color: #f39c12; }
.diff-item {
  font-size: 12px; padding: 3px 8px; margin: 2px 0;
  background: var(--bg-secondary); border-radius: 4px;
}
.room-actions { display: flex; gap: 8px; }

/* 3D 皮肤预览 */
.skin-preview-popup {
  position: absolute;
  right: -8px;
  top: 50%;
  transform: translateY(-50%);
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  z-index: 10;
}
.current-account-card { position: relative; }
</style>
