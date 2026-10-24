import type { Ref } from 'vue'
import type { Product } from '~/server/types/products'
import { isCurrencyCode } from '~/shared/currencies'
import { summarizeProductPrices, formatProductPriceRange } from '~/utils/product-money'

/**
 * What a product costs in Catalog's scope, through the one price selection
 * contract. One location asks that location's price; the whole organization
 * asks every location's and shows the saved range, so a menu priced per branch does
 * not read as unpriced when no branch is chosen.
 */
export function useCatalogPrice(locationId: Ref<string | null>, locations: Ref<ReadonlyArray<{ id: string }>>) {
  const dashboard = useDashboardOrganization()
  const rawCurrency = dashboard.organization.value?.default_currency
  if (!isCurrencyCode(rawCurrency)) throw createError({ statusCode: 500, statusMessage: 'Unsupported organization currency' })
  const currency = rawCurrency

  function priceLabel(product: Pick<Product, 'variants'>, includeInactive = false, scope = locationId.value) {
    const at = new Date().toISOString()
    const scopes = scope ? [scope] : [null, ...locations.value.map(location => location.id)]
    return formatProductPriceRange(summarizeProductPrices(product.variants, scopes.map(location_id => ({ currency, location_id, at })), includeInactive)) ?? ''
  }

  return { priceLabel }
}
