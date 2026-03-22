/**
 * Save Sync — 存档打包/解包工具
 * 将 MC 世界存档打包为 zip 用于 P2P 传输，以及接收后解包
 */

import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import * as zlib from 'node:zlib'

// 使用 Node.js 内置模块实现简单的 zip/unzip（通过 tar + gzip）
// 为了更广泛的兼容性，使用 .tar.gz 格式

// ========== 类型 ==========

export interface PackedSave {
  archivePath: string    // 临时 .tar.gz 文件路径
  size: number           // 文件大小
  sha1: string           // SHA1 校验和
  worldName: string
}

export interface SaveInfo {
  name: string           // 世界目录名
  path: string           // 完整路径
  size: number           // 近似大小 (字节)
  lastModified: number   // 最后修改时间戳
}

// ========== 工具 ==========

async function fileSHA1(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** 排除列表 — 不应打包的文件 */
const EXCLUDED_FILES = new Set([
  'session.lock',           // MC 运行时锁文件
  '.mixin.out',             // Mixin debug 输出
])

function shouldExclude(name: string): boolean {
  return EXCLUDED_FILES.has(name) || name.endsWith('.lock')
}

// ========== 简易 tar 实现 ==========
// 使用标准 tar (USTAR) 格式，只支持文件和目录，足够用于 MC 存档

function tarHeader(name: string, size: number, isDir: boolean): Buffer {
  const header = Buffer.alloc(512, 0)
  // name (最多 100 字节)
  const nameBytes = Buffer.from(name, 'utf-8')
  nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100))
  // mode
  writeOctal(header, 100, 8, isDir ? 0o755 : 0o644)
  // uid / gid
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  // size
  writeOctal(header, 124, 12, isDir ? 0 : size)
  // mtime
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000))
  // typeflag
  header[156] = isDir ? 53 : 48 // '5' for dir, '0' for file
  // magic
  Buffer.from('ustar\0', 'ascii').copy(header, 257)
  // version
  Buffer.from('00', 'ascii').copy(header, 263)
  // 计算 checksum
  // 先把 checksum 字段填空格
  for (let i = 148; i < 156; i++) header[i] = 32
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]
  writeOctal(header, 148, 7, sum)
  header[155] = 32 // 空格结尾
  return header
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number) {
  const str = value.toString(8).padStart(length - 1, '0')
  Buffer.from(str + '\0', 'ascii').copy(buf, offset)
}

/** 递归收集目录内所有文件 */
async function collectFiles(dir: string, prefix: string): Promise<{ relPath: string; fullPath: string; isDir: boolean; size: number }[]> {
  const results: { relPath: string; fullPath: string; isDir: boolean; size: number }[] = []
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (shouldExclude(entry.name)) continue
    const fullPath = path.join(dir, entry.name)
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      results.push({ relPath: relPath + '/', fullPath, isDir: true, size: 0 })
      results.push(...await collectFiles(fullPath, relPath))
    } else if (entry.isFile()) {
      const stat = await fsp.stat(fullPath)
      results.push({ relPath, fullPath, isDir: false, size: stat.size })
    }
  }
  return results
}

// ========== 打包 ==========

export async function packSave(worldDir: string): Promise<PackedSave> {
  const worldName = path.basename(worldDir)
  if (!fs.existsSync(worldDir)) {
    throw new Error(`存档目录不存在: ${worldDir}`)
  }

  // 收集文件
  const files = await collectFiles(worldDir, worldName)

  // 创建临时文件
  const tmpDir = path.join(path.dirname(worldDir), '.save-sync-tmp')
  await fsp.mkdir(tmpDir, { recursive: true })
  const archivePath = path.join(tmpDir, `${worldName}-${Date.now()}.tar.gz`)

  // 写 tar 流 → gzip → 文件
  const output = createWriteStream(archivePath)
  const gzip = zlib.createGzip({ level: 6 })
  gzip.pipe(output)

  for (const file of files) {
    const header = tarHeader(file.relPath, file.size, file.isDir)
    gzip.write(header)

    if (!file.isDir) {
      // 写文件内容
      const content = await fsp.readFile(file.fullPath)
      gzip.write(content)
      // 填充到 512 字节边界
      const remainder = content.length % 512
      if (remainder > 0) {
        gzip.write(Buffer.alloc(512 - remainder, 0))
      }
    }
  }

  // 写 tar 结束标记 (两个 512 字节零块)
  gzip.write(Buffer.alloc(1024, 0))

  await new Promise<void>((resolve, reject) => {
    gzip.end(() => {
      output.on('finish', resolve)
      output.on('error', reject)
    })
  })

  const stat = await fsp.stat(archivePath)
  const sha1 = await fileSHA1(archivePath)

  return { archivePath, size: stat.size, sha1, worldName }
}

// ========== 解包 ==========

