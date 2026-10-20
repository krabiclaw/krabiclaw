import englishManifest from '../i18n/locales/en'
import japaneseMessages from '../i18n/catalogs/ja.json' with { type: 'json' }
import thaiMessages from '../i18n/catalogs/th.json' with { type: 'json' }
import vietnameseMessages from '../i18n/catalogs/vi.json' with { type: 'json' }
import { flattenLocaleManifest, validateLocaleCatalog } from './platform-locale-catalog'

export interface PlatformLocale {
  locale: string
  label: string
  direction: 'ltr' | 'rtl'
  messages: Readonly<Record<string, string>>
}

// A language is supported when its complete catalog is listed here; nothing
// else in the application enumerates languages. The label is the language's
// own name for itself.
const CATALOGS: Record<string, unknown> = { ja: japaneseMessages, th: thaiMessages, vi: vietnameseMessages }

const englishMessages = Object.freeze(flattenLocaleManifest(englishManifest))

function nativeLabel(locale: string): string {
  const label = new Intl.DisplayNames(locale, { type: 'language' }).of(locale)
  if (!label) throw new Error(`No language name for platform locale ${locale}`)
  return label
}

export const PLATFORM_LOCALES: readonly PlatformLocale[] = Object.freeze([
  { locale: 'en', label: nativeLabel('en'), direction: 'ltr', messages: englishMessages },
  ...Object.entries(CATALOGS).map(([locale, catalog]): PlatformLocale => {
    const validation = validateLocaleCatalog(englishMessages, catalog, { complete: true })
    if (!validation.ok) throw new Error(`Bundled ${locale} locale catalog is invalid: ${validation.issue.kind}`)
    return { locale, label: nativeLabel(locale), direction: 'ltr', messages: Object.freeze(validation.messages) }
  }),
])

export function platformLocale(locale: string): PlatformLocale | null {
  return PLATFORM_LOCALES.find(candidate => candidate.locale === locale) ?? null
}
