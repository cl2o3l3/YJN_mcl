/**
 * Xbox Live → XSTS → Minecraft 令牌交换链
 */

import { postJson, fetchJsonAuth } from '../download'

// ========== Xbox Live 认证 ==========

interface XboxAuthResponse {
  Token: string
  DisplayClaims: { xui: { uhs: string }[] }
}

/** MS access_token → Xbox Live Token + UserHash */
export async function authenticateXbox(msAccessToken: string): Promise<{ token: string; uhs: string }> {
  const resp = await postJson<XboxAuthResponse>(
    'https://user.auth.xboxlive.com/user/authenticate',
    {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${msAccessToken}`
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    }
  )
  return {
    token: resp.Token,
    uhs: resp.DisplayClaims.xui[0].uhs
  }
}

// ========== XSTS 认证 ==========

/** Xbox Token → XSTS Token */
export async function authenticateXSTS(xboxToken: string): Promise<{ token: string; uhs: string }> {
  const resp = await postJson<XboxAuthResponse>(
    'https://xsts.auth.xboxlive.com/xsts/authorize',
    {
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [xboxToken]
      },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    }
  )
  return {
    token: resp.Token,
    uhs: resp.DisplayClaims.xui[0].uhs
  }
}

// ========== Minecraft 令牌 ==========

interface McAuthResponse {
  username: string        // 不是 MC 用户名，是一个数字 ID
  access_token: string
  token_type: string
  expires_in: number      // 秒
}

interface McProfileResponse {
  id: string              // UUID (无横线)
  name: string            // MC 用户名
}

/** XSTS Token + UHS → MC access_token */
export async function authenticateMinecraft(
  uhs: string,
  xstsToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const resp = await postJson<McAuthResponse>(
    'https://api.minecraftservices.com/authentication/login_with_xbox',
    {
      identityToken: `XBL3.0 x=${uhs};${xstsToken}`
    }
  )
  return {
    accessToken: resp.access_token,
    expiresIn: resp.expires_in
  }
}

/** 获取 MC 档案 (uuid + 用户名) */
export async function getMinecraftProfile(
  mcAccessToken: string
): Promise<{ uuid: string; username: string }> {
  const resp = await fetchJsonAuth<McProfileResponse>(
    'https://api.minecraftservices.com/minecraft/profile',
    mcAccessToken
  )
  // 转换 UUID 格式: 无横线 → 标准
  const id = resp.id
  const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
  return { uuid, username: resp.name }
}
