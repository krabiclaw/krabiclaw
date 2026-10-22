import type { Ref } from 'vue'
import type { Collection, Product } from '~/server/types/products'
import { groupProductsByCollection } from '~/utils/product-presentation'
import { getErrorMessage } from '~/utils/errors'

/**
 * The organization's catalog, fetched once. A location is a projection of its
 * explicit product relationships, not a separate copy of the catalog.
 *
 * Several levels need it at once: Catalog, Collections, one collection's
 * products and the title above them. Keyed `useAsyncData` means they share one
 * request and one cache entry, and a write in any of them refreshes all.
 *
 * The scope is the caller's explicit choice, never a remembered one: no
 * location is the whole organization's catalog, a location is what that
 * location offers. Collections are always all of them, each carrying the
 * location it belongs to (null for site-wide) — the same set the public menu
 * reads — and a screen shows the ones for its scope.
 *
 * The level that opens the catalog awaits `load`, so it renders complete; the
 * levels below it share the loaded entry.
 */
export function useProductCatalog(organizationId: string, locationId: Ref<string | null>) {
  const dashboardApi = useDashboardApi()
  const isCollectionList = (value: unknown): value is { collections: Collection[] } =>
    isRecord(value) && Array.isArray(value.collections)
  const isProductList = (value: unknown): value is { success: true, products: Product[] } =>
    isRecord(value) && Array.isArray(value.products)

  const load = useAsyncData(
    `product-catalog:${organizationId}`,
    async () => {
      const [collectionResponse, productResponse] = await Promise.all([
        dashboardApi(`/api/editor/organizations/${organizationId}/collections`, { validate: isCollectionList }),
        dashboardApi(`/api/editor/organizations/${organizationId}/products`, { validate: isProductList }),
      ])
      return { collections: collectionResponse.collections, products: productResponse.products }
    },
  )
  const { data, pending, error } = load

  const collections = computed(() => data.value?.collections ?? [])
  const products = computed(() => (data.value?.products ?? []).filter(product =>
    !locationId.value || product.locations.some(location => location.location_id === locationId.value)))

  // Every projection shares Nuxt's entry, including its initial failure state.
  async function refresh() {
    await load.refresh()
    if (error.value) throw error.value
  }

  /** Membership always reads the complete organization catalog, regardless of price scope. */
  function collectionProductIds(collectionId: string): string[] {
    if (error.value) throw error.value
    if (!data.value) throw new Error('The catalog has not been loaded')
    if (!data.value.collections.some(collection => collection.id === collectionId)) throw new Error('This section no longer exists.')
    return groupProductsByCollection(data.value.products, data.value.collections).find(group => group.id === collectionId)?.products.map(product => product.id) ?? []
  }

  /** One full-state write and independent read for add, remove, reorder and atomic moves. */
  async function setCollectionProducts(collectionId: string, productIds: string[], expected: string[], move?: { collection_id: string; expected_product_ids: string[] }) {
    let failure: unknown = null
    try {
      await dashboardApi(`/api/editor/organizations/${organizationId}/collections/${collectionId}/products`, {
        method: 'PUT', body: { product_ids: productIds, expected_product_ids: expected, ...(move ? { move_to: move } : {}) },
        validate: (value: unknown): value is { success: true; products: Product[] } => isRecord(value) && value.success === true && Array.isArray(value.products),
      })
    } catch (error) { failure = error }
    try { await refresh() }
    catch (error) {
      throw new Error(`${failure ? getErrorMessage(failure, 'The section could not be saved') : 'The changes were saved.'} The section could not be read again: ${getErrorMessage(error, 'Read failed')}`, { cause: error })
    }
    if (failure) throw failure
    if (JSON.stringify(collectionProductIds(collectionId)) !== JSON.stringify(productIds)) throw new Error('The section changed. Review its current items before editing again.')
    if (move) {
      const removed = expected.filter(id => !productIds.includes(id))
      const target = move.expected_product_ids.concat(removed.filter(id => !move.expected_product_ids.includes(id)))
      if (JSON.stringify(collectionProductIds(move.collection_id)) !== JSON.stringify(target)) throw new Error('The destination section changed. Review its current items before moving again.')
    }
  }

  return { load, collections, products, pending, error, refresh, collectionProductIds, setCollectionProducts }
}
