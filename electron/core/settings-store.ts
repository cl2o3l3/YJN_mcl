import Store from 'electron-store'
import type { LauncherSettings } from '../../src/types'
import { getDefaultSettings } from '../../src/types'

const store = new Store<LauncherSettings>({
  name: 'settings',
  defaults: getDefaultSettings()
})

export function loadSettings(): LauncherSettings {
  return {
    locale: store.get('locale'),
    mirrorSource: store.get('mirrorSource'),
    defaultJvmArgs: store.get('defaultJvmArgs'),
    defaultGameDir: store.get('defaultGameDir'),
    defaultVersionIsolation: store.get('defaultVersionIsolation'),
    defaultJavaPath: store.get('defaultJavaPath'),
    manualJavaPaths: store.get('manualJavaPaths'),
    theme: store.get('theme'),
    maxConcurrentDownloads: store.get('maxConcurrentDownloads'),
    defaultMinMemory: store.get('defaultMinMemory'),
    defaultMaxMemory: store.get('defaultMaxMemory'),
    gameDirs: store.get('gameDirs'),
    signalingServer: store.get('signalingServer'),
    stunServers: store.get('stunServers'),
    turnServers: store.get('turnServers'),
    relayServers: store.get('relayServers'),
    enableIPv6: store.get('enableIPv6'),
    relayFallback: store.get('relayFallback'),
    curseForgeApiKey: store.get('curseForgeApiKey'),
  }
}

export function saveSettings(partial: Partial<LauncherSettings>): void {
  for (const [key, value] of Object.entries(partial)) {
    store.set(key as keyof LauncherSettings, value)
  }
}
