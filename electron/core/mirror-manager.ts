import type { MirrorSource } from '../../src/types'
import { loadSettings, saveSettings } from './settings-store'

const MIRRORS: Record<MirrorSource, {
  versionManifest: string
  libraries: string
  assets: string
  client: string
}> = {
  official: {
    versionManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    libraries: 'https://libraries.minecraft.net',
    assets: 'https://resources.download.minecraft.net',
    client: 'https://piston-data.mojang.com'
  },
  bmclapi: {
    versionManifest: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
    libraries: 'https://bmclapi2.bangbang93.com/maven',
    assets: 'https://bmclapi2.bangbang93.com/assets',
    client: 'https://bmclapi2.bangbang93.com'
  },
  tsinghua: {
    versionManifest: 'https://mirrors.tuna.tsinghua.edu.cn/minecraft/version_manifest_v2.json',
    libraries: 'https://mirrors.tuna.tsinghua.edu.cn/minecraft/libraries',
    assets: 'https://mirrors.tuna.tsinghua.edu.cn/minecraft/assets',
    client: 'https://mirrors.tuna.tsinghua.edu.cn/minecraft'
  }
}

let currentSource: MirrorSource = loadSettings().mirrorSource

export function setMirrorSource(source: MirrorSource) {
  currentSource = source
  saveSettings({ mirrorSource: source })
}

export function getMirrorSource(): MirrorSource {
  return currentSource
}

export function getVersionManifestUrl(): string {
  return MIRRORS[currentSource].versionManifest
}

/** 将官方 library URL 替换为镜像 URL */
export function mirrorLibraryUrl(originalUrl: string): string {
  if (currentSource === 'official') return originalUrl
  const mirror = MIRRORS[currentSource]
  return originalUrl
    .replace('https://libraries.minecraft.net', mirror.libraries)
    .replace('https://maven.minecraftforge.net', mirror.libraries)
    .replace('https://maven.fabricmc.net', mirror.libraries)
    .replace('https://maven.quiltmc.org/repository/release', mirror.libraries)
    .replace('https://maven.neoforged.net/releases', mirror.libraries)
}

/** 将官方 asset URL 替换为镜像 URL */
export function mirrorAssetUrl(hash: string): string {
  const prefix = hash.substring(0, 2)
  return `${MIRRORS[currentSource].assets}/${prefix}/${hash}`
}

/** 将官方客户端下载 URL 替换为镜像 URL */
export function mirrorClientUrl(originalUrl: string): string {
  if (currentSource === 'official') return originalUrl
  const mirror = MIRRORS[currentSource]
  return originalUrl
    .replace('https://piston-data.mojang.com', mirror.client)
    .replace('https://launcher.mojang.com', mirror.client)
}

/** 替换版本 JSON 中的 URL (版本详情页面) */
export function mirrorVersionJsonUrl(originalUrl: string): string {
  if (currentSource === 'official') return originalUrl
  // BMCLAPI 直接代理 piston-meta
  if (currentSource === 'bmclapi') {
    return originalUrl.replace('https://piston-meta.mojang.com', 'https://bmclapi2.bangbang93.com')
      .replace('https://launchermeta.mojang.com', 'https://bmclapi2.bangbang93.com')
  }
  return originalUrl
}