export async function unpackSave(archivePath: string, targetDir: string, expectedSha1?: string): Promise<void> {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`存档文件不存在: ${archivePath}`)
  }

  // 校验 SHA1
  if (expectedSha1) {
    const sha1 = await fileSHA1(archivePath)
    if (sha1 !== expectedSha1) {
      throw new Error(`SHA1 校验失败: expected ${expectedSha1}, got ${sha1}`)
    }
  }

  // 解压到临时目录，然后移动
  const tmpExtract = targetDir + '.extracting'
  if (fs.existsSync(tmpExtract)) {
    await fsp.rm(tmpExtract, { recursive: true, force: true })
  }
  await fsp.mkdir(tmpExtract, { recursive: true })

  // 读取整个 tar.gz 到内存并解压
  const compressed = await fsp.readFile(archivePath)
  const tarData = await new Promise<Buffer>((resolve, reject) => {
    zlib.gunzip(compressed, (err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })

  // 解析 tar
  let offset = 0
  while (offset < tarData.length - 512) {
    const header = tarData.subarray(offset, offset + 512)
    offset += 512

    // 检查是否是结束标记 (全零)
    if (header.every(b => b === 0)) break

    // 解析文件名
    let nameEnd = 0
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++
    const name = header.subarray(0, nameEnd).toString('utf-8')

    // 解析大小
    let sizeStr = ''
    for (let i = 124; i < 136; i++) {
      if (header[i] === 0 || header[i] === 32) break
      sizeStr += String.fromCharCode(header[i])
    }
    const size = parseInt(sizeStr, 8) || 0

    // typeflag
    const typeFlag = header[156]

    // 安全检查：禁止路径遍历
    const safeName = name.replace(/\\/g, '/')
    if (safeName.includes('..') || path.isAbsolute(safeName)) {
      offset += Math.ceil(size / 512) * 512
      continue
    }

    const fullPath = path.join(tmpExtract, safeName)

    if (typeFlag === 53 || safeName.endsWith('/')) {
      // 目录
      await fsp.mkdir(fullPath, { recursive: true })
    } else {
      // 文件
      await fsp.mkdir(path.dirname(fullPath), { recursive: true })
      const content = tarData.subarray(offset, offset + size)
      await fsp.writeFile(fullPath, content)
      offset += Math.ceil(size / 512) * 512
    }
  }

  // 查找顶层目录（存档通常包在一层目录中）
  const topEntries = await fsp.readdir(tmpExtract)
  let sourceDir = tmpExtract
  if (topEntries.length === 1) {
    const single = path.join(tmpExtract, topEntries[0])
    const stat = await fsp.stat(single)
    if (stat.isDirectory()) {
      sourceDir = single
    }
  }

  // 移动到目标目录
  if (fs.existsSync(targetDir)) {
    await fsp.rm(targetDir, { recursive: true, force: true })
  }
  if (sourceDir === tmpExtract) {
    // 没有嵌套目录，直接重命名
    await fsp.rename(sourceDir, targetDir)
  } else {
    // sourceDir 是 tmpExtract 的子目录
    // Windows 上 rename 子目录到父目录外会 EPERM，改用 cp
    await fsp.cp(sourceDir, targetDir, { recursive: true })
    await fsp.rm(tmpExtract, { recursive: true, force: true }).catch(() => {})
  }
}

// ========== 存档信息 ==========

export async function getSaveInfo(worldDir: string): Promise<SaveInfo> {
  const name = path.basename(worldDir)
  const stat = await fsp.stat(worldDir)

  // 估算大小
  let totalSize = 0
  async function calcSize(dir: string) {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await calcSize(p)
      } else if (entry.isFile()) {
        const s = await fsp.stat(p)
        totalSize += s.size
      }
    }
  }
  await calcSize(worldDir)

  return {
    name,
    path: worldDir,
    size: totalSize,
    lastModified: stat.mtimeMs,
  }
}

/** 列出指定游戏目录下的所有存档 */
export async function listSaves(gameDir: string): Promise<SaveInfo[]> {
  const savesDir = path.join(gameDir, 'saves')
  if (!fs.existsSync(savesDir)) return []

  const entries = await fsp.readdir(savesDir, { withFileTypes: true })
  const saves: SaveInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const worldDir = path.join(savesDir, entry.name)
    // 检查是否有 level.dat (MC 世界的标志文件)
    if (fs.existsSync(path.join(worldDir, 'level.dat'))) {
      saves.push(await getSaveInfo(worldDir))
    }
  }
  return saves
}

/** 清理临时文件 */
export async function cleanupTempFiles(gameDir: string): Promise<void> {
  const tmpDir = path.join(gameDir, 'saves', '.save-sync-tmp')
  if (fs.existsSync(tmpDir)) {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  }
}

/** 读取打包好的存档文件为 Buffer（用于 WebRTC 传输） */
export async function readArchive(archivePath: string): Promise<Buffer> {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`存档文件不存在: ${archivePath}`)
  }
  return fsp.readFile(archivePath)
}

/** 从内存 Buffer 接收并解包存档（WebRTC 接收端用） */
export async function unpackSaveFromBuffer(
  data: Buffer,
  gameDir: string,
  worldName: string
): Promise<void> {
  const tmpDir = path.join(gameDir, '.save-sync-tmp')
  await fsp.mkdir(tmpDir, { recursive: true })
  const tmpPath = path.join(tmpDir, `${worldName}-${Date.now()}.tar.gz`)
  await fsp.writeFile(tmpPath, data)

  const targetDir = path.join(gameDir, 'saves', worldName)
  await unpackSave(tmpPath, targetDir)

  // 清理临时文件
  await fsp.unlink(tmpPath).catch(() => {})
}
