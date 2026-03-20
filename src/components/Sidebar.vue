<script setup lang="ts">
import { useRoute } from 'vue-router'
import McIcon from './McIcon.vue'

const route = useRoute()

const navItems = [
  { path: '/', icon: 'home', label: '主页' },
  { path: '/profiles', icon: 'profiles', label: '实例' },
  { path: '/versions', icon: 'versions', label: '版本' },
  { path: '/resources', icon: 'resources', label: '资源' },
  { path: '/multiplayer', icon: 'multiplayer', label: '联机' },
  { path: '/settings', icon: 'settings', label: '设置' },
]
</script>

<template>
  <nav class="sidebar">
    <router-link
      v-for="item in navItems"
      :key="item.path"
      :to="item.path"
      class="nav-item"
      :class="{ active: route.path === item.path }"
    >
      <span class="nav-icon"><McIcon :name="item.icon" :size="28" /></span>
      <span class="nav-label">{{ item.label }}</span>
    </router-link>

    <div class="sidebar-spacer" />

    <router-link to="/login" class="nav-item" :class="{ active: route.path === '/login' }">
      <span class="nav-icon"><McIcon name="account" :size="28" /></span>
      <span class="nav-label">账号</span>
    </router-link>
  </nav>
</template>

<style scoped>
.sidebar {
  width: 72px;
  background: var(--bg-sidebar);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  gap: 4px;
  flex-shrink: 0;
}
.nav-item {
  width: 56px;
  height: 52px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border-radius: var(--radius);
  text-decoration: none;
  color: var(--text-secondary);
  transition: all 0.2s;
  position: relative;
}
.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  transform: scale(1.06);
}
.nav-item.active {
  background: var(--bg-card);
  color: var(--accent);
}
.nav-item.active::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 24px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
  transition: height 0.25s ease;
}
.nav-icon { line-height: 0; display: flex; align-items: center; justify-content: center; }
.nav-label { font-size: 10px; margin-top: 2px; }
.sidebar-spacer { flex: 1; }
</style>
