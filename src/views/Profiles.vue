<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useProfilesStore } from '../stores/profiles'
import { useNotificationsStore } from '../stores/notifications'
import { useSettingsStore } from '../stores/settings'
import { useModpackImportStore } from '../stores/modpack-import'
import ProfileEditor from '../components/ProfileEditor.vue'
import BlockIcon from '../components/BlockIcon.vue'
import type { GameProfile, InstalledResource, ResourceType } from '../types'

import iconFabric from '../assets/icons/fabric_loader.png'
import iconForge from '../assets/icons/forge_loader.png'
import iconNeoForge from '../assets/icons/neoforge_loader.png'
import iconQuilt from '../assets/icons/quilt_loader.png'

const profiles = useProfilesStore()
const notifsStore = useNotificationsStore()
const settings = useSettingsStore()
const modpackImport = useModpackImportStore()
const router = useRouter()

const loaderIcons: Record<string, string> = {
  fabric: iconFabric,
  forge: iconForge,
  neoforge: iconNeoForge,
  quilt: iconQuilt,
}

function defaultLoaderIcon(p: GameProfile): string | null {
  return (p.modLoader && loaderIcons[p.modLoader.type]) || null
}
const showEditor = ref(false)
const editingProfile = ref<GameProfile | null>(null)

// 实例资源查看器
const expandedId = ref<string | null>(null)
const resLoading = ref(false)
const resData = reactive<Record<string, InstalledResource[]>>({
  mod: [], shader: [], resourcepack: []
})
const resTab = ref<ResourceType>('mod')

async function toggleResources(profileId: string, gameDir: string) {
  if (expandedId.value === profileId) {
    expandedId.value = null
    return
  }
  expandedId.value = profileId
  resLoading.value = true
  try {
    const types: ResourceType[] = ['mod', 'shader', 'resourcepack']
    const results = await Promise.all(
      types.map(t => window.api.resources.installed(t, gameDir))
    )
    resData.mod = results[0]
    resData.shader = results[1]
    resData.resourcepack = results[2]
    resTab.value = 'mod'
  } finally {
    resLoading.value = false
  }
}

async function openGameDir(dir: string) {
  await window.api.system.openFolder(dir)
}

async function handleToggleResource(r: InstalledResource, gameDir: string) {
  try {
    await window.api.resources.toggle(r.type, gameDir, r.filename, !r.enabled)
    r.enabled = !r.enabled
  } catch (e: any) {
    notifsStore.push('error', `切换资源状态失败: ${e.message}`)
  }
}

async function handleRemoveResource(r: InstalledResource, gameDir: string) {
  try {
    await window.api.resources.remove(r.type, gameDir, r.filename)
    resData[r.type] = resData[r.type].filter(item => item.filename !== r.filename)
  } catch (e: any) {
    notifsStore.push('error', `删除资源失败: ${e.message}`)
  }
}

function openCreate() {
  router.push({ name: 'versions' })
}

function openEdit(profile: GameProfile) {
  editingProfile.value = profile
  showEditor.value = true
}

function closeEditor() {
  showEditor.value = false
  editingProfile.value = null
}

// ======== 导入整合包 ========
const showImportPanel = ref(false)
const dragActive = ref(false)
const customImportGameDir = ref('')

const importTargetDir = computed(() => customImportGameDir.value || settings.defaultGameDir || '将自动使用默认游戏目录')
const usingCustomImportGameDir = computed(() => !!customImportGameDir.value)

