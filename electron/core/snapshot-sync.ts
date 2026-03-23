import * as fsp from 'node:fs/promises'

function normalizeHttpUrl(url: string): string {
  return url
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/$/, '')
}

function resolveSnapshotUrl(serverUrl: string, requestPath: string): string {
  if (/^https?:\/\//.test(requestPath)) return requestPath
  const base = normalizeHttpUrl(serverUrl)
  return requestPath.startsWith('/') ? `${base}${requestPath}` : `${base}/${requestPath}`
}

export async function uploadSnapshotArchive(serverUrl: string, uploadPath: string, archivePath: string): Promise<void> {
  const buffer = await fsp.readFile(archivePath)
  const response = await fetch(resolveSnapshotUrl(serverUrl, uploadPath), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(buffer.byteLength),
    },
    body: buffer,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  })

  if (!response.ok) {
    throw new Error(`快照上传失败: ${response.status} ${response.statusText}`)
  }
}

export async function downloadSnapshotBuffer(serverUrl: string, downloadPath: string): Promise<Buffer> {
  const response = await fetch(resolveSnapshotUrl(serverUrl, downloadPath), {
    method: 'GET',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  })

  if (!response.ok) {
    throw new Error(`快照下载失败: ${response.status} ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}