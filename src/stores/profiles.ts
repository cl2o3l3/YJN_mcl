import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { GameProfile, JvmArgs, ModLoaderInfo, VersionIsolationMode } from '../types'

export const useProfilesStore = defineStore('profiles', () => {
  const profiles = ref<GameProfile[]>([])
  const selectedId = ref<string>('')
  const loading = ref(false)

  const selected = computed(() =>
    profiles.value.find(p => p.id === selectedId.value)
  )

  async function fetchProfiles() {
    loading.value = true
    try {
      profiles.value = await window.api.profiles.getAll()
      // 自动选中最近玩过的
      if (!selectedId.value && profiles.value.length > 0) {
        const sorted = [...profiles.value].sort((a, b) =>
          (b.lastPlayed || 0) - (a.lastPlayed || 0))
        selectedId.value = sorted[0].id
      }
    } finally {
      loading.value = false
    }
  }

  async function createProfile(opts: {
    name: string
    versionId: string
    gameDir?: string
    baseGameDir?: string
    versionIsolation?: VersionIsolationMode
    javaPath?: string
    jvmArgs?: JvmArgs
    modLoader?: ModLoaderInfo
    windowWidth?: number
    windowHeight?: number
    accountId?: string
    iconPath?: string
    tags?: string[]
  }) {
    const profile = await window.api.profiles.create(opts)
    profiles.value.push(profile)
    selectedId.value = profile.id
    return profile
  }

  async function updateProfile(id: string, updates: Partial<GameProfile>) {
    const plain = JSON.parse(JSON.stringify(updates))
    const result = await window.api.profiles.update(id, plain)
    if (result) {
      const idx = profiles.value.findIndex(p => p.id === id)
      if (idx !== -1) profiles.value[idx] = result
    }
    return result
  }

  async function deleteProfile(id: string) {
    const ok = await window.api.profiles.delete(id)
    if (ok) {
      profiles.value = profiles.value.filter(p => p.id !== id)
      if (selectedId.value === id) {
        selectedId.value = profiles.value[0]?.id || ''
      }
    }
    return ok
  }

  async function duplicateProfile(id: string) {
    const result = await window.api.profiles.duplicate(id)
    if (result) profiles.value.push(result)
    return result
  }

  async function scanDir(gameDir: string) {
    const added = await window.api.profiles.scanDir(gameDir)
    if (added.length > 0) {
      profiles.value.push(...added)
    }
    return added
  }

  return {
    profiles, selectedId, selected, loading,
    fetchProfiles, createProfile, updateProfile, deleteProfile, duplicateProfile, scanDir
  }
})
