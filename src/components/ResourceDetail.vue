<script setup lang="ts">
import { ref } from 'vue'
import { useResourcesStore } from '../stores/resources'
import { useProfilesStore } from '../stores/profiles'
import type { ResourceVersion, ResourceFile, ResourceProject } from '../types'

const emit = defineEmits<{ close: [] }>()

const rs = useResourcesStore()
const profiles = useProfilesStore()

const deps = ref<{ required: ResourceProject[]; optional: ResourceProject[] }>({ required: [], optional: [] })
const showDeps = ref(false)
const pendingInstall = ref<{ version: ResourceVersion; file: ResourceFile } | null>(null)

function formatSize(bytes: number): string {
  if (bytes > 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB'
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

function gameDir(): string {
  return profiles.selected?.gameDir || ''
}

async function onInstallClick(version: ResourceVersion) {
  const file = version.files.find(f => f.primary) || version.files[0]
  if (!file || !rs.currentProject) return

  // 检查依赖
  const requiredDeps = version.dependencies.filter(d => d.dependencyType === 'required')
  if (requiredDeps.length > 0) {
    pendingInstall.value = { version, file }
    try {
      deps.value = await window.api.resources.dependencies(version, rs.currentProject.platform)
    } catch {
      deps.value = { required: [], optional: [] }
    }
    if (deps.value.required.length > 0) {
      showDeps.value = true
      return
    }
  }

  await doInstall(version, file)
}

async function doInstall(version: ResourceVersion, file: ResourceFile) {
  if (!rs.currentProject || !gameDir()) return
  await rs.install(file, rs.currentProject.type, gameDir(), {
    projectId: rs.currentProject.id,
    platform: rs.currentProject.platform,
    versionId: version.id,
    versionNumber: version.versionNumber,
    title: rs.currentProject.title
  })
}

async function confirmInstallWithDeps() {
  showDeps.value = false
  if (!pendingInstall.value || !rs.currentProject) return

  // 先安装依赖
  for (const dep of deps.value.required) {
    try {
      const versions = await window.api.resources.versions(
        dep.platform, dep.id,
        rs.searchLoader ? [rs.searchLoader] : undefined,
        rs.searchGameVersion ? [rs.searchGameVersion] : undefined
      )
      const latestVer = versions[0]
      if (latestVer) {
        const f = latestVer.files.find(f => f.primary) || latestVer.files[0]
        if (f) {
          await rs.install(f, dep.type, gameDir(), {
            projectId: dep.id,
            platform: dep.platform,
            versionId: latestVer.id,
            versionNumber: latestVer.versionNumber,
            title: dep.title
          })
        }
      }
    } catch {
      // 依赖安装失败不阻断
    }
  }

  // 安装主体
  const { version, file } = pendingInstall.value
  await doInstall(version, file)
  pendingInstall.value = null
}

function cancelDeps() {
  showDeps.value = false
  pendingInstall.value = null
}

function skipDepsInstall() {
  showDeps.value = false
  if (pendingInstall.value) {
    doInstall(pendingInstall.value.version, pendingInstall.value.file)
    pendingInstall.value = null
  }
}

const releaseTypeLabels: Record<string, string> = {
  release: '正式版',
  beta: '测试版',
  alpha: 'Alpha'
}
</script>

<template>
  <div class="detail-overlay" @click.self="emit('close')">
    <div class="detail-panel">
      <!-- 关闭按钮 -->
      <button class="detail-close" @click="emit('close')">✕</button>

      <!-- 加载中 -->
      <div v-if="rs.detailLoading" class="loading-text">加载中...</div>

      <template v-else-if="rs.currentProject">
        <!-- 项目头部 -->
        <div class="detail-header">
          <img v-if="rs.currentProject.iconUrl" :src="rs.currentProject.iconUrl" class="detail-icon" alt="" />
          <div>
            <h2 class="detail-title">{{ rs.currentProject.title }}</h2>
            <div class="detail-meta">
              <span>by {{ rs.currentProject.author || '未知' }}</span>
              <span>⬇ {{ rs.currentProject.downloads.toLocaleString() }}</span>
              <span>❤ {{ rs.currentProject.follows }}</span>
            </div>
          </div>
        </div>

        <p class="detail-desc">{{ rs.currentProject.description }}</p>

        <!-- 提示：没有选中实例 -->
        <div v-if="!gameDir()" class="warn-text">
          ⚠ 请先在"实例"页面选择一个实例，才能安装资源。
        </div>

        <!-- 版本列表 -->
        <h3 class="section-title">可用版本 ({{ rs.currentVersions.length }})</h3>
        <div class="version-list">
          <div v-for="v in rs.currentVersions" :key="v.id" class="version-row">
            <div class="ver-info">
              <span class="ver-name">{{ v.versionNumber }}</span>
              <span class="ver-badge" :class="v.releaseType">{{ releaseTypeLabels[v.releaseType] || v.releaseType }}</span>
              <span class="ver-game">{{ v.gameVersions.slice(0, 3).join(', ') }}</span>
              <span class="ver-loaders">{{ v.loaders.join(', ') }}</span>
            </div>
            <div class="ver-actions">
              <span class="ver-size">{{ formatSize(v.files[0]?.size || 0) }}</span>
              <button
                class="btn-primary btn-sm"
                :disabled="!gameDir() || rs.installingFiles.has(v.files[0]?.filename || '')"
                @click="onInstallClick(v)"
              >
                {{ rs.installingFiles.has(v.files[0]?.filename || '') ? '安装中...' : '安装' }}
              </button>
            </div>
          </div>
          <div v-if="rs.currentVersions.length === 0" class="empty-text">
            无匹配版本
          </div>
        </div>
      </template>

      <!-- 依赖确认弹窗 -->
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
    </div>
  </div>
</template>

<style scoped>
.detail-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 60px;
  z-index: 100;
  animation: overlay-in 0.2s ease;
}
.detail-panel {
  width: 600px;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--bg-primary);
  border-radius: 12px;
  padding: 24px;
  position: relative;
  animation: modal-slide-in 0.25s ease;
}
@keyframes overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes modal-slide-in {
  from { opacity: 0; transform: translateY(-16px); }
  to { opacity: 1; transform: translateY(0); }
}
.detail-close {
  position: absolute;
  top: 12px;
  right: 16px;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 18px;
  cursor: pointer;
}

