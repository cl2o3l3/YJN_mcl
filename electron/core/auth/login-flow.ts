/**
 * 完整微软登录链路编排:
 * Device Code → MS Token → Xbox Live → XSTS → MC Token → MC Profile
 *
 * 以及 Token 刷新: refresh_token → MS Token → Xbox → XSTS → MC Token
 */

import { requestDeviceCode, pollForMsToken, refreshMsToken } from './microsoft'
import { authenticateXbox, authenticateXSTS, authenticateMinecraft, getMinecraftProfile } from './xbox'
import { saveAccount, getAllAccounts, getClientId } from './account-store'
import { validateToken, refreshToken as yggdrasilRefresh } from './yggdrasil'
import type { MinecraftAccount, AuthProgressEvent } from '../../../src/types'

/**
 * 完整 Device Code 登录流程
 * @param onProgress 进度回调，推送到渲染进程
 * @param signal AbortSignal 用于取消
 * @returns MinecraftAccount
 */
export async function fullMicrosoftLogin(
  onProgress: (event: AuthProgressEvent) => void,
  signal?: AbortSignal
): Promise<MinecraftAccount> {
  const clientId = getClientId()

  // 1. 请求设备码
  onProgress({ state: 'waitingForCode' })
  const deviceCode = await requestDeviceCode(clientId)
  onProgress({
    state: 'waitingForCode',
    userCode: deviceCode.user_code,
    verificationUri: deviceCode.verification_uri
  })

  // 2. 轮询等待用户授权
  onProgress({ state: 'polling', userCode: deviceCode.user_code, verificationUri: deviceCode.verification_uri })
  const msToken = await pollForMsToken(
    deviceCode.device_code,
    deviceCode.interval,
    deviceCode.expires_in,
    signal,
    clientId
  )

  // 3. 交换令牌链: MS → Xbox → XSTS → MC
  onProgress({ state: 'exchanging' })
  const account = await exchangeTokenChain(msToken.access_token, msToken.refresh_token)

  // 4. 持久化
  saveAccount(account)

  onProgress({ state: 'success', account })
  return account
}

/**
 * MS access_token → Xbox → XSTS → MC Token → MC Profile → MinecraftAccount
 */
async function exchangeTokenChain(
  msAccessToken: string,
  msRefreshToken: string
): Promise<MinecraftAccount> {
  // Xbox Live
  const xbox = await authenticateXbox(msAccessToken)

  // XSTS
  const xsts = await authenticateXSTS(xbox.token)

  // MC Token
  const mc = await authenticateMinecraft(xsts.uhs, xsts.token)

  // MC Profile (uuid + username)
  const profile = await getMinecraftProfile(mc.accessToken)

  return {
    id: `ms_${profile.uuid}`,
    type: 'microsoft',
    username: profile.username,
    uuid: profile.uuid,
    accessToken: mc.accessToken,
    expiresAt: Date.now() + mc.expiresIn * 1000,
    xuid: xsts.uhs,
    msRefreshToken: msRefreshToken
  }
}

/**
 * 用 msRefreshToken 刷新整条令牌链
 * @returns 更新后的 MinecraftAccount
 */
export async function refreshAccountToken(account: MinecraftAccount): Promise<MinecraftAccount> {
  if (account.type !== 'microsoft' || !account.msRefreshToken) {
    throw new Error('只有微软账号可以刷新令牌')
  }

  const clientId = getClientId()
  const msToken = await refreshMsToken(account.msRefreshToken, clientId)
  const refreshed = await exchangeTokenChain(msToken.access_token, msToken.refresh_token)

  // 保留原 id
  refreshed.id = account.id
  saveAccount(refreshed)
  return refreshed
}

/**
 * 检查账号 token 是否过期, 如过期自动刷新
 * @param account MinecraftAccount
 * @returns 有效的 MinecraftAccount (可能已刷新)
 */
export async function ensureValidToken(account: MinecraftAccount): Promise<MinecraftAccount> {
  if (account.type === 'offline') return account

  if (account.type === 'yggdrasil') {
    return ensureValidYggdrasilToken(account)
  }

  // 微软账号: 提前 5 分钟刷新
  const now = Date.now()
  const margin = 5 * 60 * 1000
  if (account.expiresAt && account.expiresAt - margin > now) {
    return account // token 还有效
  }

  // token 过期或即将过期，刷新
  return refreshAccountToken(account)
}

/**
 * Yggdrasil 令牌有效性检查与刷新
 */
async function ensureValidYggdrasilToken(account: MinecraftAccount): Promise<MinecraftAccount> {
  if (!account.yggdrasilServer) return account

  // 先 validate, 有效则直接返回
  const valid = await validateToken(
    account.yggdrasilServer,
    account.accessToken,
    account.yggdrasilClientToken
  )
  if (valid) return account

  // 无效则尝试 refresh
  try {
    const result = await yggdrasilRefresh(
      account.yggdrasilServer,
      account.accessToken,
      account.yggdrasilClientToken
    )
    const profile = result.selectedProfile
    const refreshed: MinecraftAccount = {
      ...account,
      accessToken: result.accessToken,
      yggdrasilClientToken: result.clientToken,
      username: profile?.name || account.username,
      uuid: profile?.id ? formatUUID(profile.id) : account.uuid
    }
    saveAccount(refreshed)
    return refreshed
  } catch {
    throw new Error('第三方令牌已过期，请重新登录')
  }
}

function formatUUID(raw: string): string {
  if (raw.includes('-')) return raw
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

/**
 * 通过 accountId 获取有效 token 的账号
 */
export async function getValidAccount(accountId: string): Promise<MinecraftAccount | null> {
  const accounts = getAllAccounts()
  const account = accounts.find(a => a.id === accountId)
  if (!account) return null
  return ensureValidToken(account)
}
