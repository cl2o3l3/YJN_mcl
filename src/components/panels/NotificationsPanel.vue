<script setup lang="ts">
import { useNotificationsStore } from '../../stores/notifications'
import McIcon from '../McIcon.vue'

const notifs = useNotificationsStore()

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}

const typeIcon: Record<string, string> = {
  success: 'success',
  error: 'error',
  warning: 'warning',
  info: 'info'
}
</script>

<template>
  <div class="notifs-panel">
    <div class="panel-header">
      <span class="panel-title">通知</span>
      <div class="header-actions">
        <button v-if="notifs.unreadCount > 0" class="btn-clear" @click="notifs.markAllRead">全部已读</button>
        <button v-if="notifs.items.length > 0" class="btn-clear" @click="notifs.clear">清空</button>
      </div>
    </div>

    <div v-for="n in notifs.recent" :key="n.id" class="notif-item" :class="[n.type, { unread: !n.read }]">
      <span class="notif-icon" :class="n.type"><McIcon :name="typeIcon[n.type]" :size="14" /></span>
      <div class="notif-body">
        <div class="notif-message">{{ n.message }}</div>
        <div v-if="n.detail" class="notif-detail">{{ n.detail }}</div>
        <div class="notif-time">{{ timeAgo(n.timestamp) }}</div>
      </div>
    </div>

    <div v-if="notifs.items.length === 0" class="empty-state">
      暂无通知
    </div>
  </div>
</template>

<style scoped>
.notifs-panel { padding: 0; }
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--border);
}
.panel-title { font-size: 13px; font-weight: 600; }
.header-actions { display: flex; gap: 4px; }
.btn-clear {
  font-size: 11px;
  padding: 2px 8px;
  background: var(--bg-hover);
  color: var(--text-secondary);
  border-radius: 4px;
}
.btn-clear:hover { background: var(--border); }

.notif-item {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  transition: background 0.15s;
}
.notif-item.unread { background: rgba(78, 204, 163, 0.04); }

.notif-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  margin-top: 1px;
}
.notif-icon.success { background: rgba(78, 204, 163, 0.15); color: var(--accent); }
.notif-icon.error { background: rgba(231, 76, 60, 0.15); color: var(--danger); }
.notif-icon.warning { background: rgba(240, 192, 64, 0.15); color: #f0c040; }
.notif-icon.info { background: rgba(100, 150, 220, 0.15); color: #6496dc; }

.notif-body { flex: 1; min-width: 0; }
.notif-message {
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.4;
}
.notif-detail {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.notif-time {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 2px;
}

.empty-state {
  padding: 32px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
