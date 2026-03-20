<script setup lang="ts">
import { useTasksStore } from '../../stores/tasks'
import McIcon from '../McIcon.vue'

const tasks = useTasksStore()

function formatSpeed(bytes: number): string {
  if (bytes > 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB/s'
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB/s'
  return bytes + ' B/s'
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  return `${Math.floor(diff / 3600)} 小时前`
}

const typeLabels: Record<string, string> = {
  game: '游戏',
  resource: '资源',
  modpack: '整合包',
  modloader: 'Loader'
}
</script>

<template>
  <div class="tasks-panel">
    <div class="panel-header">
      <span class="panel-title">任务队列</span>
      <button v-if="tasks.completedTasks.length > 0" class="btn-clear" @click="tasks.clearCompleted">清除已完成</button>
    </div>

    <!-- 活跃任务 -->
    <div v-for="t in tasks.activeTasks" :key="t.id" class="task-item active">
      <div class="task-head">
        <span class="task-type-badge">{{ typeLabels[t.type] || t.type }}</span>
        <span class="task-title">{{ t.title }}</span>
      </div>
      <div v-if="t.progress" class="task-progress">
        <div class="progress-bar-wrap">
          <div class="progress-bar" :style="{ width: (t.progress.completed / Math.max(t.progress.total, 1) * 100) + '%' }"></div>
        </div>
        <div class="progress-meta">
          {{ t.progress.completed }}/{{ t.progress.total }}
          <span v-if="t.progress.speed > 0"> · {{ formatSpeed(t.progress.speed) }}</span>
        </div>
      </div>
      <div v-else class="task-running">运行中...</div>
    </div>

    <!-- 已完成 -->
    <div v-for="t in tasks.completedTasks.slice(0, 15)" :key="t.id" class="task-item" :class="t.status">
      <div class="task-head">
        <span class="task-type-badge">{{ typeLabels[t.type] || t.type }}</span>
        <span class="task-title">{{ t.title }}</span>
      </div>
      <div class="task-footer">
        <span v-if="t.status === 'done'" class="status-done"><McIcon name="success" :size="14" /> 完成</span>
        <span v-else class="status-error"><McIcon name="error" :size="14" /> {{ t.error || '失败' }}</span>
        <span class="task-time">{{ timeAgo(t.completedAt || t.startedAt) }}</span>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="tasks.tasks.length === 0" class="empty-state">
      暂无任务
    </div>
  </div>
</template>

<style scoped>
.tasks-panel { padding: 0; }
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--border);
}
.panel-title { font-size: 13px; font-weight: 600; }
.btn-clear {
  font-size: 11px;
  padding: 2px 8px;
  background: var(--bg-hover);
  color: var(--text-secondary);
  border-radius: 4px;
}
.btn-clear:hover { background: var(--border); }

.task-item {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.task-item.active { background: rgba(78, 204, 163, 0.04); }
.task-item.error { opacity: 0.7; }

.task-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.task-type-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--bg-hover);
  color: var(--text-secondary);
  flex-shrink: 0;
}
.task-title {
  font-size: 12px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-progress { margin-top: 4px; }
.progress-bar-wrap {
  height: 4px;
  background: var(--bg-primary);
  border-radius: 2px;
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.3s ease;
}
.progress-meta {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

.task-running {
  font-size: 11px;
  color: var(--accent);
}

.task-footer {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
}
.status-done { color: var(--accent); }
.status-error { color: var(--danger); }
.task-time { color: var(--text-muted); }

.empty-state {
  padding: 32px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
