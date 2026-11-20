export const PLATFORM_THEME_STORAGE_KEY = 'blawby-theme'

export function readPlatformThemePreference(storage: Storage, key: string = PLATFORM_THEME_STORAGE_KEY) {
  const stored = storage.getItem(key)
  if (stored !== 'system' && stored !== 'light' && stored !== 'dark') return null
  return stored
}
