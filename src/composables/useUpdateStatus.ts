import { ref } from 'vue'

export interface UpdateStatusData {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  releaseNotes?: string
  progress?: { percent: number; bytesPerSecond: number; transferred: number; total: number }
  error?: string
  isPortable?: boolean
}

/** 全局更新状态，App.vue 写入，Settings.vue 读取 */
export const globalUpdateStatus = ref<UpdateStatusData>({ status: 'idle' })
