/**
 * 从 Mojang 官方版本 JAR 中提取 Minecraft 纹理图标
 * 新版 MC (1.20+) 纹理打包在 client JAR 中而非 asset index
 */
import https from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        res.resume()
        return
      }
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        res.resume()
        return
      }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function main() {
  // 1. 获取版本清单
  console.log('Fetching version manifest...')
  const manifest = JSON.parse(await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'))
  const latestId = manifest.latest.release
  const latest = manifest.versions.find(v => v.id === latestId)
  console.log(`Latest release: ${latestId}`)

  // 2. 获取版本详情 → client JAR URL
  console.log('Fetching version data...')
  const versionData = JSON.parse(await fetch(latest.url))
  const clientJarUrl = versionData.downloads.client.url
  console.log(`Client JAR URL: ${clientJarUrl}`)
  console.log(`Client JAR size: ${(versionData.downloads.client.size / 1024 / 1024).toFixed(1)} MB`)

  // 3. 下载 client JAR
  const jarPath = path.join(__dirname, 'client.jar')
  if (!fs.existsSync(jarPath)) {
    console.log('Downloading client JAR (this may take a moment)...')
    const jarData = await fetchBinary(clientJarUrl)
    fs.writeFileSync(jarPath, jarData)
    console.log(`JAR saved: ${(jarData.length / 1024 / 1024).toFixed(1)} MB`)
  } else {
    console.log('Using cached client.jar')
  }

  // 4. 解压纹理
  // 使用 yauzl (same as adm-zip alternative) 或者 Node 内置 zlib
  // 但最简单是用项目已有的 unzipper
  const unzipper = require('unzipper')

  // 5. 定义所需纹理 (JAR 内路径 → icon 名)
  const textureMap = {
    // === Sidebar ===
    'assets/minecraft/textures/block/grass_block_side.png':      'home',
    'assets/minecraft/textures/block/crafting_table_front.png':  'profiles',
    'assets/minecraft/textures/item/writable_book.png':          'versions',
    'assets/minecraft/textures/item/enchanted_book.png':         'resources',
    'assets/minecraft/textures/item/ender_pearl.png':            'multiplayer',
    'assets/minecraft/textures/item/redstone.png':               'settings',
    'assets/minecraft/textures/item/totem_of_undying.png':       'account',

    // === RightBar ===
    'assets/minecraft/textures/item/iron_pickaxe.png':           'tasks',
    'assets/minecraft/textures/item/name_tag.png':               'friends',
    'assets/minecraft/textures/item/bell.png':                   'notifications',

    // === 状态图标 ===
    'assets/minecraft/textures/item/emerald.png':                'success',
    'assets/minecraft/textures/item/barrier.png':                'error',
    'assets/minecraft/textures/item/blaze_powder.png':           'warning',
    'assets/minecraft/textures/item/lapis_lazuli.png':           'info',
    'assets/minecraft/textures/item/spyglass.png':               'search',

    // === 额外图标 ===
    'assets/minecraft/textures/item/paper.png':                  'copy',
    'assets/minecraft/textures/block/command_block_front.png':   'modpack',
    'assets/minecraft/textures/item/diamond_sword.png':          'game',
    'assets/minecraft/textures/block/anvil.png':                 'modloader',
    'assets/minecraft/textures/item/compass_00.png':             'compass',
    'assets/minecraft/textures/item/nether_star.png':            'nether_star',
    'assets/minecraft/textures/item/heart_of_the_sea.png':       'heart',
    'assets/minecraft/textures/item/arrow.png':                  'arrow',
    'assets/minecraft/textures/item/experience_bottle.png':      'experience',
    'assets/minecraft/textures/block/barrel_top.png':            'chest',
    'assets/minecraft/textures/block/furnace_front.png':         'furnace',
    'assets/minecraft/textures/block/tnt_side.png':              'tnt',
    'assets/minecraft/textures/block/bookshelf.png':             'bookshelf',
    'assets/minecraft/textures/item/diamond.png':                'diamond',
    'assets/minecraft/textures/item/gold_ingot.png':             'gold_ingot',
    'assets/minecraft/textures/item/iron_ingot.png':             'iron_ingot',
    'assets/minecraft/textures/item/fire_charge.png':            'fire_charge',
    'assets/minecraft/textures/item/book.png':                   'book',
    'assets/minecraft/textures/item/knowledge_book.png':         'knowledge_book',
    'assets/minecraft/textures/item/player_head.png':            'player_head',
    'assets/minecraft/textures/block/hopper_top.png':            'hopper',
    'assets/minecraft/textures/item/clock_00.png':               'clock',

    // === 正交视角方块面纹理 ===
    'assets/minecraft/textures/block/grass_block_top.png':       'grass_top',
    'assets/minecraft/textures/block/crafting_table_top.png':    'crafting_top',
    'assets/minecraft/textures/block/crafting_table_side.png':   'crafting_side',
    'assets/minecraft/textures/block/oak_planks.png':            'oak_planks',
    'assets/minecraft/textures/block/barrel_side.png':           'barrel_side',
    'assets/minecraft/textures/block/target_top.png':            'target_top',
    'assets/minecraft/textures/block/target_side.png':           'target_side',
    'assets/minecraft/textures/block/observer_top.png':          'observer_top',
    'assets/minecraft/textures/block/observer_front.png':        'observer_front',
    'assets/minecraft/textures/block/observer_side.png':         'observer_side',
    'assets/minecraft/textures/block/furnace_side.png':          'furnace_side',
    'assets/minecraft/textures/block/furnace_top.png':           'furnace_top',
    'assets/minecraft/textures/block/obsidian.png':              'obsidian',
    'assets/minecraft/textures/block/carved_pumpkin.png':        'carved_pumpkin',
    'assets/minecraft/textures/block/pumpkin_side.png':          'pumpkin_side',
    'assets/minecraft/textures/block/pumpkin_top.png':           'pumpkin_top',

    // === 冷色调方块纹理 (配色优化) ===
    'assets/minecraft/textures/block/warped_stem_top.png':       'warped_stem_top',
    'assets/minecraft/textures/block/warped_stem.png':           'warped_stem',
    'assets/minecraft/textures/block/smithing_table_top.png':    'smithing_table_top',
    'assets/minecraft/textures/block/smithing_table_front.png':  'smithing_table_front',
    'assets/minecraft/textures/block/smithing_table_side.png':   'smithing_table_side',
    'assets/minecraft/textures/block/purpur_pillar_top.png':     'purpur_pillar_top',
    'assets/minecraft/textures/block/purpur_pillar.png':         'purpur_pillar',
    'assets/minecraft/textures/block/prismarine_bricks.png':     'prismarine_bricks',
    'assets/minecraft/textures/block/crying_obsidian.png':       'crying_obsidian',
    'assets/minecraft/textures/block/blast_furnace_top.png':     'blast_furnace_top',
    'assets/minecraft/textures/block/blast_furnace_front.png':   'blast_furnace_front',
    'assets/minecraft/textures/block/blast_furnace_side.png':    'blast_furnace_side',
  }

  const neededPaths = new Set(Object.keys(textureMap))

  // 6. 创建输出目录
  const outDir = path.resolve(__dirname, '..', 'src', 'assets', 'icons')
  fs.mkdirSync(outDir, { recursive: true })

  // 7. 流式读取 JAR 并提取纹理
  console.log('\nExtracting textures from JAR...')
  let extracted = 0

  const directory = await unzipper.Open.file(jarPath)
  for (const entry of directory.files) {
    if (neededPaths.has(entry.path)) {
      const iconName = textureMap[entry.path]
      const data = await entry.buffer()
      fs.writeFileSync(path.join(outDir, `${iconName}.png`), data)
      console.log(`  ✓ ${iconName}.png ← ${entry.path} (${data.length} bytes)`)
      extracted++
      neededPaths.delete(entry.path)
    }
  }

  if (neededPaths.size > 0) {
    console.log('\n⚠ Not found in JAR:')
    for (const p of neededPaths) {
      console.log(`  - ${p} (→ ${textureMap[p]})`)
    }
  }

  console.log(`\n✅ Extracted: ${extracted}/${Object.keys(textureMap).length}`)
  console.log(`Icons saved to: ${outDir}`)

  // 清理 JAR
  // fs.unlinkSync(jarPath) // 保留以便重用
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
