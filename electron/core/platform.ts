import { app } from 'electron'
import path from 'node:path'
import os from 'node:os'

/** 当前操作系统标识 (Mojang 版本 JSON 中的 os.name) */
export function getOSName(): 'windows' | 'osx' | 'linux' {
  switch (process.platform) {
    case 'win32': return 'windows'
    case 'darwin': return 'osx'
    default: return 'linux'
  }
}

/** 当前 CPU 架构 */
export function getArch(): string {
  return process.arch // "x64", "arm64" 等
}

/** 默认 .minecraft 目录 */
export function getDefaultMinecraftDir(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(app.getPath('appData'), '.minecraft')
    case 'darwin':
      return path.join(app.getPath('home'), 'Library', 'Application Support', 'minecraft')
    default:
      return path.join(app.getPath('home'), '.minecraft')
  }
}

/** 启动器数据存储目录 */
export function getLauncherDir(): string {
  return path.join(app.getPath('userData'))
}

/** natives 子目录名 (classpath 提取目标) */
export function getNativesClassifier(): string {
  const osName = getOSName()
  const arch = getArch()
  if (osName === 'windows') return `natives-windows${arch === 'arm64' ? '-arm64' : ''}`
  if (osName === 'osx') return `natives-macos${arch === 'arm64' ? '-arm64' : ''}`
  return `natives-linux${arch === 'arm64' ? '-arm64' : ''}`
}

/** 系统总物理内存 (MB) */
export function getTotalMemoryMB(): number {
  return Math.floor(os.totalmem() / 1024 / 1024)
}

/** 将 Maven 坐标转为相对路径, 如 "net.sf.jopt-simple:jopt-simple:5.0.4" → "net/sf/jopt-simple/jopt-simple/5.0.4/jopt-simple-5.0.4.jar" */
export function mavenToPath(coordinate: string): string {
  const parts = coordinate.split(':')
  const group = parts[0].replace(/\./g, '/')
  const artifact = parts[1]
  const version = parts[2]
  const classifier = parts[3]
  const ext = parts[4] || 'jar'
  const fileName = classifier
    ? `${artifact}-${version}-${classifier}.${ext}`
    : `${artifact}-${version}.${ext}`
  return `${group}/${artifact}/${version}/${fileName}`
}

/** Java 可执行文件名 */
export function getJavaExecutable(): string {
  return process.platform === 'win32' ? 'javaw.exe' : 'java'
}

/** 拼接 classpath 分隔符 */
export function getClasspathSeparator(): string {
  return process.platform === 'win32' ? ';' : ':'
}
