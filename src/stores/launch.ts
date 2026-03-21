import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DownloadProgress } from '../types'

export const useLaunchStore = defineStore('launch', () => {
  const isLaunching = ref(false)
  const isRunning = ref(false)
  const downloadProgress = ref<DownloadProgress | null>(null)
  const gameLogs = ref<string[]>([])
  const error = ref<string>('')

  async function installAndLaunch(profileId: string) {
    isLaunching.value = true
    error.value = ''
    gameLogs.value = []

    try {
      const profile = await window.api.profiles.get(profileId)
      if (!profile) throw new Error('实例不存在')

      // 1. 安装/补全文件
      const unsubProgress = window.api.download.onProgress((p) => {
        downloadProgress.value = p
      })

      await window.api.download.installVersion(profile.versionId, profile.gameDir)
      unsubProgress()
      downloadProgress.value = null

      // 2. 启动游戏 — 需要账号
      // 这里只是占位, 实际调用在 view 层传入 account
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      isLaunching.value = false
    }
  }

  // Store 级监听：不依赖组件生命周期，避免切换页面后 exit 事件丢失
  let _listenersSetup = false

  function ensureListeners() {
    if (_listenersSetup) return
    _listenersSetup = true

    window.api.launch.onLog((log) => {
      gameLogs.value.push(log)
      if (gameLogs.value.length > 500) gameLogs.value.shift()
    })

    window.api.launch.onExit((code) => {
      isRunning.value = false
      if (code !== 0 && code !== null) {
        error.value = `游戏异常退出 (code: ${code})`
      }
    })
  }

  // 首次创建 store 时立即注册
  ensureListeners()

  return {
    isLaunching, isRunning, downloadProgress, gameLogs, error,
    installAndLaunch, ensureListeners
  }
})
