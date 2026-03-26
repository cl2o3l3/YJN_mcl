import { spawn, ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { GameProfile, MinecraftAccount, VersionJson, ArgumentRule } from '../../src/types'
import { GC_PRESETS } from '../../src/types'
import { ensureAuthlibInjector, getPrefetchedYggdrasilMetadata } from './authlib-injector'
import { getOSName, getArch, getClasspathSeparator } from './platform'
import { buildClasspath } from './library-manager'
import { getVersionPaths } from './version-manager'

/** 构建完整的 JVM 参数列表 */
function buildJvmArgs(profile: GameProfile, versionJson: VersionJson, vars: Record<string, string>): string[] {
  const args: string[] = []

  // 内存
  args.push(`-Xmx${profile.jvmArgs.maxMemory}m`)
  args.push(`-Xms${profile.jvmArgs.minMemory}m`)

  // GC
  if (profile.jvmArgs.gcType !== 'custom') {
    const preset = GC_PRESETS[profile.jvmArgs.gcType]
    if (preset) args.push(...preset)
  }
  args.push(...profile.jvmArgs.gcArgs.filter(a => !args.includes(a)))

  // 额外 JVM 参数
  args.push(...profile.jvmArgs.extraArgs)

  // 版本 JSON 中的 JVM 参数
  if (versionJson.arguments?.jvm) {
    for (const arg of versionJson.arguments.jvm) {
      if (typeof arg === 'string') {
        args.push(replaceVars(arg, vars))
      } else {
        const resolved = resolveArgumentRule(arg, vars)
        if (resolved) args.push(...resolved)
      }
    }
  } else {
    // 旧版默认 JVM 参数
    args.push(`-Djava.library.path=${vars.natives_directory}`)
    args.push('-cp', vars.classpath)
  }

  return args
}

/** 构建游戏参数列表 */
function buildGameArgs(versionJson: VersionJson, vars: Record<string, string>): string[] {
  const args: string[] = []

  if (versionJson.arguments?.game) {
    for (const arg of versionJson.arguments.game) {
      if (typeof arg === 'string') {
        args.push(replaceVars(arg, vars))
      } else {
        const resolved = resolveArgumentRule(arg, vars)
        if (resolved) args.push(...resolved)
      }
    }
  } else if (versionJson.minecraftArguments) {
    // 旧版格式
    const parts = versionJson.minecraftArguments.split(' ')
    for (const part of parts) {
      args.push(replaceVars(part, vars))
    }
  }

  return args
}

/** 解析条件参数 */
function resolveArgumentRule(rule: ArgumentRule, vars: Record<string, string>): string[] | null {
  for (const r of rule.rules) {
    if (r.os) {
      if (r.os.name && r.os.name !== getOSName()) {
        return r.action === 'allow' ? null : null
      }
      if (r.os.arch && r.os.arch !== getArch()) {
        return r.action === 'allow' ? null : null
      }
    }
    // features 部分一般不需要处理 (demo 模式等)
    if (r.features) return null
  }

  const values = Array.isArray(rule.value) ? rule.value : [rule.value]
  return values.map(v => replaceVars(v, vars))
}

/** 变量替换 */
function replaceVars(str: string, vars: Record<string, string>): string {
  return str.replace(/\$\{([^}]+)\}/g, (_, key) => vars[key] ?? '')
}

/** 启动 Minecraft */
export async function launchGame(
  profile: GameProfile,
  versionJson: VersionJson,
  account: MinecraftAccount,
  gameDir: string
): Promise<ChildProcess> {
  const librariesDir = path.join(gameDir, 'libraries')
  const assetsDir = path.join(gameDir, 'assets')
  const nativesDir = getVersionPaths(gameDir, versionJson.id).nativesDir
  const classpath = buildClasspath(versionJson, librariesDir, gameDir)

  const vars: Record<string, string> = {
    // 认证
    auth_player_name: account.username,
    auth_uuid: account.uuid.replace(/-/g, ''),
    auth_access_token: account.accessToken || '0',
    auth_xuid: account.xuid || '',
    user_type: account.type === 'microsoft' ? 'msa' : account.type === 'yggdrasil' ? 'mojang' : 'legacy',
    user_properties: '{}',

    // 版本
    version_name: versionJson.id,
    version_type: versionJson.type,
    game_directory: profile.gameDir,

    // 路径
    natives_directory: nativesDir,
    classpath,
    classpath_separator: getClasspathSeparator(),
    library_directory: librariesDir,

    // 资源
    assets_root: assetsDir,
    assets_index_name: versionJson.assets || versionJson.assetIndex?.id || '',
    game_assets: assetsDir,

    // 窗口
    resolution_width: String(profile.windowWidth),
    resolution_height: String(profile.windowHeight),

    // 启动器
    launcher_name: 'mc-launcher',
    launcher_version: '1.0.0'
  }

  const jvmArgs = buildJvmArgs(profile, versionJson, vars)

  if (account.type === 'yggdrasil' && account.yggdrasilServer) {
    const injectorJar = await ensureAuthlibInjector()
    const prefetched = await getPrefetchedYggdrasilMetadata(account.yggdrasilServer)
    jvmArgs.unshift(
      '-Dauthlibinjector.noShowServerName',
      `-javaagent:${injectorJar}=${account.yggdrasilServer}`
    )
    if (prefetched) {
      jvmArgs.unshift(`-Dauthlibinjector.yggdrasil.prefetched=${prefetched}`)
    }
  }

  const gameArgs = buildGameArgs(versionJson, vars)

  const finalArgs = [
    ...jvmArgs,
    versionJson.mainClass,
    ...gameArgs
  ]

  const javaPath = profile.javaPath || 'java'

  const child = spawn(javaPath, finalArgs, {
    cwd: profile.gameDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  return child
}
