import { canonicalizeLocale } from '~/server/utils/localization'

export function normalizeLocale(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return canonicalizeLocale(value)
  } catch {
    return null
  }
}
