<script setup lang="ts">
import type { ResourceProject } from '../types'

const props = defineProps<{ project: ResourceProject }>()
const emit = defineEmits<{ click: [project: ResourceProject] }>()

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr)
  const diff = Date.now() - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days < 1) return '今天'
  if (days < 30) return `${days}天前`
  if (days < 365) return `${Math.floor(days / 30)}月前`
  return `${Math.floor(days / 365)}年前`
}

const typeLabels: Record<string, string> = {
  mod: 'Mod',
  shader: '光影',
  resourcepack: '资源包',
  modpack: '整合包'
}
</script>

<template>
  <div class="resource-card card" @click="emit('click', props.project)">
    <img
      v-if="project.iconUrl"
      :src="project.iconUrl"
      class="rc-icon"
      loading="lazy"
      alt=""
    />
    <div v-else class="rc-icon rc-icon-placeholder">🧩</div>

    <div class="rc-body">
      <div class="rc-header">
        <span class="rc-title">{{ project.title }}</span>
        <span class="rc-type-badge">{{ typeLabels[project.type] || project.type }}</span>
      </div>
      <div class="rc-author">by {{ project.author || '未知' }}</div>
      <div class="rc-desc">{{ project.description }}</div>
      <div class="rc-meta">
        <span class="rc-downloads">⬇ {{ formatDownloads(project.downloads) }}</span>
        <span class="rc-updated">🕐 {{ timeAgo(project.lastUpdated) }}</span>
        <span v-for="cat in project.categories.slice(0, 3)" :key="cat" class="rc-tag">{{ cat }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.resource-card {
  display: flex;
  gap: 12px;
  padding: 12px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.resource-card:hover {
  border-color: var(--accent);
}

.rc-icon {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  flex-shrink: 0;
  object-fit: cover;
}
.rc-icon-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-card);
  font-size: 24px;
}

.rc-body {
  flex: 1;
  min-width: 0;
}
.rc-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
}
.rc-title {
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rc-type-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent);
  color: #fff;
  flex-shrink: 0;
}
.rc-author {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.rc-desc {
  font-size: 12px;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 6px;
}
.rc-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--text-muted);
}
.rc-tag {
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--bg-secondary);
  font-size: 10px;
}
</style>
