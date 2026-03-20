<script setup lang="ts">
import { computed } from 'vue'
import { useMultiplayerStore } from '../../stores/multiplayer'
import { useRouter } from 'vue-router'

const mp = useMultiplayerStore()
const router = useRouter()

const connectedPeers = computed(() => mp.peers.filter(p => p.state === 'connected'))
const otherPeers = computed(() => mp.peers.filter(p => p.state !== 'connected'))

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}

function goMultiplayer() {
  router.push('/multiplayer')
}
</script>

<template>
  <div class="friends-panel">
    <div class="panel-header">
      <span class="panel-title">联机 & 好友</span>
    </div>

    <!-- 当前房间 -->
    <div v-if="mp.isInRoom" class="section">
      <div class="section-label">
        当前房间
        <span class="room-badge">{{ mp.roomCode || mp.roomId.slice(0, 6) }}</span>
      </div>
      <div v-for="p in connectedPeers" :key="p.id" class="peer-item online">
        <span class="peer-dot green"></span>
        <span class="peer-name">{{ p.name }}</span>
        <span class="peer-rtt">{{ p.rtt }}ms</span>
      </div>
      <div v-for="p in otherPeers" :key="p.id" class="peer-item">
        <span class="peer-dot" :class="p.state === 'connecting' ? 'yellow' : 'gray'"></span>
        <span class="peer-name">{{ p.name }}</span>
        <span class="peer-state">{{ p.state === 'connecting' ? '连接中' : '已断开' }}</span>
      </div>
      <div v-if="mp.peers.length === 0" class="empty-hint">等待玩家加入...</div>
    </div>

    <!-- 快捷操作 -->
    <div class="section">
      <div class="section-label">快捷操作</div>
      <div class="quick-actions">
        <button class="action-btn" @click="goMultiplayer">
          {{ mp.isInRoom ? '管理房间' : '创建/加入房间' }}
        </button>
      </div>
    </div>

    <!-- 最近玩家 -->
    <div v-if="mp.recentPlayers.length > 0" class="section">
      <div class="section-label">最近一起玩</div>
      <div v-for="rp in mp.recentPlayers" :key="rp.name" class="peer-item recent">
        <span class="peer-dot gray"></span>
        <span class="peer-name">{{ rp.name }}</span>
        <span class="peer-time">{{ timeAgo(rp.lastSeen) }}</span>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="!mp.isInRoom && mp.recentPlayers.length === 0" class="empty-state">
      还没有联机记录<br/>前往联机页面开始游玩
    </div>
  </div>
</template>

<style scoped>
.friends-panel { padding: 0; }
.panel-header {
  display: flex;
  align-items: center;
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--border);
}
.panel-title { font-size: 13px; font-weight: 600; }

.section {
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
}
.section-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.room-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--accent);
  color: #fff;
  text-transform: none;
  letter-spacing: 0;
}

.peer-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 12px;
}
.peer-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.peer-dot.green { background: var(--accent); }
.peer-dot.yellow { background: #f0c040; }
.peer-dot.gray { background: var(--text-muted); }
.peer-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.peer-rtt { color: var(--text-muted); font-size: 11px; }
.peer-state { color: var(--text-muted); font-size: 11px; }
.peer-time { color: var(--text-muted); font-size: 11px; }

.quick-actions { display: flex; gap: 6px; }
.action-btn {
  flex: 1;
  padding: 6px 10px;
  font-size: 12px;
  background: var(--accent);
  color: #fff;
  border-radius: 6px;
}
.action-btn:hover { background: var(--accent-hover); }

.empty-hint {
  font-size: 11px;
  color: var(--text-muted);
  padding: 4px 0;
}
.empty-state {
  padding: 32px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}
</style>
