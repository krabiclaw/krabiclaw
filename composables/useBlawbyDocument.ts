import type { BlawbyRouteRecipe } from '~/types/blawby'
import { publicApiRequest } from '~/utils/api-clients'
import { isBlawbyDocumentPayload, type BlawbyDocumentPayload } from '~/utils/blawby-document-contract'

export interface BlawbyRouteTarget {
  recipe: BlawbyRouteRecipe
  slug: string | null
}

export function resolveBlawbyPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

export function resolveBlawbyRouteTarget(path: string): BlawbyRouteTarget {
  const routePath = resolveBlawbyPath(path)
  if (routePath === '/') return { recipe: 'home', slug: null }
  if (routePath === '/links') return { recipe: 'links', slug: null }
  if (routePath === '/services') return { recipe: 'services', slug: null }
  if (routePath === '/about') return { recipe: 'about', slug: null }
  if (routePath === '/pricing') return { recipe: 'pricing', slug: null }
  if (routePath === '/contact') return { recipe: 'contact', slug: null }
  if (routePath === '/contact/confirmed' || routePath === '/bookings/confirmed' || routePath === '/bookings/cancel') return { recipe: 'confirmation', slug: null }
  if (routePath === '/schedule') return { recipe: 'schedule', slug: null }
  if (routePath === '/blog') return { recipe: 'blog', slug: null }
  if (routePath === '/posts' || /^\/posts\/[^/]+$/.test(routePath)) return { recipe: 'posts', slug: null }
  if (routePath === '/experiences' || /^\/experiences\/[^/]+$/.test(routePath) || /^\/locations\/[^/]+\/experiences$/.test(routePath)) return { recipe: 'experiences', slug: null }
  // Every article-collection route: an article, the docs index and a doc, and a category page.
  if (/^\/article\/[^/]+$/.test(routePath) || /^\/docs(?:\/[^/]+)?$/.test(routePath) || /^\/(?:blog|docs)\/category\/[^/]+$/.test(routePath)) return { recipe: 'article', slug: null }
  if (routePath === '/donate') return { recipe: 'donate', slug: null }
  if (routePath === '/policies/privacy') return { recipe: 'privacy', slug: null }
  if (routePath === '/policies/terms') return { recipe: 'terms', slug: null }
  if (routePath === '/third-party-notices') return { recipe: 'third-party-notices', slug: null }
  // Every other path is a page this site publishes; whether it exists is the
  // page loader's answer, not a list kept here.
  return { recipe: 'page', slug: routePath }
}

export async function useBlawbyDocument(
  recipe: BlawbyRouteRecipe,
  slug?: string | null,
  options: { server?: boolean; lazy?: boolean } = {},
) {
  const nuxtApp = useNuxtApp()
  const { id: organizationId, template } = useTenantOrganization().organization
  const locale = useState<string>('public-locale', () => 'en')
  if (template.slug !== 'blawby') {
    throw createError({ statusCode: 404, statusMessage: 'Blawby organization context is unavailable' })
  }

  const normalizedSlug = slug?.trim() || ''
  const key = () => `blawby-document-${organizationId}-${recipe}-${normalizedSlug || 'index'}-${locale.value}`
  const asyncData = await useAsyncData<BlawbyDocumentPayload>(
    key,
    async (_nuxtApp, { signal }) => {
      if (import.meta.server) {
        const requestEvent = useRequestEvent()
        if (!requestEvent) throw createError({ statusCode: 500, statusMessage: 'Request context unavailable' })
        const { loadPublicBlawbyDocument } = await import('~/server/utils/public-blawby-document')
        return await loadPublicBlawbyDocument(requestEvent, organizationId, recipe, {
          slug: normalizedSlug,
          previewAuthorized: Boolean(requestEvent.context.previewAuthorized),
          locale: locale.value,
          mutateResponseHeaders: false,
          signal,
        })
      }
      // The preview cookie travels with this request, so the API resolves the
      // same authorization the server render used.
      return await publicApiRequest<BlawbyDocumentPayload>('/api/public/blawby/document', {
        signal,
        query: { recipe, locale: locale.value, ...(normalizedSlug ? { slug: normalizedSlug } : {}) },
        validate: value => isBlawbyDocumentPayload(value, recipe),
      })
    },
    {
      server: options.server ?? true,
      lazy: options.lazy ?? false,
      dedupe: 'defer',
      getCachedData(cacheKey) {
        return useNuxtApp().payload.data[cacheKey] as BlawbyDocumentPayload | undefined
      },
    },
  )

  if (!asyncData.data.value && (asyncData.status.value === 'idle' || asyncData.status.value === 'pending')) {
    await asyncData.execute({ dedupe: 'defer' })
  }
  if (asyncData.error.value) {
    const error = asyncData.error.value
    if (import.meta.server) throw error
    throw nuxtApp.runWithContext(() => showError(error))
  }
  if (!asyncData.data.value && options.server !== false) {
    throw createError({ statusCode: 500, statusMessage: 'Blawby document data was not returned' })
  }

  watch(asyncData.error, (error) => {
    if (error) nuxtApp.runWithContext(() => showError(error))
  }, { flush: 'sync' })

  return {
    ...asyncData,
    data: asyncData.data as Ref<BlawbyDocumentPayload>,
  }
}
