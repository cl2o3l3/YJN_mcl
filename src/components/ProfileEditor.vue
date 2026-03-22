<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue'
import { useProfilesStore } from '../stores/profiles'
import { useModloaderStore } from '../stores/modloader'
import type { GameProfile, GCType, JvmArgs, ModLoaderType } from '../types'
import { GC_PRESETS } from '../types'

const props = defineProps<{
  profile: GameProfile | null  // null = 新建
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const profiles = useProfilesStore()
const modloaderStore = useModloaderStore()

// 表单数据
const name = ref(props.profile?.name || '')
const versionId = ref(props.profile?.versionId || '')
const gameDir = ref(props.profile?.gameDir || '')
const javaPath = ref(props.profile?.javaPath || '')
const loaderType = ref<ModLoaderType | ''>(props.profile?.modLoader?.type || '')
const loaderVersion = ref(props.profile?.modLoader?.version || '')
const gcType = ref<GCType>(props.profile?.jvmArgs.gcType || 'G1GC')
const maxMemory = ref(props.profile?.jvmArgs.maxMemory || 4096)
const minMemory = ref(props.profile?.jvmArgs.minMemory || 1024)
const extraArgs = ref(props.profile?.jvmArgs.extraArgs?.join(' ') || '-Dlog4j2.formatMsgNoLookups=true')
const gcArgsText = ref(props.profile?.jvmArgs.gcArgs?.join('\n') || GC_PRESETS.G1GC.join('\n'))
const windowWidth = ref(props.profile?.windowWidth || 1280)
const windowHeight = ref(props.profile?.windowHeight || 720)
const iconPath = ref(props.profile?.iconPath || '')
const tags = ref<string[]>(props.profile?.tags ? [...props.profile.tags] : [])
const newTag = ref('')
const totalMemory = ref(0)
const javas = ref<{ path: string; version: string; majorVersion: number }[]>([])
const scanningJava = ref(false)

// Mod Loader 版本列表的计算属性
const loaderVersionOptions = computed(() => {
  switch (loaderType.value) {
    case 'fabric': return modloaderStore.fabricVersions.map(v => ({ label: v.version + (v.stable ? '' : ' (unstable)'), value: v.version }))
    case 'quilt': return modloaderStore.quiltVersions.map(v => ({ label: v.version + (v.stable ? '' : ' (unstable)'), value: v.version }))
    case 'forge': return modloaderStore.forgeVersions.map(v => ({ label: v.version, value: v.version }))
    case 'neoforge': return modloaderStore.neoforgeVersions.map(v => ({ label: v.version + (v.stable ? '' : ' (unstable)'), value: v.version }))
    default: return []
  }
})

// 当 MC 版本或 loader 类型变化时自动拉取 loader 版本列表
watch([() => versionId.value, () => loaderType.value], ([mcVer, lt]) => {
  loaderVersion.value = ''
  if (mcVer && lt) {
    modloaderStore.fetchVersions(lt as ModLoaderType, mcVer)
  } else {
    modloaderStore.clear()
  }
})

onMounted(async () => {
  totalMemory.value = await window.api.system.totalMemory()
  if (!gameDir.value) {
    gameDir.value = await window.api.system.defaultGameDir()
  }
  scanJava()
})

async function scanJava() {
  scanningJava.value = true
  try {
    javas.value = await window.api.java.scan()
    // 如果当前选中的路径不在扫描结果中（比如已保存的手动路径），补入列表
    if (javaPath.value && !javas.value.some(j => j.path === javaPath.value)) {
      const info = await window.api.java.validate(javaPath.value)
      if (info) {
        javas.value.unshift({ path: info.path, version: info.version, majorVersion: info.majorVersion })
      }
    }
  } finally {
    scanningJava.value = false
  }
}

function onGcChange() {
  if (gcType.value !== 'custom') {
    gcArgsText.value = GC_PRESETS[gcType.value as keyof typeof GC_PRESETS]?.join('\n') || ''
  }
}

async function selectIcon() {
  const file = await window.api.dialog.selectFile([{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }])
  if (file) iconPath.value = file
}

function clearIcon() { iconPath.value = '' }

function addTag() {
  const t = newTag.value.trim()
  if (t && !tags.value.includes(t)) tags.value.push(t)
  newTag.value = ''
}

function removeTag(tag: string) {
  tags.value = tags.value.filter(t => t !== tag)
}

async function selectGameDir() {
  const dir = await window.api.dialog.selectDirectory()
  if (dir) gameDir.value = dir
}

async function selectJava() {
  const file = await window.api.dialog.selectFile([{ name: 'Java', extensions: ['exe'] }])
  if (file) {
    const info = await window.api.java.validate(file)
    if (info) {
      // 把手动选择的 Java 加入下拉列表，避免 <select> 显示空白
      if (!javas.value.some(j => j.path === info.path)) {
        javas.value.unshift({ path: info.path, version: info.version, majorVersion: info.majorVersion })
      }
      javaPath.value = info.path
    } else {
      alert('所选文件不是有效的Java可执行文件')
    }
  }
}

async function save() {
  if (!name.value || !versionId.value) return

  const jvmArgs: JvmArgs = {
    maxMemory: maxMemory.value,
    minMemory: minMemory.value,
    gcType: gcType.value,
    gcArgs: gcArgsText.value.split('\n').map(s => s.trim()).filter(Boolean),
    extraArgs: extraArgs.value.split(' ').filter(Boolean)
  }

  const modLoader = loaderType.value && loaderVersion.value
    ? { type: loaderType.value as ModLoaderType, version: loaderVersion.value }
    : undefined

  if (props.profile) {
    await profiles.updateProfile(props.profile.id, {
      name: name.value,
      versionId: versionId.value,
      gameDir: gameDir.value,
      javaPath: javaPath.value,
      jvmArgs,
      modLoader,
      windowWidth: windowWidth.value,
      windowHeight: windowHeight.value,
      iconPath: iconPath.value || undefined,
      tags: tags.value.length ? tags.value : undefined
    })
  } else {
    await profiles.createProfile({
      name: name.value,
      versionId: versionId.value,
      gameDir: gameDir.value,
      javaPath: javaPath.value,
      jvmArgs,
      modLoader
    })
  }

  emit('saved')
}
</script>

<template>
  <div class="editor-overlay" @click.self="emit('close')">
    <div class="editor card">
      <h3>{{ profile ? '编辑实例' : '新建实例' }}</h3>

      <!-- 实例图标 -->
      <div class="form-group icon-group">
        <label>实例图标</label>
        <div class="icon-row">
          <div class="icon-preview">
            <img v-if="iconPath" :src="'mc-icon:///' + encodeURIComponent(iconPath).replace(/%5C/g, '/').replace(/%3A/g, ':')" alt="" />
            <span v-else class="icon-placeholder">🖼️</span>
          </div>
          <button class="btn-secondary" @click="selectIcon">选择图标</button>
          <button v-if="iconPath" class="btn-secondary" @click="clearIcon">清除</button>
        </div>
      </div>

      <div class="form-group">
        <label>实例名称</label>
        <input v-model="name" placeholder="我的世界 1.21" />
      </div>

      <div class="form-group">
        <label>MC 版本</label>
        <input :value="versionId" disabled class="readonly-input" />
      </div>

      <!-- Mod Loader -->
      <div class="form-group">
        <label>Mod Loader <span class="text-hint">（可选）</span></label>
        <select v-model="loaderType">
          <option value="">无</option>
          <option value="fabric">Fabric</option>
          <option value="forge">Forge</option>
          <option value="neoforge">NeoForge</option>
          <option value="quilt">Quilt</option>
        </select>
      </div>

      <div v-if="loaderType" class="form-group">
        <label>Loader 版本</label>
        <div v-if="modloaderStore.loading" class="text-hint">加载中…</div>
        <div v-else-if="modloaderStore.error" class="text-hint" style="color: var(--danger)">加载失败: {{ modloaderStore.error }}</div>
        <select v-else v-model="loaderVersion" :disabled="loaderVersionOptions.length === 0">
          <option value="" disabled>选择版本</option>
          <option v-for="opt in loaderVersionOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </div>

      <div class="form-group">
        <label>游戏目录</label>
        <div class="input-row">
          <input v-model="gameDir" readonly class="flex-input" />
          <button class="btn-secondary" @click="selectGameDir">浏览...</button>
        </div>
      </div>

      <div class="form-group">
        <label>启动 Java <span class="text-hint">(当前实例专用，留空则用全局默认/自动检测)</span></label>
        <div class="input-row">
          <select v-model="javaPath" class="flex-input">
            <option value="">跟随全局默认 / 自动检测</option>
            <option v-for="j in javas" :key="j.path" :value="j.path">
              Java {{ j.majorVersion }} ({{ j.version }}) - {{ j.path }}
            </option>
          </select>
          <button class="btn-secondary" @click="selectJava">手动选择</button>
          <button class="btn-secondary" @click="scanJava" :disabled="scanningJava">
            {{ scanningJava ? '扫描中...' : '重新扫描' }}
          </button>
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>最大内存 (MB)</label>
          <input type="number" v-model.number="maxMemory" :max="totalMemory" min="512" step="256" />
          <span class="text-hint">系统总内存: {{ totalMemory }} MB</span>
        </div>
        <div class="form-group">
          <label>最小内存 (MB)</label>
          <input type="number" v-model.number="minMemory" :max="maxMemory" min="256" step="256" />
        </div>
      </div>

      <div class="form-group">
        <label>GC 类型</label>
        <select v-model="gcType" @change="onGcChange">
          <option value="G1GC">G1GC (默认)</option>
          <option value="AikarG1">Aikar's Flags (服务器/模组推荐)</option>
          <option value="ZGC">ZGC (大内存低延迟, Java 17+)</option>
          <option value="ShenandoahGC">Shenandoah (低延迟)</option>
          <option value="GraalVMG1">GraalVM G1 (需 GraalVM JDK)</option>
          <option value="ParallelGC">Parallel GC</option>
          <option value="SerialGC">Serial GC</option>
          <option value="custom">自定义</option>
        </select>
      </div>

      <div class="form-group">
        <label>GC 参数 <span class="text-hint">(每行一个)</span></label>
        <textarea v-model="gcArgsText" rows="4" class="mono-input" />
      </div>

      <div class="form-group">
        <label>额外 JVM 参数 <span class="text-hint">(空格分隔)</span></label>
        <input v-model="extraArgs" placeholder="-Dlog4j2.formatMsgNoLookups=true" />
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>窗口宽度</label>
          <input type="number" v-model.number="windowWidth" min="800" />
        </div>
        <div class="form-group">
          <label>窗口高度</label>
          <input type="number" v-model.number="windowHeight" min="600" />
        </div>
      </div>

      <!-- 标签 -->
      <div class="form-group">
        <label>标签 <span class="text-hint">（可用于分组筛选）</span></label>
        <div class="tag-editor">
          <div class="tag-list" v-if="tags.length">
            <span v-for="t in tags" :key="t" class="tag-badge">
              {{ t }}
              <button class="tag-x" @click="removeTag(t)">&times;</button>
            </span>
          </div>
          <div class="tag-input-row">
            <input v-model="newTag" placeholder="输入标签后回车" @keyup.enter="addTag" />
            <button class="btn-secondary" @click="addTag" :disabled="!newTag.trim()">添加</button>
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn-secondary" @click="emit('close')">取消</button>
        <button class="btn-primary" @click="save" :disabled="!name || !versionId">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
  z-index: 100;
  animation: overlay-in 0.2s ease;
}
.editor {
  width: 620px; max-height: 85vh; overflow-y: auto; padding: 24px;
  animation: modal-scale-in 0.22s ease;
}
@keyframes overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes modal-scale-in {
  from { opacity: 0; transform: scale(0.92); }
  to { opacity: 1; transform: scale(1); }
}
.editor h3 { font-size: 18px; margin-bottom: 16px; }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; margin-bottom: 4px; font-size: 13px; color: var(--text-secondary); }
.form-group input, .form-group select, .form-group textarea {
  width: 100%;
}
.form-row { display: flex; gap: 12px; }
.form-row .form-group { flex: 1; }
.input-row { display: flex; gap: 6px; }
.flex-input { flex: 1; }
.text-hint { color: var(--text-muted); font-size: 11px; }
.mono-input {
  background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text-primary); padding: 8px; font-family: 'Cascadia Mono', monospace; font-size: 12px;
  resize: vertical;
}
textarea:focus { border-color: var(--accent); outline: none; }
.readonly-input { background: var(--bg-secondary); color: var(--text-muted); cursor: not-allowed; }
.form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

/* 图标选择 */
.icon-group { margin-bottom: 12px; }
.icon-row { display: flex; align-items: center; gap: 8px; }
.icon-preview {
  width: 48px; height: 48px; border-radius: 8px; overflow: hidden;
  border: 1px solid var(--border); display: flex; align-items: center; justify-content: center;
  background: var(--bg-secondary); flex-shrink: 0;
}
.icon-preview img { width: 100%; height: 100%; object-fit: cover; }
.icon-placeholder { font-size: 24px; }

/* 标签编辑 */
.tag-editor { display: flex; flex-direction: column; gap: 6px; }
.tag-list { display: flex; flex-wrap: wrap; gap: 6px; }
.tag-badge {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--accent); color: #fff; border-radius: 12px;
  padding: 2px 10px; font-size: 12px;
}
.tag-x {
  background: none; border: none; color: rgba(255,255,255,0.7); cursor: pointer;
  font-size: 14px; line-height: 1; padding: 0 2px;
}
.tag-x:hover { color: #fff; }
.tag-input-row { display: flex; gap: 6px; }
.tag-input-row input { flex: 1; }
</style>