.detail-header {
  display: flex;
  gap: 16px;
  align-items: center;
  margin-bottom: 12px;
}
.detail-icon {
  width: 64px;
  height: 64px;
  border-radius: 12px;
  object-fit: cover;
}
.detail-title {
  font-size: 20px;
  margin-bottom: 4px;
}
.detail-meta {
  display: flex;
  gap: 12px;
  font-size: 13px;
  color: var(--text-muted);
}
.detail-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 16px;
  line-height: 1.5;
}
.warn-text {
  color: #e8a838;
  font-size: 13px;
  padding: 8px 12px;
  background: rgba(232, 168, 56, 0.1);
  border-radius: 6px;
  margin-bottom: 12px;
}

.section-title {
  font-size: 14px;
  margin-bottom: 8px;
}

.version-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.version-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-secondary);
}
.ver-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ver-name {
  font-weight: 600;
  font-size: 13px;
}
.ver-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
}
.ver-badge.release { background: #2ecc40; color: #fff; }
.ver-badge.beta { background: #ff851b; color: #fff; }
.ver-badge.alpha { background: #e74c3c; color: #fff; }
.ver-game, .ver-loaders {
  font-size: 11px;
  color: var(--text-muted);
}
.ver-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.ver-size {
  font-size: 11px;
  color: var(--text-muted);
}
.btn-sm {
  font-size: 11px;
  padding: 3px 10px;
}

.loading-text, .empty-text {
  color: var(--text-muted);
  text-align: center;
  padding: 24px;
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
}
.deps-panel {
  padding: 20px;
  width: 380px;
}
.deps-panel h3 {
  margin-bottom: 8px;
}
.deps-hint {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 10px;
}
.dep-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 13px;
}
.dep-icon {
  width: 24px;
  height: 24px;
  border-radius: 4px;
}
.deps-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