function formatSize(bytes: number): string {
  if (bytes > 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB'
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

function toggleImportPanel() {
  if (modpackImport.active) return
  showImportPanel.value = !showImportPanel.value
  dragActive.value = false
  if (!showImportPanel.value) {
    customImportGameDir.value = ''
  }
}

async function resolveInstallGameDir(): Promise<string> {
  if (customImportGameDir.value) return customImportGameDir.value
  if (settings.defaultGameDir) return settings.defaultGameDir
  return window.api.system.defaultGameDir()
}

async function chooseImportGameDir() {
  const fallbackDir = customImportGameDir.value || settings.defaultGameDir || await window.api.system.defaultGameDir()
  const selectedDir = await window.api.dialog.selectDirectoryAt(fallbackDir)
  if (!selectedDir) return
  customImportGameDir.value = selectedDir
}

function resetImportGameDir() {
  customImportGameDir.value = ''
}

async function doStartImport(filePath: string, filename: string) {
  const gameDir = await resolveInstallGameDir()
  showImportPanel.value = false
  await modpackImport.startImport(filePath, filename, gameDir)
}

async function onBrowseModpack() {
  const picked = await window.api.modpack.importLocal()
  if (!picked) return
  await doStartImport(picked.filePath, picked.filename)
}

function onDragOverImport() {
  if (!modpackImport.active) dragActive.value = true
}

function onDragLeaveImport() {
  dragActive.value = false
}

async function onDropImport(event: DragEvent) {
  dragActive.value = false
  if (modpackImport.active) return

  const dropped = event.dataTransfer?.files?.[0] as (File & { path?: string }) | undefined
  const filePath = dropped?.path
  const filename = dropped?.name
  if (!filePath || !filename) {
    notifsStore.push('error', '无法读取拖入文件，请改用浏览按钮选择整合包')
    return
  }

  await doStartImport(filePath, filename)
}
</script>

<template>
  <div class="profiles-page">
    <div class="header">
      <h2>游戏实例</h2>
      <div class="header-actions">
        <button class="btn-secondary" @click="toggleImportPanel" :disabled="modpackImport.active">
          {{ showImportPanel || modpackImport.active ? '收起导入面板' : '📥 导入整合包' }}
        </button>
        <button class="btn-primary" @click="openCreate">+ 新建实例</button>
      </div>
    </div>

    <!-- 导入整合包进度 -->
    <Transition name="slide">
    <div v-if="showImportPanel || modpackImport.active" class="card import-panel">
      <label class="import-label">导入整合包</label>
      <div
        v-if="!modpackImport.active"
        class="drop-zone"
        :class="{ active: dragActive }"
        @dragenter.prevent="onDragOverImport"
        @dragover.prevent="onDragOverImport"
        @dragleave.prevent="onDragLeaveImport"
        @drop.prevent="onDropImport"
      >
        <div class="drop-zone-title">把整合包 ZIP 或 MRPACK 直接拖到这里</div>
        <div class="drop-zone-meta">安装位置：{{ importTargetDir }}</div>
        <div class="import-dir-actions">
          <button class="btn-secondary" @click="chooseImportGameDir">选择游戏目录</button>
          <button v-if="usingCustomImportGameDir" class="btn-secondary" @click="resetImportGameDir">恢复默认目录</button>
        </div>
        <button class="btn-primary" @click="onBrowseModpack">浏览整合包文件</button>
      </div>
      <div v-if="modpackImport.archiveName" class="selected-archive">当前文件：{{ modpackImport.archiveName }}</div>
      <div class="import-progress" v-if="modpackImport.progress">
        <!-- 步骤清单 -->
        <div v-if="modpackImport.progress.steps && modpackImport.progress.steps.length > 0" class="import-steps">
          <div v-for="(s, i) in modpackImport.progress.steps" :key="i" class="import-step" :class="'step-' + s.status">
            <span class="step-icon">
              <template v-if="s.status === 'done'">✓</template>
              <template v-else-if="s.status === 'running'">{{ s.progress != null ? s.progress + '%' : '...' }}</template>
              <template v-else-if="s.status === 'error'">✗</template>
              <template v-else>•••</template>
            </span>
            <span class="step-text">{{ s.label }}</span>
          </div>
        </div>
        <!-- 进度条 -->
        <div v-if="modpackImport.progress.fileProgress" class="progress-bar-wrap">
          <div class="progress-bar" :style="{ width: (modpackImport.progress.fileProgress.completed / Math.max(modpackImport.progress.fileProgress.total, 1) * 100) + '%' }"></div>
        </div>
        <div v-if="modpackImport.progress.fileProgress" class="progress-info">
          {{ modpackImport.progress.fileProgress.completed }}/{{ modpackImport.progress.fileProgress.total }} 文件
          · {{ formatSize(modpackImport.progress.fileProgress.speed) }}/s
        </div>
        <!-- 无步骤时降级到纯文字 -->
        <div v-if="!modpackImport.progress.steps" class="progress-msg">{{ modpackImport.progress.message }}</div>
      </div>
    </div>
    </Transition>

    <div class="profile-list">
      <TransitionGroup name="list">
      <div
        v-for="p in profiles.profiles"
        :key="p.id"
        class="card profile-card"
        :class="{ selected: profiles.selectedId === p.id }"
        @click="profiles.selectedId = p.id"
      >
        <img
          v-if="p.iconPath"
          class="profile-icon"
          :src="'mc-icon:///' + encodeURIComponent(p.iconPath).replace(/%5C/g, '/').replace(/%3A/g, ':')"
          alt=""
        />
        <img v-else-if="defaultLoaderIcon(p)" class="profile-icon" :src="defaultLoaderIcon(p)!" alt="" />
        <BlockIcon v-else :size="48" />
        <div class="profile-main">
          <h3>{{ p.name }}</h3>
          <p class="text-muted">{{ p.versionId }}{{ p.modLoader ? ` · ${p.modLoader.type} ${p.modLoader.version}` : '' }}</p>
          <p class="text-muted small">{{ p.gameDir }}</p>
        </div>
        <div class="profile-actions">
          <button class="btn-secondary btn-sm" @click.stop="toggleResources(p.id, p.gameDir)">
            {{ expandedId === p.id ? '收起' : '资源' }}
          </button>
          <button class="btn-secondary btn-sm" @click.stop="openGameDir(p.gameDir)">文件夹</button>
          <button class="btn-secondary" @click.stop="openEdit(p)">编辑</button>
          <button class="btn-secondary" @click.stop="profiles.duplicateProfile(p.id)">复制</button>
          <button class="btn-danger" @click.stop="profiles.deleteProfile(p.id)">删除</button>
        </div>

        <!-- 实例资源查看器 -->
        <Transition name="slide">
        <div v-if="expandedId === p.id" class="resources-panel" @click.stop>
          <div v-if="resLoading" class="res-loading">加载中...</div>
          <template v-else>
            <div class="res-tabs">
              <button
                v-for="rt in (['mod', 'shader', 'resourcepack'] as const)" :key="rt"
                class="res-tab" :class="{ active: resTab === rt }"
                @click="resTab = rt"
              >
                {{ rt === 'mod' ? 'Mod' : rt === 'shader' ? '光影' : '资源包' }}
                ({{ resData[rt].length }})
              </button>
            </div>
            <div class="res-list">
              <div v-if="resData[resTab].length === 0" class="res-empty">无已安装资源</div>
              <div v-for="r in resData[resTab]" :key="r.filename" class="res-item" :class="{ disabled: !r.enabled }">
                <div class="res-info">
                  <span class="res-title">{{ r.title }}</span>
                  <span class="res-meta">{{ r.versionNumber || r.filename }}</span>
                </div>
                <div class="res-actions">
                  <button
                    class="res-btn"
                    :class="r.enabled ? 'res-btn-disable' : 'res-btn-enable'"
                    :title="r.enabled ? '禁用' : '启用'"
                    @click="handleToggleResource(r, p.gameDir)"
                  >{{ r.enabled ? '禁用' : '启用' }}</button>
                  <button
                    class="res-btn res-btn-delete"
                    title="删除"
                    @click="handleRemoveResource(r, p.gameDir)"
                  >删除</button>
                </div>
              </div>
            </div>
          </template>
        </div>
        </Transition>
      </div>
      </TransitionGroup>

      <div v-if="profiles.profiles.length === 0" class="empty-state">
        <p>还没有游戏实例</p>
        <button class="btn-primary" @click="openCreate">创建第一个实例</button>
      </div>
    </div>

    <Transition name="fade">
    <ProfileEditor
      v-if="showEditor"
      :profile="editingProfile"
      @close="closeEditor"
      @saved="closeEditor"
    />
    </Transition>
  </div>
</template>

<style scoped>
.profiles-page { max-width: 800px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.profile-list { display: flex; flex-direction: column; gap: 8px; }
.profile-card {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
  cursor: pointer; transition: border-color 0.2s, transform 0.2s, box-shadow 0.2s;
}
.profile-card.selected { border-color: var(--accent); }
.profile-card:hover { background: var(--bg-hover); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
.profile-icon {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}
.profile-main { flex: 1; min-width: 0; }
.profile-main h3 { font-size: 15px; margin-bottom: 2px; }
.text-muted { color: var(--text-muted); font-size: 13px; }
.small { font-size: 11px; }
.profile-actions { display: flex; gap: 6px; margin-left: auto; flex-shrink: 0; }
.profile-actions button { font-size: 12px; padding: 4px 10px; }
.btn-sm { padding: 3px 8px !important; font-size: 11px !important; }
.empty-state { text-align: center; padding: 40px; color: var(--text-secondary); }

/* 资源查看器面板 */
.resources-panel {
  width: 100%;
  margin-top: 8px;
  padding: 8px 0 0;
  border-top: 1px solid var(--border);
}
.res-loading { text-align: center; padding: 12px; color: var(--text-muted); font-size: 12px; }
.res-tabs { display: flex; gap: 4px; margin-bottom: 6px; }
.res-tab {
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: none;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-primary);
}
.res-tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.res-list { max-height: 180px; overflow-y: auto; }
.res-empty { text-align: center; padding: 12px; color: var(--text-muted); font-size: 12px; }
.res-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 4px 6px; border-radius: 3px; font-size: 12px;
}
.res-item:hover { background: var(--bg-hover); }
.res-item.disabled { opacity: 0.5; }
.res-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.res-title { color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.res-meta { color: var(--text-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.res-actions { display: flex; gap: 4px; flex-shrink: 0; margin-left: 8px; }
.res-btn {
  padding: 2px 6px; border-radius: 3px; border: 1px solid var(--border); background: none;
  cursor: pointer; font-size: 10px; color: var(--text-primary); transition: all .15s;
}
.res-btn:hover { background: var(--bg-hover); }
.res-btn-enable { color: var(--accent); border-color: var(--accent); }
.res-btn-enable:hover { background: var(--accent); color: #fff; }
.res-btn-disable { color: var(--text-muted); }
.res-btn-delete { color: #e74c3c; border-color: #e74c3c; }
.res-btn-delete:hover { background: #e74c3c; color: #fff; }

/* slide transition */
.slide-enter-active, .slide-leave-active { transition: all .2s ease; overflow: hidden; }
.slide-enter-from, .slide-leave-to { max-height: 0; opacity: 0; }
.slide-enter-to, .slide-leave-from { max-height: 300px; opacity: 1; }

/* header */
.header-actions { display: flex; gap: 8px; }

/* 导入整合包 */
.import-panel { padding: 16px; margin-bottom: 12px; }
.import-label { font-size: 14px; font-weight: 600; margin-bottom: 8px; display: block; }
.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 160px;
  border: 2px dashed var(--border);
  border-radius: 10px;
  background: var(--bg-hover);
  padding: 20px;
  text-align: center;
  transition: border-color 0.2s, background 0.2s, transform 0.2s;
}
.drop-zone.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-hover));
  transform: translateY(-1px);
}
.drop-zone-title { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.drop-zone-meta { font-size: 12px; color: var(--text-muted); }
.import-dir-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.selected-archive { margin-top: 10px; font-size: 12px; color: var(--text-muted); }
.import-progress { padding: 4px 0; }
.progress-msg { font-size: 13px; margin-bottom: 6px; color: var(--text-primary); }
.progress-bar-wrap { height: 6px; background: var(--bg-primary); border-radius: 3px; overflow: hidden; margin-bottom: 4px; }
.progress-bar { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.3s ease; }
.progress-info { font-size: 12px; color: var(--text-muted); }

/* 安装步骤清单 */
.import-steps { margin: 6px 0 8px; }
.import-step {
  display: flex; align-items: center; gap: 8px;
  padding: 3px 2px; font-size: 13px; color: var(--text-muted);
}
.import-step .step-icon {
  width: 32px; text-align: center; flex-shrink: 0;
  font-weight: 600; font-size: 11px;
}
.import-step .step-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.import-step.step-done { color: var(--accent); }
.import-step.step-done .step-icon { font-size: 14px; }
.import-step.step-running { color: var(--text-primary); font-weight: 500; }
.import-step.step-running .step-icon { color: var(--accent); }
.import-step.step-error { color: var(--danger); }
.import-step.step-error .step-icon { color: var(--danger); }
.import-step.step-waiting .step-icon { letter-spacing: -1px; }
</style>
