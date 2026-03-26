import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { net } from 'electron'
import { downloadFile } from './download'
import { getLauncherDir } from './platform'

const AUTHLIB_INJECTOR_VERSION = '1.2.7'
const AUTHLIB_INJECTOR_BUILD = '55'
const AUTHLIB_INJECTOR_SHA256 = 'eaf14bc5acffc7d885bd5bd5942b99f36d6299302beae356b2fc5807fe42652b'
const AUTHLIB_INJECTOR_FILE = `authlib-injector-${AUTHLIB_INJECTOR_VERSION}.jar`
const AUTHLIB_INJECTOR_URL = `https://authlib-injector.yushi.moe/artifact/${AUTHLIB_INJECTOR_BUILD}/${AUTHLIB_INJECTOR_FILE}`

async function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

export async function ensureAuthlibInjector(): Promise<string> {
  const dir = path.join(getLauncherDir(), 'authlib-injector')
  const jarPath = path.join(dir, AUTHLIB_INJECTOR_FILE)

  if (fs.existsSync(jarPath)) {
    const currentHash = await fileSha256(jarPath)
    if (currentHash === AUTHLIB_INJECTOR_SHA256) {
      return jarPath
    }
    fs.rmSync(jarPath, { force: true })
  }

  await downloadFile(AUTHLIB_INJECTOR_URL, jarPath)

  const downloadedHash = await fileSha256(jarPath)
  if (downloadedHash !== AUTHLIB_INJECTOR_SHA256) {
    fs.rmSync(jarPath, { force: true })
    throw new Error(`authlib-injector 校验失败: expected ${AUTHLIB_INJECTOR_SHA256}, got ${downloadedHash}`)
  }

  return jarPath
}

export async function getPrefetchedYggdrasilMetadata(apiRoot: string): Promise<string | null> {
  try {
    const response = await net.fetch(apiRoot)
    if (!response.ok) return null
    const text = await response.text()
    return Buffer.from(text, 'utf8').toString('base64')
  } catch {
    return null
  }
}