/**
 * Yggdrasil 第三方认证 API 客户端
 * 遵循 authlib-injector Yggdrasil 服务端技术规范
 * https://github.com/yushijinhun/authlib-injector/wiki/Yggdrasil-服务端技术规范
 */

import { net } from 'electron'
import type { YggdrasilServerInfo, YggdrasilAuthResponse, YggdrasilProfile } from '../../../src/types'

/** 确保 API Root URL 以 / 结尾 */
function normalizeApiRoot(url: string): string {
  return url.endsWith('/') ? url : url + '/'
}

/** Yggdrasil 错误结构 */
interface YggdrasilError {
  error: string
  errorMessage: string
  cause?: string
}

/** 通用 fetch 封装 */
async function yggdrasilFetch(url: string, options?: RequestInit): Promise<Response> {
  return net.fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(options?.headers as Record<string, string>)
    }
  })
}

/**
 * 获取 Yggdrasil 服务器元数据
 * GET {apiRoot}
 */
export async function getServerInfo(apiRoot: string): Promise<YggdrasilServerInfo> {
  const root = normalizeApiRoot(apiRoot)
  const resp = await yggdrasilFetch(root)
  if (!resp.ok) {
    throw new Error(`无法连接到认证服务器: HTTP ${resp.status}`)
  }
  const data = await resp.json()
  const meta = data.meta || {}
  return {
    url: root,
    name: meta.serverName || meta.implementationName || new URL(root).hostname,
    homepage: meta.links?.homepage,
    register: meta.links?.register,
    nonEmailLogin: meta['feature.non_email_login'] === true
  }
}

/**
 * 通过 ALI (API Location Indication) 自动发现 API Root
 * 请求用户输入的 URL, 检查 X-Authlib-Injector-API-Location 响应头
 */
export async function resolveApiRoot(inputUrl: string): Promise<string> {
  // 如果没有协议, 加上 https://
  let url = inputUrl.trim()
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url
  }

  // 先尝试直接作为 API Root (GET / 看是否返回有效的 Yggdrasil 元数据)
  try {
    const root = normalizeApiRoot(url)
    const resp = await yggdrasilFetch(root)
    const data = await resp.json()
    if (data.meta || data.skinDomains || data.signaturePublickey) {
      return root
    }
  } catch { /* 不是直接的 API Root, 继续尝试 ALI */ }

  // 通过 ALI 响应头发现
  try {
    const resp = await yggdrasilFetch(url, { method: 'GET' })
    const ali = resp.headers.get('x-authlib-injector-api-location')
    if (ali) {
      // ALI 可以是相对 URL 或绝对 URL
      const resolved = new URL(ali, url).href
      return normalizeApiRoot(resolved)
    }
  } catch {
    throw new Error('无法连接到该地址，请检查 URL 是否正确')
  }

  throw new Error('未找到有效的 Yggdrasil API，请输入正确的认证服务器地址')
}

/**
 * 登录 (用户名/密码 → accessToken)
 * POST {apiRoot}/authserver/authenticate
 */
export async function authenticate(
  apiRoot: string,
  username: string,
  password: string,
  clientToken?: string
): Promise<YggdrasilAuthResponse> {
  const root = normalizeApiRoot(apiRoot)
  const body: Record<string, unknown> = {
    username,
    password,
    requestUser: false,
    agent: { name: 'Minecraft', version: 1 }
  }
  if (clientToken) {
    body.clientToken = clientToken
  }

  const resp = await yggdrasilFetch(root + 'authserver/authenticate', {
    method: 'POST',
    body: JSON.stringify(body)
  })

  if (!resp.ok) {
    const err: YggdrasilError = await resp.json().catch(() => ({
      error: 'Unknown',
      errorMessage: `HTTP ${resp.status}`
    }))
    if (err.errorMessage?.includes('Invalid credentials')) {
      throw new Error('用户名或密码错误')
    }
    throw new Error(err.errorMessage || `登录失败: ${err.error}`)
  }

  return resp.json()
}

/**
 * 刷新令牌
 * POST {apiRoot}/authserver/refresh
 */
export async function refreshToken(
  apiRoot: string,
  accessToken: string,
  clientToken?: string
): Promise<YggdrasilAuthResponse> {
  const root = normalizeApiRoot(apiRoot)
  const body: Record<string, unknown> = {
    accessToken,
    requestUser: false
  }
  if (clientToken) {
    body.clientToken = clientToken
  }

  const resp = await yggdrasilFetch(root + 'authserver/refresh', {
    method: 'POST',
    body: JSON.stringify(body)
  })

  if (!resp.ok) {
    const err: YggdrasilError = await resp.json().catch(() => ({
      error: 'Unknown',
      errorMessage: `HTTP ${resp.status}`
    }))
    throw new Error(err.errorMessage || `令牌刷新失败: ${err.error}`)
  }

  return resp.json()
}

/**
 * 验证令牌是否有效
 * POST {apiRoot}/authserver/validate
 * 返回 true 表示有效, false 表示无效
 */
export async function validateToken(
  apiRoot: string,
  accessToken: string,
  clientToken?: string
): Promise<boolean> {
  const root = normalizeApiRoot(apiRoot)
  const body: Record<string, unknown> = { accessToken }
  if (clientToken) {
    body.clientToken = clientToken
  }

  try {
    const resp = await yggdrasilFetch(root + 'authserver/validate', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    return resp.status === 204
  } catch {
    return false
  }
}

/**
 * 吊销令牌
 * POST {apiRoot}/authserver/invalidate
 */
export async function invalidateToken(
  apiRoot: string,
  accessToken: string,
  clientToken?: string
): Promise<void> {
  const root = normalizeApiRoot(apiRoot)
  const body: Record<string, unknown> = { accessToken }
  if (clientToken) {
    body.clientToken = clientToken
  }

  await yggdrasilFetch(root + 'authserver/invalidate', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

/**
 * 将无符号 UUID 转换为标准 UUID 格式 (带 -)
 */
function formatUUID(raw: string): string {
  if (raw.includes('-')) return raw
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

/**
 * 完整的 Yggdrasil 登录流程: 输入 → authenticate → MinecraftAccount
 */
export async function fullYggdrasilLogin(
  apiRoot: string,
  username: string,
  password: string
): Promise<{ account: import('../../../src/types').MinecraftAccount; profiles: YggdrasilProfile[] }> {
  const result = await authenticate(apiRoot, username, password)

  // 选择角色: 优先 selectedProfile, 否则取第一个
  const profile = result.selectedProfile || result.availableProfiles?.[0]
  if (!profile) {
    throw new Error('该账号下没有可用角色，请先在皮肤站创建角色')
  }

  const uuid = formatUUID(profile.id)

  const account: import('../../../src/types').MinecraftAccount = {
    id: `ygg_${profile.id}`,
    type: 'yggdrasil',
    username: profile.name,
    uuid,
    accessToken: result.accessToken,
    yggdrasilServer: normalizeApiRoot(apiRoot),
    yggdrasilClientToken: result.clientToken
  }

  return { account, profiles: result.availableProfiles || [] }
}

/** 预设第三方认证服务器列表 */
export const PRESET_SERVERS = [
  {
    name: 'LittleSkin',
    url: 'https://littleskin.cn/api/yggdrasil',
    homepage: 'https://littleskin.cn',
    register: 'https://littleskin.cn/auth/register'
  }
]
