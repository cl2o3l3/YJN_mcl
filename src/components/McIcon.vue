<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  name: string
  size?: number
}>(), {
  size: 20
})

// Vite eager glob
const iconModules = import.meta.glob<{ default: string }>(
  '../assets/icons/*.png',
  { eager: true }
)

function getUrl(name: string): string {
  const mod = iconModules[`../assets/icons/${name}.png`]
  return mod?.default ?? ''
}

// 正交等轴测方块：name → { top, front(视觉左面), side(视觉右面) }
// 配色原则：与 UI 冷色调(蓝紫-青绿-灰)保持一致，避免暖棕/橙色
const blockDefs: Record<string, { top: string; front: string; side: string }> = {
  home:        { top: 'warped_stem_top',     front: 'warped_stem',           side: 'warped_stem' },           // 诡异菌柄 · 青蓝色
  profiles:    { top: 'smithing_table_top',  front: 'smithing_table_front',  side: 'smithing_table_side' },   // 锻造台 · 深灰铁
  versions:    { top: 'purpur_pillar_top',   front: 'purpur_pillar',         side: 'purpur_pillar' },         // 紫珀柱 · 淡紫色
  resources:   { top: 'prismarine_bricks',   front: 'prismarine_bricks',     side: 'prismarine_bricks' },     // 海晶石砖 · 海绿色
  multiplayer: { top: 'crying_obsidian',     front: 'crying_obsidian',       side: 'crying_obsidian' },       // 哭泣黑曜石 · 深紫
  settings:    { top: 'observer_top',        front: 'observer_front',        side: 'observer_side' },         // 侦测器 · 冷灰色
  tasks:       { top: 'blast_furnace_top',   front: 'blast_furnace_front',   side: 'blast_furnace_side' },    // 高炉 · 钢铁灰
}

const isBlock = computed(() => props.name in blockDefs)
const block = computed(() => blockDefs[props.name])
const faceSize = computed(() => Math.round(props.size / 1.63))
</script>

<template>
  <!-- 等轴测方块 (CSS 3D) -->
  <span v-if="isBlock" class="mc-block" :style="{ '--s': faceSize + 'px', '--d': size + 'px' }">
    <span class="cube">
      <span class="face face-top" :style="{ backgroundImage: `url(${getUrl(block.top)})` }" />
      <span class="face face-left" :style="{ backgroundImage: `url(${getUrl(block.front)})` }" />
      <span class="face face-right" :style="{ backgroundImage: `url(${getUrl(block.side)})` }" />
    </span>
  </span>
  <!-- 物品图标 -->
  <img
    v-else-if="getUrl(name)"
    :src="getUrl(name)"
    :alt="name"
    class="mc-item"
    :width="size"
    :height="size"
  />
</template>

<style scoped>
/* ======== 等轴测方块 ======== */
.mc-block {
  display: inline-block;
  width: var(--d);
  height: var(--d);
  position: relative;
  vertical-align: middle;
  /* 亮色模式下方块加微弱投影，避免与白底融合 */
  filter: drop-shadow(0 1px 2px var(--shadow-color));
}

.cube {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  transform-style: preserve-3d;
  /* 等轴测：rotateY(45°) 看对角，rotateX(-35.264°) 俯瞰顶面 */
  transform: rotateX(-35.264deg) rotateY(45deg);
}

.face {
  position: absolute;
  width: var(--s);
  height: var(--s);
  left: calc(var(--s) / -2);
  top: calc(var(--s) / -2);
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  background-size: cover;
  backface-visibility: hidden;
}

/* 顶面 — rotateX(90deg) 使法线朝上(-Y in CSS)，旋转后 Z>0 可见 */
.face-top {
  transform: rotateX(90deg) translateZ(calc(var(--s) / 2));
}

/* 视觉左面 — rotateY(-90deg) 使法线朝-X，旋转后 Z>0 可见，MC 亮面 */
.face-left {
  transform: rotateY(-90deg) translateZ(calc(var(--s) / 2));
  filter: brightness(0.82);
}

/* 视觉右面 — translateZ 使法线朝+Z，旋转后 Z>0 可见，MC 暗面 */
.face-right {
  transform: translateZ(calc(var(--s) / 2));
  filter: brightness(0.62);
}

/* ======== 物品图标 ======== */
.mc-item {
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  display: inline-block;
  vertical-align: middle;
  object-fit: contain;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45));
}
</style>
