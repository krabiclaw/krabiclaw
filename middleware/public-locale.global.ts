import { splitLocalePrefix } from '~/utils/tenant-locale-path'
import { platformLocale } from '~/shared/platform-locales'
import { TENANT_NON_INDEXABLE_EXACT_PATHS } from '~/utils/template-registry'

export default defineNuxtRouteMiddleware(async (to) => {
  const state = useState<string>('public-locale', () => 'en')
  const sourceLocale = useState<string | null>('public-source-locale', () => null)
  const setAppLocale = (locale: string, messages: Record<string, string> | null) => {
    const { $setAppLocale } = useNuxtApp() as {
      $setAppLocale?: (value: string, catalog: Record<string, string> | null) => void
    }
    if (!$setAppLocale) throw new Error('Application locale setter is unavailable')
    $setAppLocale(locale, messages)
  }
  // The URL names the language, whether the route declares a `locale` param or
  // the path simply carries the prefix. One reading of it, so a client
  // navigation and a hard load cannot disagree about what the URL means.
  const routing = splitLocalePrefix(to.path)
  const requested = typeof to.params.locale === 'string' && to.params.locale
    ? to.params.locale
    : routing.localeSegment
  const privateGuestRoute = TENANT_NON_INDEXABLE_EXACT_PATHS.has(routing.sourcePath)
    || to.name === 'booking-changes-threadId-requestId' || to.name === 'localized-booking-changes-threadId-requestId'

  if (import.meta.client) {
    const representations = useState<Array<{ locale: string; source: 'source' | 'localized' }>>('public-locale-representations', () => [])
    if (requested) {
      // A prefix naming no supported language is a URL that does not exist —
      // the same 404 the server answers with, rather than rendering the site's
      // own language under someone else's prefix. Whether THIS site publishes
      // the language is the destination page's own answer: its data load is
      // what holds that fact, and it 404s when it does not.
      const catalog = platformLocale(requested)
      // A path prefix is only a language when it names one. `Intl` calls every
      // well-formed subtag a locale, and our own routes include several —
      // `/dev`, `/qa` — so reading the prefix as a language here 404'd real
      // pages after the server had already rendered them. A route that
      // declares a `locale` param means what it says and still 404s.
      if (!catalog) {
        if (typeof to.params.locale === 'string' && to.params.locale) {
          throw createError({ statusCode: 404, statusMessage: 'Language is not enabled for this organization' })
        }
        return
      }
      if (!privateGuestRoute && catalog.locale === sourceLocale.value) {
        throw createError({ statusCode: 404, statusMessage: 'Primary language routes are unprefixed' })
      }
      state.value = catalog.locale
      setAppLocale(catalog.locale, { ...catalog.messages })
      return
    }
    // No prefix: the site's own language. With no representations loaded there
    // is nothing to read it from and nothing to change — the locale the server
    // rendered this document in already stands.
    if (!representations.value.length) return
    const source = representations.value.find(item => item.source === 'source')
    if (!source) throw createError({ statusCode: 500, statusMessage: 'Organization primary language is unavailable' })
    const catalog = platformLocale(source.locale)
    if (!catalog) throw createError({ statusCode: 500, statusMessage: 'Application language catalog is unavailable' })
    state.value = source.locale
    setAppLocale(source.locale, { ...catalog.messages })
    return
  }

  const candidate = requested

  const event = useRequestEvent()
  const organizationId = event?.context.organizationId as string | null | undefined
  if (!event || !organizationId) return
  const [{ cloudflareEnv }, { queryFirst }, { assertPublicOrganizationLanguageEntitlement, getPersistedSourceLocale }] = await Promise.all([
    import('~/server/utils/api-response'),
    import('~/server/db'),
    import('~/server/utils/localization'),
  ])
  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) throw createError({ statusCode: 503, statusMessage: 'Database unavailable' })
  const source = await getPersistedSourceLocale(db, organizationId)
  sourceLocale.value = source.locale
  const sourceCatalog = platformLocale(source.locale)
  if (!sourceCatalog) throw createError({ statusCode: 500, statusMessage: 'Organization primary language is unavailable' })
  state.value = source.locale
  setAppLocale(source.locale, { ...sourceCatalog.messages })
  if (!candidate || !platformLocale(candidate)) return
  // Guest capabilities use supported UI copy; the host's public language publication does not authorize the token.
  if (privateGuestRoute) {
    const messages = { ...platformLocale(candidate)!.messages }
    state.value = candidate
    useState<Record<string, string> | null>('platform-locale-messages', () => null).value = messages
    setAppLocale(candidate, messages)
    return
  }
  if (candidate === source.locale) throw createError({ statusCode: 404, statusMessage: 'Primary language routes are unprefixed' })
  const locale = await queryFirst<{ locale: string }>(db, `
    SELECT locale
      FROM organization_locales
     WHERE organization_id = ? AND locale = ? AND is_source = 0 AND status = 'published'
     LIMIT 1
  `, [organizationId, candidate])
  if (!locale) throw createError({ statusCode: 404, statusMessage: 'Language is not enabled for this organization' })
  const entitlement = await assertPublicOrganizationLanguageEntitlement(env, db, organizationId, locale.locale)
  if (!entitlement.platform_messages) {
    throw createError({ statusCode: 503, statusMessage: 'Published platform locale messages are unavailable' })
  }
  const messages = entitlement.platform_messages
  state.value = locale.locale
  useState<Record<string, string> | null>('platform-locale-messages', () => null).value = messages
  setAppLocale(locale.locale, messages)
})
