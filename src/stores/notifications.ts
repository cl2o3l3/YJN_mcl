import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface NotificationItem {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
  detail?: string
  timestamp: number
  read: boolean
}

export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<NotificationItem[]>([])

  const unreadCount = computed(() => items.value.filter(n => !n.read).length)
  const recent = computed(() => items.value.slice(0, 50))

  function push(type: NotificationItem['type'], message: string, detail?: string) {
    items.value.unshift({
      id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      message,
      detail,
      timestamp: Date.now(),
      read: false
    })
    if (items.value.length > 100) items.value.length = 100
  }

  function markAllRead() {
    for (const n of items.value) n.read = true
  }

  function clear() {
    items.value = []
  }

  return { items, unreadCount, recent, push, markAllRead, clear }
})
