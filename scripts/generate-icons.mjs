/**
 * 将源图标 PNG 放大为 256×256 / 512×512 并生成 .ico
 * 用法: node scripts/generate-icons.mjs <source.png>
 * 默认: build/icon-source.png → build/icon.png + build/icon.ico
 */
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const buildDir = path.resolve(__dirname, '..', 'build')
const publicDir = path.resolve(__dirname, '..', 'public')

const src = process.argv[2] || path.join(buildDir, 'icon-source.png')

if (!fs.existsSync(src)) {
  console.error(`❌ 找不到源图片: ${src}`)
  console.error('请将图标 PNG 放到 build/icon-source.png')
  process.exit(1)
}

const sizes = [16, 32, 48, 64, 128, 256, 512]

async function main() {
  console.log(`源图片: ${src}`)
  const meta = await sharp(src).metadata()
  console.log(`原始尺寸: ${meta.width}×${meta.height}`)

  // 生成各尺寸 PNG (nearest-neighbor 保持像素风格)
  const pngPaths = []
  for (const s of sizes) {
    const out = path.join(buildDir, `icon-${s}.png`)
    await sharp(src)
      .resize(s, s, { kernel: 'nearest' })
      .png()
      .toFile(out)
    pngPaths.push(out)
    console.log(`  ✓ ${s}×${s} → ${path.basename(out)}`)
  }

  // 主 icon.png (256×256) 用于 electron-builder
  const icon256 = path.join(buildDir, 'icon.png')
  fs.copyFileSync(path.join(buildDir, 'icon-256.png'), icon256)
  console.log(`\n✅ build/icon.png (256×256)`)

  // 复制到 public/ 供网页 favicon 使用
  fs.mkdirSync(publicDir, { recursive: true })
  fs.copyFileSync(path.join(buildDir, 'icon-32.png'), path.join(publicDir, 'icon.png'))
  console.log(`✅ public/icon.png (32×32 favicon)`)

  // 生成 .ico (包含 16/32/48/256)
  const icoSizes = [16, 32, 48, 256].map(s => path.join(buildDir, `icon-${s}.png`))
  const icoBuf = await pngToIco(icoSizes)
  const icoPath = path.join(buildDir, 'icon.ico')
  fs.writeFileSync(icoPath, icoBuf)
  console.log(`✅ build/icon.ico (多尺寸 ICO)`)

  // 清理中间文件
  for (const p of pngPaths) {
    if (p !== icon256) fs.unlinkSync(p)
  }
  // 保留 icon-256.png 因为它就是 icon.png
  console.log('\n🎉 图标生成完成！')
}

main().catch(e => { console.error(e); process.exit(1) })
