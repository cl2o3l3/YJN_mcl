import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ModLoaderType, ModLoaderVersionEntry, ForgeVersionEntry } from '../types'

export const useModloaderStore = defineStore('modloader', () => {
  const fabricVersions = ref<ModLoaderVersionEntry[]>([])
  const quiltVersions = ref<ModLoaderVersionEntry[]>([])
  const forgeVersions = ref<ForgeVersionEntry[]>([])
  const neoforgeVersions = ref<ModLoaderVersionEntry[]>([])
  const loading = ref(false)
  const installing = ref(false)
  const error = ref('')

  // 当前查询的 MC 版本（防止竞态）
  let lastMcVersion = ''

  async function fetchVersions(type: ModLoaderType, mcVersion: string) {
    if (!mcVersion) return
    lastMcVersion = mcVersion
    loading.value = true
    error.value = ''
    try {
      switch (type) {
        case 'fabric':
          fabricVersions.value = await window.api.modloader.fabricVersions(mcVersion)
          break
        case 'quilt':
          quiltVersions.value = await window.api.modloader.quiltVersions(mcVersion)
          break
        case 'forge': {
          const raw = await window.api.modloader.forgeVersions(mcVersion)
          forgeVersions.value = raw
          break
        }
        case 'neoforge':
          neoforgeVersions.value = await window.api.modloader.neoforgeVersions(mcVersion)
          break
      }
    } catch (e: unknown) {
      if (lastMcVersion === mcVersion) {
        error.value = e instanceof Error ? e.message : String(e)
      }
    } finally {
      if (lastMcVersion === mcVersion) {
        loading.value = false
      }
    }
  }

  async function install(
    type: ModLoaderType,
    mcVersion: string,
    loaderVersion: string,
    gameDir: string,
    javaPath?: string
  ): Promise<string> {
    installing.value = true
    error.value = ''
    try {
      switch (type) {
        case 'fabric':
          return await window.api.modloader.installFabric(mcVersion, loaderVersion, gameDir)
        case 'quilt':
          return await window.api.modloader.installQuilt(mcVersion, loaderVersion, gameDir)
        case 'forge':
          return await window.api.modloader.installForge(mcVersion, loaderVersion, gameDir, javaPath)
        case 'neoforge':
          return await window.api.modloader.installNeoForge(mcVersion, loaderVersion, gameDir, javaPath)
      }
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      installing.value = false
    }
  }

  function clear() {
    fabricVersions.value = []
    quiltVersions.value = []
    forgeVersions.value = []
    neoforgeVersions.value = []
    error.value = ''
  }

  return {
    fabricVersions, quiltVersions, forgeVersions, neoforgeVersions,
    loading, installing, error,
    fetchVersions, install, clear
  }
})
