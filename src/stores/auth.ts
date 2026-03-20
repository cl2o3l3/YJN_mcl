import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { MinecraftAccount, AuthLoginState, YggdrasilServerInfo } from '../types'

export const useAuthStore = defineStore('auth', () => {
  const accounts = ref<MinecraftAccount[]>([])
  const selectedAccountId = ref<string>('')
  const loginState = ref<AuthLoginState>('idle')
  const deviceCode = ref('')
  const verificationUri = ref('')
  const loginError = ref('')

  // Yggdrasil 第三方认证
  const yggdrasilServers = ref<YggdrasilServerInfo[]>([])
  const yggdrasilLoading = ref(false)
  const yggdrasilError = ref('')

  const selectedAccount = computed(() =>
    accounts.value.find(a => a.id === selectedAccountId.value)
  )

  /** 从主进程加载已持久化的账号 */
  async function init() {
    const data = await window.api.auth.getAccounts()
    accounts.value = data.accounts
    selectedAccountId.value = data.selectedId || data.accounts[0]?.id || ''
    // 加载已保存的第三方服务器
    yggdrasilServers.value = await window.api.auth.yggdrasilGetServers()
  }

  /** 添加离线账号 */
  function addOfflineAccount(username: string) {
    const uuid = generateOfflineUUID(username)
    const account: MinecraftAccount = {
      id: `offline_${username}`,
      type: 'offline',
      username,
      uuid,
      accessToken: '0'
    }
    accounts.value = accounts.value.filter(a => a.id !== account.id)
    accounts.value.push(account)
    selectedAccountId.value = account.id
    // 持久化到主进程
    window.api.auth.saveAccount(account)
    window.api.auth.setSelectedId(account.id)
    return account
  }

  /** 启动微软 Device Code 登录 */
  async function startMsLogin() {
    loginState.value = 'waitingForCode'
    loginError.value = ''
    deviceCode.value = ''
    verificationUri.value = ''

    const cleanup = window.api.auth.onLoginProgress((event) => {
      loginState.value = event.state
      if (event.userCode) deviceCode.value = event.userCode
      if (event.verificationUri) verificationUri.value = event.verificationUri
      if (event.error) loginError.value = event.error
    })

    try {
      const account = await window.api.auth.startMsLogin()
      // invoke 返回的 account 一定在 success 之后，这里做最终状态同步
      if (account) {
        loginState.value = 'success'
        accounts.value = accounts.value.filter(a => a.id !== account.id)
        accounts.value.push(account)
        selectedAccountId.value = account.id
        await window.api.auth.setSelectedId(account.id)
      }
    } catch {
      const currentState = loginState.value as string
      if (currentState !== 'error' && currentState !== 'success') {
        loginState.value = 'error'
      }
    } finally {
      cleanup()
    }
  }

  /** 取消微软登录 */
  async function cancelMsLogin() {
    await window.api.auth.cancelMsLogin()
    loginState.value = 'idle'
    deviceCode.value = ''
    verificationUri.value = ''
  }

  /** 移除账号 */
  async function removeAccount(id: string) {
    accounts.value = accounts.value.filter(a => a.id !== id)
    await window.api.auth.removeAccount(id)
    if (selectedAccountId.value === id) {
      selectedAccountId.value = accounts.value[0]?.id || ''
      await window.api.auth.setSelectedId(selectedAccountId.value)
    }
  }

  /** 选择账号 */
  async function selectAccount(id: string) {
    selectedAccountId.value = id
    await window.api.auth.setSelectedId(id)
  }

  /** 确保 token 有效 (启动游戏前调用) */
  async function ensureValidToken(account: MinecraftAccount): Promise<MinecraftAccount> {
    if (account.type === 'offline') return account
    const refreshed = await window.api.auth.ensureValidToken(account)
    // 更新本地缓存
    const idx = accounts.value.findIndex(a => a.id === refreshed.id)
    if (idx !== -1) accounts.value[idx] = refreshed
    return refreshed
  }

  // ========== Yggdrasil 第三方认证 ==========

  /** 添加第三方认证服务器 (输入URL, 自动解析) */
  async function addYggdrasilServer(inputUrl: string): Promise<YggdrasilServerInfo> {
    yggdrasilLoading.value = true
    yggdrasilError.value = ''
    try {
      const apiRoot = await window.api.auth.yggdrasilResolveApi(inputUrl)
      const info = await window.api.auth.yggdrasilServerInfo(apiRoot)
      await window.api.auth.yggdrasilAddServer(info)
      yggdrasilServers.value = yggdrasilServers.value.filter(s => s.url !== info.url)
      yggdrasilServers.value.push(info)
      return info
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      yggdrasilError.value = msg
      throw err
    } finally {
      yggdrasilLoading.value = false
    }
  }

  /** 移除第三方认证服务器 */
  async function removeYggdrasilServer(url: string) {
    await window.api.auth.yggdrasilRemoveServer(url)
    yggdrasilServers.value = yggdrasilServers.value.filter(s => s.url !== url)
  }

  /** 第三方登录 */
  async function yggdrasilLogin(apiRoot: string, username: string, password: string): Promise<MinecraftAccount> {
    yggdrasilLoading.value = true
    yggdrasilError.value = ''
    try {
      const account = await window.api.auth.yggdrasilLogin(apiRoot, username, password)
      accounts.value = accounts.value.filter(a => a.id !== account.id)
      accounts.value.push(account)
      selectedAccountId.value = account.id
      await window.api.auth.setSelectedId(account.id)
      return account
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      yggdrasilError.value = msg
      throw err
    } finally {
      yggdrasilLoading.value = false
    }
  }

  /** 获取预设服务器 */
  async function getPresetServers() {
    return window.api.auth.yggdrasilPresetServers()
  }

  return {
    accounts, selectedAccountId, selectedAccount,
    loginState, deviceCode, verificationUri, loginError,
    yggdrasilServers, yggdrasilLoading, yggdrasilError,
    init, addOfflineAccount, startMsLogin, cancelMsLogin,
    removeAccount, selectAccount, ensureValidToken,
    addYggdrasilServer, removeYggdrasilServer, yggdrasilLogin, getPresetServers
  }
})

function generateOfflineUUID(username: string): string {
  const bytes = new TextEncoder().encode('OfflinePlayer:' + username)
  let hash = 0
  for (const b of bytes) hash = ((hash << 5) - hash + b) | 0
  const hex = Math.abs(hash).toString(16).padStart(8, '0')
  return `${hex.slice(0, 8)}-${hex.slice(0, 4)}-3${hex.slice(1, 4)}-a${hex.slice(1, 4)}-${hex.padEnd(12, '0').slice(0, 12)}`
}
