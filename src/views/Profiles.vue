<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useProfilesStore } from '../stores/profiles'
import ProfileEditor from '../components/ProfileEditor.vue'
import type { GameProfile, InstalledResource, ResourceType } from '../types'

const profiles = useProfilesStore()
const router = useRouter()
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
</script>

<template>
  <div class="profiles-page">
    <div class="header">
      <h2>游戏实例</h2>
      <button class="btn-primary" @click="openCreate">+ 新建实例 (选择版本)</button>
    </div>

    <div class="profile-list">
      <TransitionGroup name="list">
      <div
        v-for="p in profiles.profiles"
        :key="p.id"
        class="card profile-card"
        :class="{ selected: profiles.selectedId === p.id }"
        @click="profiles.selectedId = p.id"
      >
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
              <div v-for="r in resData[resTab]" :key="r.filename" class="res-item">
                <span class="res-title">{{ r.title }}</span>
                <span class="res-meta">{{ r.versionNumber || r.filename }}</span>
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
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center;
  cursor: pointer; transition: border-color 0.2s, transform 0.2s, box-shadow 0.2s;
}
.profile-card.selected { border-color: var(--accent); }
.profile-card:hover { background: var(--bg-hover); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
.profile-main h3 { font-size: 15px; margin-bottom: 2px; }
.text-muted { color: var(--text-muted); font-size: 13px; }
.small { font-size: 11px; }
.profile-actions { display: flex; gap: 6px; }
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
.res-title { color: var(--text-primary); }
.res-meta { color: var(--text-muted); font-size: 11px; }

/* slide transition */
.slide-enter-active, .slide-leave-active { transition: all .2s ease; overflow: hidden; }
.slide-enter-from, .slide-leave-to { max-height: 0; opacity: 0; }
.slide-enter-to, .slide-leave-from { max-height: 300px; opacity: 1; }
</style>
