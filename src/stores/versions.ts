import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { VersionManifestEntry } from '../types'

export const useVersionsStore = defineStore('versions', () => {
  const versions = ref<VersionManifestEntry[]>([])
  const loading = ref(false)
  const filter = ref<'all' | 'release' | 'snapshot'>('release')
  const localVersions = ref<string[]>([])

  const filtered = computed(() => {
    if (filter.value === 'all') return versions.value
    return versions.value.filter(v => v.type === filter.value)
  })

  async function fetchVersions() {
    loading.value = true
    try {
      versions.value = await window.api.versions.getList()
    } finally {
      loading.value = false
    }
  }

  async function fetchLocalVersions(gameDir: string) {
    try {
      localVersions.value = await window.api.versions.getLocal(gameDir)
    } catch {
      localVersions.value = []
    }
  }

  function isInstalled(versionId: string): boolean {
    return localVersions.value.includes(versionId)
  }

  return { versions, loading, filter, filtered, localVersions, fetchVersions, fetchLocalVersions, isInstalled }
})
