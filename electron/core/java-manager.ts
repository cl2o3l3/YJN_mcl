import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { JavaInstallation } from '../../src/types'
import { getJavaExecutable } from './platform'
import { getInstalledRuntimes } from './java-downloader'
import { loadSettings } from './settings-store'

const execFileAsync = promisify(execFile)

/** 解析 java -version 输出 */
async function probeJava(javaPath: string): Promise<JavaInstallation | null> {
  try {
    const { stderr } = await execFileAsync(javaPath, ['-version'], { timeout: 10000 })
    const output = stderr || ''

    // java version "17.0.8" 或 openjdk version "21.0.1"
    const versionMatch = output.match(/version "(\d+)(?:\.(\d+)(?:\.(\d+))?)?/)
    if (!versionMatch) return null

    const major = parseInt(versionMatch[1])
    const version = versionMatch[0].replace('version ', '').replace(/"/g, '')

    // 64-Bit / aarch64
    const is64 = output.includes('64-Bit') || output.includes('aarch64')
    const arch = output.includes('aarch64') ? 'aarch64' : (is64 ? 'x64' : 'x86')

    // vendor
    let vendor: string | undefined
    if (output.includes('Eclipse Adoptium') || output.includes('Temurin')) vendor = 'Eclipse Adoptium'
    else if (output.includes('GraalVM')) vendor = 'GraalVM'
    else if (output.includes('Zulu')) vendor = 'Azul Zulu'
    else if (output.includes('OpenJDK')) vendor = 'OpenJDK'
    else if (output.includes('Java(TM)')) vendor = 'Oracle'

    return { path: javaPath, version, majorVersion: major, arch, vendor, isManual: false }
  } catch {
    return null
  }
}

/** 在常见路径扫描 Java */
export async function scanSystemJava(): Promise<JavaInstallation[]> {
  const candidates: string[] = []
  const javaExe = getJavaExecutable()
  const settings = loadSettings()

  if (settings.defaultJavaPath) {
    candidates.push(settings.defaultJavaPath)
  }
  for (const javaPath of settings.manualJavaPaths || []) {
    candidates.push(javaPath)
  }

  // JAVA_HOME
  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, 'bin', javaExe))
  }

  // PATH 中的 java
  const pathDirs = (process.env.PATH || '').split(path.delimiter)
  for (const dir of pathDirs) {
    const p = path.join(dir, javaExe)
    if (fs.existsSync(p)) candidates.push(p)
  }

  if (process.platform === 'win32') {
    // Windows 常见 Java 安装位置
    const programFiles = [
      process.env['ProgramFiles'] || 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      process.env['LOCALAPPDATA'] || ''
    ]
    const jdkDirs = [
      'Java', 'Eclipse Adoptium', 'Zulu', 'Microsoft',
      'BellSoft', 'GraalVM', 'Amazon Corretto', 'Semeru',
      'SapMachine', 'RedHat', 'Liberica'
    ]

    for (const pf of programFiles) {
      if (!pf) continue
      for (const jdkDir of jdkDirs) {
        const base = path.join(pf, jdkDir)
        if (!fs.existsSync(base)) continue
        try {
          const entries = await fsp.readdir(base, { withFileTypes: true })
          for (const e of entries) {
            if (e.isDirectory()) {
              candidates.push(path.join(base, e.name, 'bin', javaExe))
            }
          }
        } catch { /* 无权限 */ }
      }
    }

    // Oracle 新版 JDK 安装到 Program Files/Java 下但也可能在 javapath
    const commonJavaPath = 'C:\\Program Files\\Common Files\\Oracle\\Java\\javapath'
    if (fs.existsSync(commonJavaPath)) {
      candidates.push(path.join(commonJavaPath, javaExe))
    }

    // 用户目录下的 JDK (.jdks 是 IntelliJ 自动下载的位置)
    const userHome = process.env['USERPROFILE'] || ''
    if (userHome) {
      const userJdkDirs = [
        path.join(userHome, '.jdks'),
        path.join(userHome, 'scoop', 'apps'),
      ]
      for (const base of userJdkDirs) {
        if (!fs.existsSync(base)) continue
        try {
          const entries = await fsp.readdir(base, { withFileTypes: true })
          for (const e of entries) {
            if (e.isDirectory()) {
              // .jdks 下直接是 jdk-21.0.1/ 目录
              candidates.push(path.join(base, e.name, 'bin', javaExe))
              // scoop 下是 openjdk21/current/bin/
              candidates.push(path.join(base, e.name, 'current', 'bin', javaExe))
            }
          }
        } catch { /* 无权限 */ }
      }
    }

    // 注册表辅助：通过 reg query 查找 JavaHome
    try {
      const regKeys = [
        'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
        'HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
        'HKLM\\SOFTWARE\\JavaSoft\\JDK',
      ]
      for (const key of regKeys) {
        try {
          const { stdout } = await execFileAsync('reg', ['query', key, '/s', '/v', 'JavaHome'], { timeout: 5000 })
          const matches = stdout.matchAll(/JavaHome\s+REG_SZ\s+(.+)/gi)
          for (const m of matches) {
            const jHome = m[1].trim()
            if (jHome) candidates.push(path.join(jHome, 'bin', javaExe))
          }
        } catch { /* 该注册表项不存在 */ }
      }
    } catch { /* reg 命令不可用 */ }
  }

  try {
    const installedRuntimes = await getInstalledRuntimes()
    for (const runtime of installedRuntimes) {
      candidates.push(runtime.javaPath)
    }
  } catch { /* ignore */ }

  // 去重 + 验证
  const seen = new Set<string>()
  const results: JavaInstallation[] = []

  for (const candidate of candidates) {
    const normalized = path.resolve(candidate)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    if (!fs.existsSync(normalized)) continue

    const info = await probeJava(normalized)
    if (info) results.push(info)
  }

  // 按版本号降序
  results.sort((a, b) => b.majorVersion - a.majorVersion)
  return results
}

/** 验证单个手动添加的 Java 路径 */
export async function validateJavaPath(javaPath: string): Promise<JavaInstallation | null> {
  const info = await probeJava(javaPath)
  if (info) info.isManual = true
  return info
}

/** 根据 MC 版本要求选择合适的 Java */
export function selectJava(
  installations: JavaInstallation[],
  requiredMajor: number
): JavaInstallation | undefined {
  // 精确匹配优先
  const exact = installations.find(j => j.majorVersion === requiredMajor)
  if (exact) return exact
  // 次选: 比要求的版本高的最低版本
  const higher = installations
    .filter(j => j.majorVersion >= requiredMajor)
    .sort((a, b) => a.majorVersion - b.majorVersion)
  return higher[0]
}
