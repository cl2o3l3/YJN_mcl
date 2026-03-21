import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import type { VersionJson, DownloadTask } from '../../src/types'
import { mirrorAssetUrl, mirrorVersionJsonUrl } from './mirror-manager'
import { downloadFile } from './download'

interface AssetIndexData {
  objects: Record<string, { hash: string; size: number }>
}

/** 下载 asset index JSON 并收集所有资源下载任务 */
export async function collectAssetTasks(
  versionJson: VersionJson,
  gameDir: string
): Promise<DownloadTask[]> {
  const assetIndex = versionJson.assetIndex
  if (!assetIndex) return []

  const assetsDir = path.join(gameDir, 'assets')
  const indexDir = path.join(assetsDir, 'indexes')
  const objectsDir = path.join(assetsDir, 'objects')
  const indexPath = path.join(indexDir, `${assetIndex.id}.json`)

  // 下载 asset index JSON
  if (!fs.existsSync(indexPath)) {
    const url = mirrorVersionJsonUrl(assetIndex.url)
    await downloadFile(url, indexPath, assetIndex.sha1)
  }

  const indexData: AssetIndexData = JSON.parse(await fsp.readFile(indexPath, 'utf-8'))
  const tasks: DownloadTask[] = []

  for (const [, asset] of Object.entries(indexData.objects)) {
    const prefix = asset.hash.substring(0, 2)
    const destPath = path.join(objectsDir, prefix, asset.hash)
    if (fs.existsSync(destPath)) continue
    tasks.push({
      url: mirrorAssetUrl(asset.hash),
      path: destPath,
      sha1: asset.hash,
      size: asset.size,
      fallbackUrls: [`https://resources.download.minecraft.net/${prefix}/${asset.hash}`]
    })
  }

  return tasks
}
