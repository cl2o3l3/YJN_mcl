<script setup lang="ts">
const api = window.api
</script>

<template>
  <div class="titlebar" style="-webkit-app-region: drag">
    <span class="titlebar-title">MC Launcher</span>
    <div class="titlebar-controls" style="-webkit-app-region: no-drag">
      <button class="tb-btn" @click="api.window.minimize()">&#x2014;</button>
      <button class="tb-btn" @click="api.window.maximize()">&#x25A1;</button>
      <button class="tb-btn tb-close" @click="api.window.close()">&#x2715;</button>
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  height: var(--titlebar-height);
  background: var(--bg-sidebar);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  flex-shrink: 0;
}
.titlebar-title {
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: 600;
}
.titlebar-controls {
  display: flex;
  gap: 2px;
}
.tb-btn {
  width: 36px;
  height: 28px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.tb-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.tb-close:hover { background: var(--danger); color: #fff; }
</style>
