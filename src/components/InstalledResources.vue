<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useResourcesStore } from '../stores/resources'
import { useProfilesStore } from '../stores/profiles'
import type { ResourceType, InstalledResource } from '../types'

const rs = useResourcesStore()
const profiles = useProfilesStore()

const activeType = ref<ResourceType>('mod')

const typeTabs: { label: string; value: ResourceType }[] = [
  { label: 'Mod', value: 'mod' },
  { label: '光影', value: 'shader' },
  { label: '资源包', value: 'resourcepack' },
]

function gameDir(): string {
  return profiles.selected?.gameDir || ''
}

async function refresh() {
  if (!gameDir()) return
  await rs.loadInstalled(activeType.value, gameDir())
}

async function onRemove(item: InstalledResource) {
  if (!gameDir()) return
  await rs.remove(item.type, gameDir(), item.filename)
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN')
}

onMounted(refresh)

watch(activeType, refresh)
watch(() => profiles.selected?.id, refresh)
</script>

<template>
  <div class="installed-panel">
    <div v-if="!gameDir()" class="warn-text">
      ⚠ 请先在"实例"页面选择一个实例。
    </div>

    <template v-else>
      <!-- 类型 Tabs -->
      <div class="type-tabs">
        <button
          v-for="t in typeTabs" :key="t.value"
          class="type-tab"
          :class="{ active: activeType === t.value }"
          @click="activeType = t.value"
        >
          {{ t.label }}
        </button>
        <button class="btn-secondary btn-sm" style="margin-left: auto;" @click="refresh">
          刷新
        </button>
      </div>

      <!-- 列表 -->
      <div v-if="rs.installedLoading" class="loading-text">加载中...</div>

      <div v-else-if="rs.installedList.length === 0" class="empty-text">
        暂无已安装的{{ typeTabs.find(t => t.value === activeType)?.label || '资源' }}
      </div>

      <div v-else class="installed-list">
        <div v-for="item in rs.installedList" :key="item.filename" class="installed-row">
          <div class="inst-info">
            <span class="inst-name">{{ item.title || item.filename }}</span>
            <span v-if="item.versionNumber" class="inst-ver">v{{ item.versionNumber }}</span>
            <span class="inst-date">{{ formatDate(item.installedAt) }}</span>
            <span v-if="!item.projectId" class="inst-tag external">手动安装</span>
          </div>
          <button class="btn-danger btn-sm" @click="onRemove(item)">删除</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.installed-panel {
  margin-top: 4px;
}
.warn-text {
  color: #e8a838;
  font-size: 13px;
  padding: 12px;
}
.type-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  align-items: center;
}
.type-tab {
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-primary);
}
.type-tab.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.btn-sm {
  font-size: 11px;
  padding: 3px 10px;
}
.loading-text, .empty-text {
  color: var(--text-muted);
  text-align: center;
  padding: 24px;
  font-size: 14px;
}
.installed-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.installed-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--bg-secondary);
}
.inst-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.inst-name {
  font-weight: 600;
  font-size: 13px;
}
.inst-ver {
  font-size: 11px;
  color: var(--text-muted);
}
.inst-date {
  font-size: 11px;
  color: var(--text-muted);
}
.inst-tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
}
.inst-tag.external {
  background: #e8a838;
  color: #fff;
}
</style>
