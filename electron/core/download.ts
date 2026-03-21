import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import https from 'node:https'
import http from 'node:http'
import { net } from 'electron'
import type { DownloadTask, DownloadProgress } from '../../src/types'

/** 计算文件 SHA1 */
export async function fileSHA1(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** 原生 Node.js 流式下载 — 自动跟随重定向，全程超时保护 */
function nativeDownload(
  url: string,
  destPath: string,
  timeoutMs = 300_000,
  maxRedirects = 5
): Promise<number> {
  return new Promise((resolve, reject) => {
    let redirectCount = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    function cleanup() {
      if (timer) { clearTimeout(timer); timer = undefined }
    }

    function doRequest(reqUrl: string) {
      const mod = reqUrl.startsWith('https') ? https : http
      const req = mod.get(reqUrl, { timeout: 30_000 }, (res) => {
        // 手动跟随 3xx 重定向
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (++redirectCount > maxRedirects) {
            cleanup()
            return reject(new Error(`Too many redirects: ${url}`))
          }
          doRequest(res.headers.location)
          return
        }

        if (!res.statusCode || res.statusCode >= 400) {
          res.resume()
          cleanup()
          return reject(new Error(`Download failed: ${res.statusCode} ${url}`))
        }

        const ws = fs.createWriteStream(destPath)
        let bytes = 0

        res.on('data', (chunk: Buffer) => { bytes += chunk.length })
        res.pipe(ws)

        ws.on('finish', () => { cleanup(); resolve(bytes) })
        ws.on('error', (e) => { cleanup(); reject(e) })
        res.on('error', (e) => { ws.destroy(); cleanup(); reject(e) })
      })

      req.on('error', (e) => { cleanup(); reject(e) })
      req.on('timeout', () => { req.destroy(); cleanup(); reject(new Error(`Connection timeout: ${url}`)) })
    }

    // 全局超时 (整个下载过程)
    timer = setTimeout(() => {
      timer = undefined
      reject(new Error(`Download timeout (${Math.round(timeoutMs / 1000)}s): ${url}`))
    }, timeoutMs)

    doRequest(url)
  })
}

/** 单文件下载 (流式 + SHA1 校验 + 超时 + 重试) */
export async function downloadFile(
  url: string,
  destPath: string,
  sha1?: string
): Promise<number> {
  // 如果文件已存在, 根据 SHA1 决定是否跳过
  if (fs.existsSync(destPath)) {
    const stat = fs.statSync(destPath)
    if (stat.size > 0) {
      if (sha1) {
        const existing = await fileSHA1(destPath)
        if (existing === sha1) return stat.size
      } else {
        return stat.size
      }
    }
  }

  await fsp.mkdir(path.dirname(destPath), { recursive: true })

  const tmpPath = destPath + '.tmp'
  const bytes = await nativeDownload(url, tmpPath)

  // SHA1 校验
  if (sha1) {
    const hash = await fileSHA1(tmpPath)
    if (hash !== sha1) {
      await fsp.unlink(tmpPath).catch(() => {})
      throw new Error(`SHA1 mismatch for ${url}: expected ${sha1}, got ${hash}`)
    }
  }

  await fsp.rename(tmpPath, destPath)
  return bytes
}

/** JSON GET 请求 */
export async function fetchJson<T>(url: string): Promise<T> {
  const response = await net.fetch(url)
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${url}`)
  }
  return response.json() as Promise<T>
}

/** JSON GET 请求 (带 Authorization) */
export async function fetchJsonAuth<T>(url: string, token: string): Promise<T> {
  const response = await net.fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${url}`)
  }
  return response.json() as Promise<T>
}

/** POST x-www-form-urlencoded (用于 MS OAuth) */
export async function postForm<T = unknown>(url: string, params: Record<string, string>): Promise<T> {
  const body = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const response = await net.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await response.json()
  if (!response.ok) {
    const err = data as { error?: string; error_description?: string }
    throw Object.assign(new Error(err.error_description || `POST failed: ${response.status}`), { errorCode: err.error })
  }
  return data as T
}

/** POST JSON (用于 Xbox/XSTS/MC) */
export async function postJson<T = unknown>(url: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  const response = await net.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`POST JSON failed: ${response.status} ${url} — ${text}`)
  }
  return response.json() as Promise<T>
}

/** 带重试的单文件下载 (支持 fallback URL) */
async function downloadWithRetry(
  task: DownloadTask,
  maxRetries = 3
): Promise<number> {
  const urls = [task.url, ...(task.fallbackUrls || [])]
  let lastErr: Error | undefined

  for (const url of urls) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await downloadFile(url, task.path, task.sha1)
      } catch (e) {
        lastErr = e as Error
        // HTTP 4xx 错误为永久性失败, 跳过重试直接尝试下一个 URL
        if (/Download failed: 4\d\d/.test(lastErr.message)) break
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)))
        }
      }
    }
  }
  throw lastErr!
}

/** 批量并发下载 */
export async function downloadBatch(
  tasks: DownloadTask[],
  concurrency: number,
  onProgress?: (progress: DownloadProgress) => void
): Promise<{ success: number; failed: string[] }> {
  // 自动根据任务量提升并发: 小文件多时用更高并发
  const effectiveConcurrency = tasks.length > 500 ? Math.max(concurrency, 32)
    : tasks.length > 100 ? Math.max(concurrency, 16)
    : concurrency

  const progress: DownloadProgress = {
    total: tasks.length,
    completed: 0,
    failed: 0,
    speed: 0
  }
  const failed: string[] = []
  let activeCount = 0
  let index = 0
  let totalBytes = 0
  const startTime = Date.now()

  // 节流进度回调 (最多每 200ms 发一次)
  let lastProgressTime = 0
  function emitProgress(file?: string) {
    const now = Date.now()
    if (file) progress.currentFile = file
    const elapsed = (now - startTime) / 1000
    progress.speed = elapsed > 0 ? totalBytes / elapsed : 0
    if (now - lastProgressTime > 200 || progress.completed + progress.failed === tasks.length) {
      lastProgressTime = now
      onProgress?.(Object.assign({}, progress))
    }
  }

  return new Promise(resolve => {
    function next() {
      while (activeCount < effectiveConcurrency && index < tasks.length) {
        const task = tasks[index++]
        activeCount++
        emitProgress(path.basename(task.path))

        downloadWithRetry(task)
          .then((bytes) => {
            progress.completed++
            totalBytes += bytes
          })
          .catch((err) => {
            progress.failed++
            failed.push(task.url || task.fallbackUrls?.[0] || path.basename(task.path))
            console.warn(`[download] failed: ${path.basename(task.path)}`, err.message)
          })
          .finally(() => {
            activeCount--
            emitProgress()

            if (progress.completed + progress.failed === tasks.length) {
              resolve({ success: progress.completed, failed })
            } else {
              next()
            }
          })
      }
    }
    if (tasks.length === 0) {
      resolve({ success: 0, failed: [] })
    } else {
      next()
    }
  })
}
