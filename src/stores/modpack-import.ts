import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useTasksStore } from './tasks'
import { useNotificationsStore } from './notifications'
import { useProfilesStore } from './profiles'

export interface ImportProgress {
  stage: string
  message: string
  fileProgress?: {
    total: number
    completed: number
    failed: number
    speed: number
  }
}

export const useModpackImportStore = defineStore('modpack-import', () => {
  const active = ref(false)
  const archiveName = ref('')
  const progress = ref<ImportProgress | null>(null)

  let _taskId = ''
  let _unsubProgress: (() => void) | null = null

  function reset() {
    active.value = false
    archiveName.value = ''
    progress.value = null
    _taskId = ''
    if (_unsubProgress) {
      _unsubProgress()
      _unsubProgress = null
    }
  }

  async function startImport(filePath: string, filename: string, gameDir: string) {
    if (active.value) return

    const tasksStore = useTasksStore()
    const notifsStore = useNotificationsStore()
    const profilesStore = useProfilesStore()

    if (!/\.(mrpack|zip)$/i.test(filename)) {
      notifsStore.push('error', '只支持 .zip 或 .mrpack 格式的整合包')
      return
    }

    const profileName = filename.replace(/\.(mrpack|zip)$/i, '')

    active.value = true
    archiveName.value = filename
    progress.value = { stage: 'parsing', message: '准备安装...' }

    _taskId = tasksStore.addTask('modpack', profileName)

    _unsubProgress = window.api.modpack.onInstallProgress((p) => {
      progress.value = p
      tasksStore.updateProgress(_taskId, {
        completed: p.fileProgress?.completed ?? 0,
        total: p.fileProgress?.total ?? 0,
        speed: p.fileProgress?.speed ?? 0,
        message: p.message
      })
    })

    try {
      const result = await window.api.modpack.install(
        filePath, filename, gameDir, profileName
      )

      await window.api.profiles.create({
        name: result.name,
        versionId: result.mcVersion,
        gameDir: result.instanceDir,
        modLoader: result.modLoader as any,
        iconPath: result.iconPath
      })
      await profilesStore.fetchProfiles()

      tasksStore.completeTask(_taskId)
      notifsStore.push('success', `整合包「${result.name}」导入完成`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      tasksStore.failTask(_taskId, msg)
      notifsStore.push('error', `整合包导入失败: ${msg}`)
    } finally {
      reset()
    }
  }

  return { active, archiveName, progress, startImport, reset }
})
