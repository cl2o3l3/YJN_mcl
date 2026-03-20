/**
 * 微软 Device Code OAuth 2.0 流程
 * 文档: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code
 */

import { postForm } from '../download'
import type { DeviceCodeResponse, MSTokenResponse } from '../../../src/types'

const DEFAULT_CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb'
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
const SCOPE = 'XboxLive.signin offline_access'

/** Step 1: 请求设备码 */
export async function requestDeviceCode(clientId?: string): Promise<DeviceCodeResponse> {
  return postForm<DeviceCodeResponse>(`${AUTHORITY}/devicecode`, {
    client_id: clientId || DEFAULT_CLIENT_ID,
    scope: SCOPE
  })
}

/**
 * Step 2: 轮询等待用户授权
 * @param deviceCode - 从 requestDeviceCode 获取的 device_code
 * @param interval - 轮询间隔秒数
 * @param expiresIn - 过期时间秒数
 * @param signal - AbortSignal 用于取消轮询
 */
export async function pollForMsToken(
  deviceCode: string,
  interval: number,
  expiresIn: number,
  signal?: AbortSignal,
  clientId?: string
): Promise<MSTokenResponse> {
  const deadline = Date.now() + expiresIn * 1000
  let pollInterval = Math.max(interval, 5) * 1000 // 至少 5 秒
  const cid = clientId || DEFAULT_CLIENT_ID

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('用户取消了登录')
    }

    await sleep(pollInterval)

    if (signal?.aborted) {
      throw new Error('用户取消了登录')
    }

    try {
      const token = await postForm<MSTokenResponse>(`${AUTHORITY}/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: cid,
        device_code: deviceCode
      })
      return token
    } catch (err: unknown) {
      const code = (err as { errorCode?: string }).errorCode
      if (code === 'authorization_pending') {
        continue // 用户还没授权，继续轮询
      }
      if (code === 'slow_down') {
        pollInterval += 5000 // 服务器要求减速
        continue
      }
      if (code === 'expired_token') {
        throw new Error('设备码已过期，请重新发起登录')
      }
      throw err
    }
  }

  throw new Error('设备码已过期，请重新发起登录')
}

/** 用 refresh_token 刷新微软令牌 */
export async function refreshMsToken(refreshToken: string, clientId?: string): Promise<MSTokenResponse> {
  return postForm<MSTokenResponse>(`${AUTHORITY}/token`, {
    client_id: clientId || DEFAULT_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPE
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
