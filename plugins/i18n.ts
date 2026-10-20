import { createI18n } from 'vue-i18n'
import en from '~/i18n/locales/en'

function expandMessages(messages: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(messages)) {
    const parts = path.split('.')
    let cursor = root
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1) cursor[part] = value
      else {
        const next = cursor[part]
        if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[part] = {}
        cursor = cursor[part] as Record<string, unknown>
      }
    }
  }
  return root
}

export default defineNuxtPlugin((nuxtApp) => {
  const publicLocale = useState<string>('public-locale', () => 'en')
  const platformMessages = useState<Record<string, string> | null>('platform-locale-messages', () => null)
  const i18n = createI18n({
    legacy: false,
    globalInjection: true,
    locale: 'en',
    fallbackLocale: false,
    messages: { en },
  })

  const setAppLocale = (locale: string, messages: Record<string, string> | null) => {
    if (locale !== 'en' && messages) {
      i18n.global.setLocaleMessage(locale, expandMessages(messages) as typeof en)
    }
    i18n.global.locale.value = locale as 'en'
  }

  watch([publicLocale, platformMessages], ([locale, messages]) => {
    setAppLocale(locale, messages)
  }, { immediate: true })

  nuxtApp.vueApp.use(i18n)
  return { provide: { appLocale: i18n.global.locale, setAppLocale } }
})
