<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 48 })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 48 48" class="block-icon">
    <!--
      等距投影 3D 方块
      光源方向: 左上方
      法线 → 亮度:
        顶面 N=(0,1,0)   — 最亮 (accent)
        左面 N=(-0.87,0,-0.5) — 中亮 (朝向光源)
        右面 N=(0.87,0,-0.5)  — 最暗 (背光)
    -->

    <!-- 左面 (中亮 — 朝向光源一侧) -->
    <polygon class="face-left" points="5,16 24,26 24,46 5,36" />
    <!-- 右面 (最暗 — 背光侧) -->
    <polygon class="face-right" points="24,26 43,16 43,36 24,46" />
    <!-- 顶面 (最亮 — 直接受光) -->
    <polygon class="face-top" points="24,6 43,16 24,26 5,16" />

    <!-- 顶面高光 (模拟漫反射热点) -->
    <polygon class="specular" points="24,6 34,11 24,16 14,11" />

    <!-- 棱线 — 上方高光棱 -->
    <polyline class="edge-hi" points="5,16 24,6 43,16" />
    <!-- 棱线 — 面交界 -->
    <polyline class="edge-mid" points="5,16 24,26 43,16" />
    <line class="edge-mid" x1="5" y1="16" x2="5" y2="36" />
    <line class="edge-mid" x1="43" y1="16" x2="43" y2="36" />
    <!-- 棱线 — 底部阴影棱 -->
    <polyline class="edge-lo" points="5,36 24,46 43,36" />
    <line class="edge-lo" x1="24" y1="26" x2="24" y2="46" />
  </svg>
</template>

<style scoped>
.block-icon { display: block; flex-shrink: 0; }

/* 三个面：用 color-mix 将 accent 与背景混合，模拟法线着色 */
.face-top  { fill: var(--accent); }
.face-left { fill: color-mix(in srgb, var(--accent) 28%, var(--bg-hover)); }
.face-right{ fill: color-mix(in srgb, var(--accent) 16%, var(--bg-secondary)); }

/* 高光菱形 */
.specular { fill: white; opacity: 0.09; }

/* 棱线 */
.edge-hi {
  fill: none;
  stroke: color-mix(in srgb, var(--accent) 55%, white);
  stroke-width: 0.75;
  stroke-linejoin: round;
}
.edge-mid {
  fill: none;
  stroke: color-mix(in srgb, var(--accent) 20%, var(--border));
  stroke-width: 0.5;
  stroke-linejoin: round;
}
.edge-lo {
  fill: none;
  stroke: rgba(0, 0, 0, 0.22);
  stroke-width: 0.5;
  stroke-linejoin: round;
}
</style>
