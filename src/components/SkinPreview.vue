<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { SkinViewer, IdleAnimation } from 'skinview3d'

const props = defineProps<{
  skinUrl: string
  width?: number
  height?: number
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let viewer: SkinViewer | null = null

function initViewer() {
  if (!canvasRef.value) return
  viewer?.dispose()
  viewer = new SkinViewer({
    canvas: canvasRef.value,
    width: props.width || 64,
    height: props.height || 64,
    skin: props.skinUrl
  })
  viewer.animation = new IdleAnimation()
  viewer.camera.position.set(0, 16, 40)
  viewer.camera.lookAt(0, 16, 0)
  viewer.controls.enableZoom = false
  viewer.controls.enablePan = false
}

onMounted(() => {
  initViewer()
})

watch(() => props.skinUrl, (url) => {
  if (viewer && url) {
    viewer.loadSkin(url)
  }
})

onUnmounted(() => {
  viewer?.dispose()
  viewer = null
})
</script>

<template>
  <canvas ref="canvasRef" class="skin-canvas" :width="width || 64" :height="height || 64" />
</template>

<style scoped>
.skin-canvas {
  image-rendering: pixelated;
  border-radius: 4px;
}
</style>
