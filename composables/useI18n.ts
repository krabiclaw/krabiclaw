import { computed } from 'vue'
import { useI18n as useVueI18n } from 'vue-i18n'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import { formatTenantLocalePath } from '~/utils/tenant-locale-path'

export function useI18n() {
  const composer = useVueI18n()
  const publicLocale = useState<string>('public-locale', () => 'en')
  const sourceLocale = useState<string | null>('public-source-locale', () => null)
  const { template } = useTenantOrganization().organization
  const isPlatform = template.slug === 'platform'
  const representations = useState<PublicLocaleRepresentation[]>('public-locale-representations', () => [])
  const locales = computed(() => representations.value.map(item => ({ code: item.locale, name: item.label })))

  const setLocale = (value: string) => {
    const representation = representations.value.find(item => item.locale === value)
    if (!representation) {
      throw createError({ statusCode: 404, statusMessage: `Locale ${value} is not available for this route` })
    }
    return navigateTo(representation.route_path, { external: true })
  }
  const localePath = (path: string) => {
    if (isPlatform) return path
    if (!sourceLocale.value) throw createError({ statusCode: 500, statusMessage: 'Organization primary language is unavailable' })
    return formatTenantLocalePath(path, publicLocale.value, sourceLocale.value)
  }

  return Object.assign(composer, { locales, setLocale, localePath })
}
