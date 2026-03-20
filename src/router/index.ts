import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/Home.vue') },
    { path: '/profiles', name: 'profiles', component: () => import('../views/Profiles.vue') },
    { path: '/versions', name: 'versions', component: () => import('../views/Versions.vue') },
    { path: '/resources', name: 'resources', component: () => import('../views/Resources.vue') },
    { path: '/multiplayer', name: 'multiplayer', component: () => import('../views/Multiplayer.vue') },
    { path: '/settings', name: 'settings', component: () => import('../views/Settings.vue') },
    { path: '/login', name: 'login', component: () => import('../views/Login.vue') },
  ]
})

export default router
