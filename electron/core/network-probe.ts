/**
 * 网络诊断工具
 * IPv6 检测、系统代理检测、STUN/TURN 可达性测试
 */

import * as dns from 'dns'
import { session } from 'electron'
import type { NetworkDiagnostics } from '../../src/types'

/**
 * 检测 IPv6 连通性
 * 优先使用国内可达的 IPv6 测试地址
 */
export async function checkIPv6(): Promise<{ ok: boolean; error?: string }> {
  const testHosts = [
    'ipv6.mirrors.ustc.edu.cn',   // 中科大镜像 (国内)
    'ipv6.tsinghua.edu.cn',       // 清华 (国内)
    'ipv6.google.com',            // Google (国外备选)
  ]

  for (const host of testHosts) {
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000)
      dns.resolve6(host, (err) => {
        clearTimeout(timer)
        if (err) {
          resolve({ ok: false, error: err.code || err.message })
        } else {
          resolve({ ok: true })
        }
      })
    })
    if (result.ok) return result
  }
  return { ok: false, error: 'All IPv6 test hosts unreachable' }
}

/**
 * 检测系统代理
 */
export async function detectProxy(url: string = 'https://example.com'): Promise<{ detected: boolean; url?: string }> {
  try {
    const proxy = await session.defaultSession.resolveProxy(url)
    if (proxy === 'DIRECT') {
      return { detected: false }
    }
    return { detected: true, url: proxy }
  } catch {
    return { detected: false }
  }
}

/**
 * 综合网络诊断
 * 注意: STUN/TURN 诊断在渲染进程中进行 (需要 WebRTC API)
 * 这里只做主进程能做的: IPv6 和代理检测
 */
export async function runNetworkDiagnostics(): Promise<Pick<NetworkDiagnostics, 'ipv6' | 'proxy'>> {
  const [ipv6, proxy] = await Promise.all([
    checkIPv6(),
    detectProxy()
  ])

  return { ipv6, proxy }
}
