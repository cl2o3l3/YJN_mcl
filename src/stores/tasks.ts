import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface TaskItem {
  id: string
  type: 'game' | 'resource' | 'modpack' | 'modloader'
  title: string
  status: 'running' | 'done' | 'error'
  progress?: { completed: number; total: number; speed: number; message?: string }
  error?: string
  startedAt: number
  completedAt?: number
}

export const useTasksStore = defineStore('tasks', () => {
  const tasks = ref<TaskItem[]>([])

  const activeTasks = computed(() => tasks.value.filter(t => t.status === 'running'))
  const activeCount = computed(() => activeTasks.value.length)
  const completedTasks = computed(() => tasks.value.filter(t => t.status !== 'running'))

  function addTask(type: TaskItem['type'], title: string): string {
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    tasks.value.unshift({ id, type, title, status: 'running', startedAt: Date.now() })
    // 保留最近 50 条
    if (tasks.value.length > 50) tasks.value.length = 50
    return id
  }

  function updateProgress(id: string, progress: TaskItem['progress']) {
    const t = tasks.value.find(t => t.id === id)
    if (t) t.progress = progress
  }

  function completeTask(id: string) {
    const t = tasks.value.find(t => t.id === id)
    if (t) {
      t.status = 'done'
      t.completedAt = Date.now()
    }
  }

  function failTask(id: string, error: string) {
    const t = tasks.value.find(t => t.id === id)
    if (t) {
      t.status = 'error'
      t.error = error
      t.completedAt = Date.now()
    }
  }

  function clearCompleted() {
    tasks.value = tasks.value.filter(t => t.status === 'running')
  }

  return {
    tasks, activeTasks, activeCount, completedTasks,
    addTask, updateProgress, completeTask, failTask, clearCompleted
  }
})
