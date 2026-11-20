export const PLATFORM_THEME_STORAGE_KEY = 'blawby-theme'
export const LEGACY_PLATFORM_THEME_STORAGE_KEY = 'krabiclaw-theme'

export function readPlatformThemePreference(storage: Storage, key: string, legacyKey: string) {
  const current = storage.getItem(key)
  const stored = current ?? storage.getItem(legacyKey)
  if (stored !== 'system' && stored !== 'light' && stored !== 'dark') return null
  if (current === null) {
    storage.setItem(key, stored)
    storage.removeItem(legacyKey)
  }
  return stored
}
