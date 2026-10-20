import type { Product } from '~/server/types/products'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { isPublicProduct } from '~/utils/public-resource-contracts'
import { isRecord, publicApiRequest } from '~/utils/api-clients'
export async function useConsultationProducts() {
  const { locale } = useI18n()
  const { organization } = useTenantOrganization()
  const { id: organizationId } = organization
  const organizationName = organization.name
  const { data, pending, error } = await useAsyncData(() => `consultation-products:${organizationId}:${locale.value}`, async (_nuxtApp, { signal }) => {
    if (import.meta.server) {
      const event = useRequestEvent()!
      const { cloudflareEnv } = await import('~/server/utils/api-response')
      const { loadPublicProductApiCollection } = await import('~/server/utils/public-products')
      const env = cloudflareEnv(event)
      const collection = await loadPublicProductApiCollection(env, env.DB, organizationId, Boolean(event.context.previewAuthorized), undefined, locale.value)
      if (!collection) throw createError({ statusCode: 404, statusMessage: 'Consultation services not found' })
      return { products: collection.products, currency: collection.currency }
    }
    return await publicApiRequest<{ products: Product[]; currency: CurrencyCode }>('/api/public/products', {
      query: { locale: locale.value }, signal,
      validate: (value): value is { products: Product[]; currency: CurrencyCode } => isRecord(value) && Array.isArray(value.products) && value.products.every(isPublicProduct) && isCurrencyCode(value.currency),
    })
  })
  if (error.value) throw error.value
  return { data, pending, error, organizationId, organizationName }
}
