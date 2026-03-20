<script setup lang="ts">
import { ref } from 'vue'
import { useTasksStore } from '../stores/tasks'
import { useNotificationsStore } from '../stores/notifications'
import { useMultiplayerStore } from '../stores/multiplayer'
import McIcon from './McIcon.vue'
import TasksPanel from './panels/TasksPanel.vue'
import FriendsPanel from './panels/FriendsPanel.vue'
import NotificationsPanel from './panels/NotificationsPanel.vue'

const tasks = useTasksStore()
const notifs = useNotificationsStore()
const mp = useMultiplayerStore()

type PanelType = 'tasks' | 'friends' | 'notifications'
const activePanel = ref<PanelType | null>(null)

function toggle(panel: PanelType) {
  activePanel.value = activePanel.value === panel ? null : panel
  // 打开通知面板时标记已读
  if (panel === 'notifications' && activePanel.value === 'notifications') {
    notifs.markAllRead()
  }
}

function closePanel() {
  activePanel.value = null
}
</script>

<template>
  <div class="right-bar">
    <!-- 展开面板 (absolute overlay) -->
    <Transition name="panel-slide">
      <div v-if="activePanel" class="panel-overlay" @click.self="closePanel">
        <div class="panel-container">
          <TasksPanel v-if="activePanel === 'tasks'" />
          <FriendsPanel v-if="activePanel === 'friends'" />
          <NotificationsPanel v-if="activePanel === 'notifications'" />
        </div>
      </div>
    </Transition>

    <!-- 图标条 -->
    <div class="icon-strip">
      <!-- 任务 -->
      <button
        class="strip-btn"
        :class="{ active: activePanel === 'tasks' }"
        @click="toggle('tasks')"
        title="任务队列"
      >
        <span class="strip-icon"><McIcon name="tasks" :size="22" /></span>
        <span class="strip-label">任务</span>
        <span v-if="tasks.activeCount > 0" class="badge active-badge">{{ tasks.activeCount }}</span>
      </button>

      <!-- 好友 -->
      <button
        class="strip-btn"
        :class="{ active: activePanel === 'friends' }"
        @click="toggle('friends')"
        title="联机 & 好友"
      >
        <span class="strip-icon"><McIcon name="friends" :size="18" /></span>
        <span class="strip-label">好友</span>
        <span v-if="mp.isInRoom" class="badge online-badge"></span>
      </button>

      <!-- 通知 -->
      <button
        class="strip-btn"
        :class="{ active: activePanel === 'notifications' }"
        @click="toggle('notifications')"
        title="通知"
      >
        <span class="strip-icon"><McIcon name="notifications" :size="18" /></span>
        <span class="strip-label">通知</span>
        <span v-if="notifs.unreadCount > 0" class="badge notif-badge">{{ notifs.unreadCount }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.right-bar {
  position: relative;
  flex-shrink: 0;
  display: flex;
  height: 100%;
}

/* 图标条 */
.icon-strip {
  width: 48px;
  background: var(--bg-sidebar);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0;
  gap: 2px;
  z-index: 11;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
}

.strip-btn {
  width: 40px;
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  transition: all 0.2s;
  position: relative;
  cursor: pointer;
}
.strip-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.strip-btn.active {
  background: var(--bg-card);
  color: var(--accent);
}

.strip-icon { line-height: 0; display: flex; align-items: center; justify-content: center; }
.strip-label { font-size: 9px; line-height: 1; }

/* 角标 */
.badge {
  position: absolute;
  top: 4px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  border-radius: 7px;
  font-size: 9px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.active-badge {
  background: var(--accent);
  color: #fff;
  padding: 0 3px;
}
.online-badge {
  width: 8px;
  height: 8px;
  min-width: 8px;
  background: var(--accent);
  top: 6px;
  right: 4px;
}
.notif-badge {
  background: var(--danger);
  color: #fff;
  padding: 0 3px;
}

/* 展开面板 */
.panel-overlay {
  position: absolute;
  top: 0;
  right: 48px;
  bottom: 0;
  width: 280px;
  z-index: 10;
  pointer-events: auto;
}
.panel-container {
  width: 100%;
  height: 100%;
  background: var(--bg-card);
  border-left: 1px solid var(--border);
  overflow-y: auto;
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.25);
}

/* 面板滑入动画 */
.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease;
}
.panel-slide-enter-from {
  transform: translateX(20px);
  opacity: 0;
}
.panel-slide-leave-to {
  transform: translateX(20px);
  opacity: 0;
}

/* 面板滚动条 */
.panel-container::-webkit-scrollbar {
  width: 4px;
}
.panel-container::-webkit-scrollbar-track {
  background: transparent;
}
.panel-container::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 2px;
}
</style>
