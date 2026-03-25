import Store from 'electron-store'
import type { MinecraftAccount, YggdrasilServerInfo } from '../../../src/types'
import { parseStoreJson } from '../store-utils'

const DEFAULT_CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb'

const store = new Store<{
  accounts: MinecraftAccount[]
  selectedId: string
  clientId: string
  yggdrasilServers: YggdrasilServerInfo[]
}>({
  name: 'accounts',
  defaults: { accounts: [], selectedId: '', clientId: DEFAULT_CLIENT_ID, yggdrasilServers: [] },
  deserialize: (value) => parseStoreJson<{
    accounts: MinecraftAccount[]
    selectedId: string
    clientId: string
    yggdrasilServers: YggdrasilServerInfo[]
  }>(value)
})

export function getAllAccounts(): MinecraftAccount[] {
  return store.get('accounts')
}

export function getSelectedAccountId(): string {
  return store.get('selectedId')
}

export function setSelectedAccountId(id: string): void {
  store.set('selectedId', id)
}

export function saveAccount(account: MinecraftAccount): void {
  const accounts = store.get('accounts').filter(a => a.id !== account.id)
  accounts.push(account)
  store.set('accounts', accounts)
}

export function removeAccount(id: string): void {
  const accounts = store.get('accounts').filter(a => a.id !== id)
  store.set('accounts', accounts)
  if (store.get('selectedId') === id) {
    store.set('selectedId', accounts[0]?.id || '')
  }
}

export function saveAllAccounts(accounts: MinecraftAccount[]): void {
  store.set('accounts', accounts)
}

export function getClientId(): string {
  return store.get('clientId') || DEFAULT_CLIENT_ID
}

export function setClientId(id: string): void {
  store.set('clientId', id.trim() || DEFAULT_CLIENT_ID)
}

// ========== Yggdrasil 服务器 ==========
export function getYggdrasilServers(): YggdrasilServerInfo[] {
  return store.get('yggdrasilServers')
}

export function addYggdrasilServer(server: YggdrasilServerInfo): void {
  const servers = store.get('yggdrasilServers').filter(s => s.url !== server.url)
  servers.push(server)
  store.set('yggdrasilServers', servers)
}

export function removeYggdrasilServer(url: string): void {
  const servers = store.get('yggdrasilServers').filter(s => s.url !== url)
  store.set('yggdrasilServers', servers)
}
