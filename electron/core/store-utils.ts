export function parseStoreJson<T>(value: string): T {
  const normalized = value.replace(/^\uFEFF/, '')
  return JSON.parse(normalized) as T
}