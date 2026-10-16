import { getSourceLocale } from '~/server/utils/organization-locales'
import type { ProductKind } from '~/shared/product-details'
import { HTTPError } from 'nitro';
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { faqBlockSource, faqItems, listFaqBlockQa } from '~/server/utils/location-qa'
import type { FaqBlockSource } from '~/shared/faq-block'
import { listOrganizationReviews } from '~/server/utils/organization-reviews'
import { getTenantPageForEditor, getPublishedTenantPage, listPublishedTenantPagePaths, publicTenantPageSql, type TenantPageDto } from '~/server/utils/content/pages'
import { validateContentBlockData, type TenantPageBlock } from '~/utils/tenant-page-blocks'
import type { MediaPlacementItem } from '~/server/utils/media-placement'
import { COVER_SELECT, attachCoverMedia, coverJoinSql } from '~/server/utils/content/cover'
import { loadPublicSocialMedia } from '~/server/utils/public-social-image'
import type { SocialImageSource } from '~/utils/social-metadata'
import {
  loadExactPublicLocalizations,
  projectExactLocalizedCollection,
  projectLocalizedMediaAlt,
  type ExactPublicLocalization,
} from '~/server/utils/public-localization'
import { documentOfRootSql } from '~/server/utils/content/documents'
import { listPublicLocaleRepresentations, resolvePublicDocumentSourcePath } from '~/server/utils/public-locale-representations'
import { listPublicSocialPosts } from '~/server/utils/post-management'
import { resolvePublicTemplate } from '~/utils/template-registry'
import { EXPERIENCE_PRESENTATION, presentationForProduct, publicLocationPath } from '~/utils/product-presentation'
import { publicLocationHomeSlugSql, publicLocationSql } from '~/server/utils/public-locations'
import { formatMinorAmount } from '~/shared/prices'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { listCollections, listOrganizationProducts, publicProduct } from '~/server/utils/product-management'
import { PRICING_NOTE_HANDLE } from '~/shared/product-details'
import { summarizeProductPrices } from '~/utils/product-money'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import { addressPlaceName, formatPostalAddress, parsePostalAddress } from '~/utils/postal-address'
import { getVerticalCopy } from '~/utils/vertical-copy'

export interface PublicTenantPage {
  id: string
  page_id: string
  product_id?: string | null
  path: string
  title: string
  summary: string | null
  page_type: string
  recipe: string | null
  sort_order: number
  locale: string
  blocks: TenantPageBlock[]
  media: MediaPlacementItem[]
  social_image: SocialImageSource | null
  localeRepresentations?: PublicLocaleRepresentation[]
  updated_at: string
}

/** A page referenced by a page_grid block. */
export interface PublicTenantPageReferenceRow {
  product_id: string | null
  id: string
  title: string
  summary: string | null
  slug: string
  path: string
  media: MediaPlacementItem[]
}

/** A product referenced by a product_grid block. */
export interface PublicTenantPageProductRow {
  id: string
  name: string
  slug: string
  description: string
  kind: ProductKind
  featured: boolean
  /**
   * The one location publishing this product, or null when several do. A
   * product offered in two places has no single route, so its card links
   * nowhere rather than to a location the merchant did not name.
   */
  location_slug: string | null
  public_path: string | null
  available: boolean
  pricing_note: string | null
  unit_amount: number | null
  max_unit_amount: number | null
  compare_at_unit_amount: number | null
  currency: string | null
  media: MediaPlacementItem[]
}

export interface PublicTenantPageHydrationResources {
  pages?: Promise<PublicTenantPageReferenceRow[]>
}

/**
 * Resolve the pages a page_grid names.
 *
 * Only published roots, and only the ones named. A grid cannot list "every
 * page on the site" — that source is gone, because it silently changed
 * whenever anyone added a page.
 */
export async function listPublicTenantPageReferenceRows(
  db: DbClient,
  organizationId: string,
  pageIds: readonly string[],
  locale?: string,
): Promise<PublicTenantPageReferenceRow[]> {
  locale ??= await getSourceLocale(db, organizationId)
  if (pageIds.length === 0) return []
  // The referenced root, rendered in the requested locale through its own
  // representation row. A missing translation links to the source document.
  const rows = await queryAll<Omit<PublicTenantPageReferenceRow, 'media'>>(db, `
    SELECT root.id, root.product_id, COALESCE(rep.title, root.title) AS title, COALESCE(rep.summary, root.summary) AS summary,
           COALESCE(rep.slug, root.slug) AS slug, CASE WHEN rep.id IS NULL THEN root.path WHEN rep.path = '/' THEN '/' || rep.locale ELSE '/' || rep.locale || rep.path END AS path
      FROM content_documents root
      LEFT JOIN content_documents rep ON rep.root_id = root.id AND rep.row_role = 'representation' AND rep.locale = ?
     WHERE root.organization_id = ? AND root.row_role = 'root' AND root.kind = 'page'
       AND root.path IS NOT NULL AND root.title IS NOT NULL
       AND ${publicTenantPageSql('root')}
       AND root.id IN (SELECT value FROM json_each(?))
     ORDER BY root.sort_order ASC, root.title ASC
  `, [locale, organizationId, d1JsonStringSet(pageIds)])
  const placements = await loadPublicSocialMedia(db, organizationId, 'content_document', rows.map(row => row.id))
  return rows.map(row => ({ ...row, media: placements.get(row.id)?.media ?? [] }))
}

/**
 * Resolve the products a product_grid names, by collection or by id.
 *
 * The grid stores references only, so names and descriptions come from the
 * product every time it renders and cannot go stale.
 */
async function loadTenantPageProductCatalog(db: DbClient, organizationId: string, locale?: string, localizations: readonly ExactPublicLocalization[] | null = null, env?: CloudflareEnv) {
  locale ??= await getSourceLocale(db, organizationId)
  const [products, collections, locations, pageRepresentations] = await Promise.all([
    listOrganizationProducts(db, { organizationId, publishedOnly: true, env }).then(products => products.map(publicProduct)),
    listCollections(db, { organizationId }),
    queryAll<{ id: string; slug: string }>(db, "SELECT id,slug FROM business_locations WHERE organization_id=? AND status='active'", [organizationId]),
    localizations ? queryAll<{ product_id: string; path: string }>(db, `SELECT root.product_id, rep.path
      FROM content_documents root JOIN content_documents rep ON rep.root_id=root.id AND rep.row_role='representation' AND rep.locale=?
      WHERE root.organization_id=? AND root.kind='page' AND root.product_id IS NOT NULL AND rep.path IS NOT NULL AND ${publicTenantPageSql('root')}`, [locale, organizationId]) : Promise.resolve([]),
  ])
  const media = await loadPublicSocialMedia(db, organizationId, 'product', products.map(product => product.id))
  if (localizations) for (const entry of media.values()) entry.media = projectLocalizedMediaAlt(entry.media, localizations)
  const localizedProducts = localizations ? projectExactLocalizedCollection('product', products, localizations) : products
  const localizedLocations = localizations ? projectExactLocalizedCollection('business_location', locations, localizations) : locations
  return { products: localizedProducts, collections, locations: localizedLocations, media, locale, localized: localizations !== null, pageRepresentations }
}

export async function listPublicTenantPageProductRows(
  db: DbClient,
  organizationId: string,
  selection: { collectionId?: string | null; productIds?: readonly string[] },
  currency: string,
  catalog?: Awaited<ReturnType<typeof loadTenantPageProductCatalog>>,
  env?: CloudflareEnv,
): Promise<PublicTenantPageProductRow[]> {
  const productIds = new Set(selection.productIds ?? [])
  if (!selection.collectionId && !productIds.size) return []
  if (!isCurrencyCode(currency)) throw new Error('The public catalog requires a supported currency')
  const source = catalog ?? await loadTenantPageProductCatalog(db, organizationId, undefined, null, env)
  const collection = selection.collectionId ? source.collections.find(item => item.id === selection.collectionId) : null
  if (selection.collectionId && !collection) throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page collection reference is unavailable' })
  const locations = new Map(source.locations.map(location => [location.id, location]))
  const at = new Date().toISOString()
  const selected = source.products.filter(product => productIds.has(product.id) || product.collections.some(item => item.collection_id === collection?.id))
    .sort((left, right) => (left.collections.find(item => item.collection_id === collection?.id)?.sort_order ?? 0)
      - (right.collections.find(item => item.collection_id === collection?.id)?.sort_order ?? 0) || left.name.localeCompare(right.name))
  return selected.flatMap(product => {
    const offered = product.locations.filter(location => location.published && locations.has(location.location_id))
    if (collection?.location_id && !offered.some(location => location.location_id === collection.location_id)) return []
    const online = Boolean(product.booking?.held_online || product.order_url)
    if (!offered.length && !online) return []
    const locationId = collection?.location_id ?? (offered.length === 1 && !online ? offered[0]!.location_id : null)
    const scopes = locationId ? [locationId] : [...offered.map(location => location.location_id), ...(online ? [null] : [])]
    const prices = summarizeProductPrices(product.variants, scopes.map(location_id => ({ currency, location_id, at })))
    const locationSlug = locationId ? locations.get(locationId)?.slug ?? null : null
    const presentation = presentationForProduct(null, product)
    const sourcePath = product.page?.path ?? (product.kind === 'experience'
      ? EXPERIENCE_PRESENTATION.productPath('', product.slug) + (locationId ? `?location_id=${encodeURIComponent(locationId)}` : '')
      : locationSlug && presentation ? presentation.productPath(locationSlug, product.slug) : null)
    const localizedPage = source.pageRepresentations.find(page => page.product_id === product.id)
    let publicPath = sourcePath
    if (source.localized) {
      if (product.page) publicPath = localizedPage ? `/${source.locale}${localizedPage.path}` : null
      else publicPath = sourcePath ? `/${source.locale}${sourcePath}` : null
    }
    const note = product.details[PRICING_NOTE_HANDLE]
    return [{ id: product.id, name: product.name, slug: product.slug, description: product.description, kind: product.kind, featured: product.details.featured === true,
      location_slug: locationSlug, public_path: publicPath,
      available: product.active && (locationId ? offered.some(location => location.location_id === locationId && location.active) : online || offered.some(location => location.active)),
      pricing_note: typeof note === 'string' ? note : null,
      unit_amount: prices.lowest?.unit_amount ?? null, max_unit_amount: prices.highest?.unit_amount ?? null,
      compare_at_unit_amount: prices.lowest?.compare_at_unit_amount ?? null, currency: prices.lowest?.currency ?? null,
      media: source.media.get(product.id)?.media ?? [],
    }]
  })
}

async function hydrateBlocks(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  pagePath: string,
  locale: string,
  blocks: TenantPageBlock[],
  resources: PublicTenantPageHydrationResources = {},
  localizations: readonly ExactPublicLocalization[] | null = null,
): Promise<TenantPageBlock[]> {
  const pageIds = new Set<string>()
  const productIds = new Set<string>()
  const collectionIds = new Set<string>()
  const locationIds = new Set<string>()
  const qaSources = new Set(blocks.map(faqBlockSource).filter((source): source is FaqBlockSource => source !== null))
  // A reviews grid has no source to choose — reviews are the site's reviews.
  // The gate outlived the `source` field it read, so a grid authored in the
  // CMS, which never writes that key, listed nothing.
  const hasReviewSource = blocks.some(block => block.type === 'testimonial_grid')
  const hasPostSource = blocks.some(block => block.type === 'feature_grid' && block.data.source === 'organization_posts')
  // The site's social posts — its own updates, written in KrabiClaw. They are
  // `social_post` documents, a different record from the
  // articles `organization_posts` reads, and a Saya home shows both.
  for (const block of blocks) {
    if (block.type === 'page_grid') {
      for (const value of block.data.page_ids as string[]) pageIds.add(value)
    }
    if (block.type === 'product_grid') {
      if (Array.isArray(block.data.product_ids)) {
        for (const value of block.data.product_ids) if (typeof value === 'string' && value.trim()) productIds.add(value)
      }
      if (typeof block.data.collection_id === 'string' && block.data.collection_id.trim()) collectionIds.add(block.data.collection_id)
    }
    if (block.type === 'location_grid' && Array.isArray(block.data.location_ids)) {
      for (const value of block.data.location_ids) if (typeof value === 'string' && value.trim()) locationIds.add(value)
    }
  }
  // The site this page belongs to. Its template decides where an article
  // lives, its vertical decides where a product lives, and its currency
  // decides which offers apply.
  // The reads a block names (pages, FAQ, reviews, posts) depend on the blocks
  // alone, so they travel with the site row rather than after it.
  const [organizationRow, sourcePages, qaItemsBySource, sourceReviewRows, sourcePostRows] = await Promise.all([
    queryFirst<{ theme_id: string | null; vertical: string | null; default_currency: string | null; address_visibility: string | null }>(
      db, "SELECT theme_id, vertical, default_currency, json_extract(settings_json, '$.compliance.address_visibility') AS address_visibility FROM organization WHERE id = ? LIMIT 1", [organizationId]),
    pageIds.size
      ? resources.pages
        ? resources.pages.then(pages => pages.filter(page => pageIds.has(page.id)))
        : listPublicTenantPageReferenceRows(db, organizationId, [...pageIds], locale)
      : [],
    Promise.all([...qaSources].map(async source => [source, faqItems(await listFaqBlockQa(db, organizationId, pagePath, source, locale))] as const)).then(entries => new Map(entries)),
    hasReviewSource ? listOrganizationReviews(db, organizationId, { publishedOnly: true }) : [],
    hasPostSource ? queryAll<{ id: string; title: string; slug: string; excerpt: string | null; cover_asset_id: string | null; cover_public_url: string | null; cover_thumbnail_url: string | null; cover_kind: string | null; cover_alt_text: string | null; cover_width: number | null; cover_height: number | null }>(db, `
      SELECT p.id, p.title, p.slug, p.summary AS excerpt, ${COVER_SELECT}
        FROM content_documents root JOIN content_documents p ON ${documentOfRootSql('p', 'root')} AND p.locale = ?
        ${coverJoinSql('p')}
       WHERE root.kind = 'article' AND root.row_role = 'root' AND p.organization_id = ? AND root.status = 'published' AND root.visibility = 'listed'
       ORDER BY root.published_at IS NULL, root.published_at DESC, p.id DESC
    `, [locale, organizationId]) : [],
  ])
  if (!organizationRow) throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page site is unavailable' })
  const template = resolvePublicTemplate({ themeId: organizationRow.theme_id, vertical: organizationRow.vertical })
  const defaultServices = pagePath === '/services' && template.slug === 'blawby' && blocks.length === 1 && blocks[0]?.type === 'hero'
  const defaultLocationGrid = pagePath === '/' && template.slug !== 'platform' && !blocks.some(block => block.type === 'location_grid')
  const addressVisible = template.slug !== 'blawby' || organizationRow.address_visibility === 'visible'
  const articlePrefix = template.serviceRoutes.articleDetailPrefix
  // Each grid gets the products it named, and only those. Keyed by collection
  // rather than flattened into one list: two grids on a page name two different
  // collections, and a flat union rendered both collections in both grids.
  const currency = organizationRow.default_currency
  const homepage = pagePath === '/' && template.slug !== 'platform'
  const homepageMenu = homepage && template.slug === 'saya'
  // The default services list, the catalog and the branches all follow from the
  // template alone; one round trip reads the three.
  const [services, productCatalog, sourceLocations] = await Promise.all([
    defaultServices ? listOrganizationProducts(db, { organizationId, kind: 'service', publishedOnly: true, env }).then(products => products.map(publicProduct)) : [],
    collectionIds.size || productIds.size || homepage || defaultServices ? loadTenantPageProductCatalog(db, organizationId, locale, localizations, env) : undefined,
    locationIds.size || defaultLocationGrid
      ? queryAll<{ id: string; title: string; slug: string; home_slug: string | null; address: string | null; description: string | null; short_description: string | null; asset_id: string | null; public_url: string | null; thumbnail_url: string | null; kind: string | null; alt_text: string | null }>(db, `
          SELECT bl.id, bl.title, bl.slug, ${publicLocationHomeSlugSql('bl')} AS home_slug, bl.address, bl.description, bl.short_description, ma.id AS asset_id, ma.public_url, ma.thumbnail_url, ma.kind, ma.alt_text
            FROM business_locations bl
            LEFT JOIN media_placements mp ON mp.organization_id = bl.organization_id AND mp.owner_type = 'business_location' AND mp.owner_id = bl.id AND mp.slot = 'hero' AND mp.sort_order = 0 AND mp.status = 'active'
            LEFT JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = bl.organization_id AND ma.status = 'active'
           WHERE bl.organization_id = ? AND bl.status = 'active' AND ((? = 1 AND ${publicLocationSql('bl')}) OR bl.id IN (SELECT value FROM json_each(?)))
           ORDER BY bl.title, bl.id
        `, [organizationId, defaultLocationGrid ? 1 : 0, d1JsonStringSet([...locationIds])])
      : [],
  ])
  for (const service of services) {
    if (!service.page) throw new HTTPError({ statusCode: 500, statusMessage: 'Published service page is unavailable', data: { code: 'SERVICE_PAGE_MISSING', product_id: service.id } })
    productIds.add(service.id)
  }
  if (defaultServices && productIds.size) blocks = [...blocks, {
    id: 'services-list', type: 'product_grid', position: blocks.length,
    data: { product_ids: [...productIds] }, media: [],
  }]
  const homepageDishes = homepageMenu ? productCatalog!.products.filter(product => product.kind === 'dish') : []
  const defaultMenuGrid = homepageMenu && blocks.some(block => block.type === 'product_grid'
    && !(Array.isArray(block.data.product_ids) && block.data.product_ids.length) && !block.data.collection_id)
  for (const product of homepageDishes) if (defaultMenuGrid || product.details.featured === true) productIds.add(product.id)
  if (homepage) for (const product of productCatalog!.products) if (product.kind === 'experience' || product.details.featured === true) productIds.add(product.id)
  // Null on a template that sells nothing; its pages carry no product grid.
  if ((collectionIds.size || productIds.size) && !currency) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page site has no currency' })
  }
  const productsByCollection = new Map(await Promise.all([...collectionIds].map(async collectionId =>
    [collectionId, await listPublicTenantPageProductRows(db, organizationId, { collectionId }, currency!, productCatalog)] as const)))
  const productById = new Map((productIds.size
    ? await listPublicTenantPageProductRows(db, organizationId, { productIds: [...productIds] }, currency!, productCatalog)
    : []).map(product => [product.id, product]))
  const menuProducts = [...productById.values()].filter(product => product.kind === 'dish')
  const featuredMenuProducts = menuProducts.filter(product => product.featured)
  const defaultMenuProducts = featuredMenuProducts.length ? featuredMenuProducts : menuProducts
  const displayed = new Set(blocks.filter(block => block.type === 'product_grid').flatMap(block =>
    Array.isArray(block.data.product_ids) && block.data.product_ids.length
      ? block.data.product_ids.filter((id): id is string => typeof id === 'string' && productById.has(id))
      : block.data.collection_id
        ? (productsByCollection.get(String(block.data.collection_id)) ?? []).map(product => product.id)
        : homepageMenu ? defaultMenuProducts.map(product => product.id) : []))
  if (homepage) {
    const missing = [...productById.values()].filter(product => product.featured && product.kind !== 'experience' && !displayed.has(product.id))
    if (missing.length) blocks = [...blocks, {
      id: 'homepage-featured-products', type: 'product_grid',
      position: Math.max(-1, ...blocks.map(block => block.position)) + 1,
      data: { product_ids: missing.map(product => product.id) }, media: [],
    }]
  }
  const missingExperiences = homepage ? [...productById.values()].filter(product => product.kind === 'experience' && !displayed.has(product.id)) : []
  if (missingExperiences.length) blocks = [...blocks, {
    id: 'homepage-experiences', type: 'product_grid',
    position: Math.max(-1, ...blocks.map(block => block.position)) + 1,
    data: { title: getVerticalCopy(organizationRow.vertical, locale).experiencesPageTitle, product_ids: missingExperiences.map(product => product.id) }, media: [],
  }]
  // The row stores the address as text and a translation carries only the parts
  // that are words, so the canonical one is read first: the overlay then merges
  // the translated parts onto it and keeps the region code and postcode. Left as
  // text, the overlay replaced the whole value with a partial address.
  const parsedLocations = sourceLocations.map(location => ({ ...location, address: parsePostalAddress(location.address) }))
  const locations = localizations
    ? projectExactLocalizedCollection('business_location', parsedLocations, localizations).map((location) => {
        const representation = localizations.find(item => item.resourceType === 'business_location' && item.resourceId === location.id)
        const slug = representation?.routePath?.split('/').filter(Boolean).at(-1)
        if (!representation?.routePath?.startsWith('/') || !slug) {
          throw new HTTPError({ statusCode: 500, statusMessage: 'Stored localized location route is invalid', data: { code: 'INVALID_STORED_CONTENT' } })
        }
        return { ...location, slug, public_path: representation.routePath }
      })
    : parsedLocations
  const locationCopy = getVerticalCopy(organizationRow.vertical, locale)
  const defaultLocations = template.slug === 'blawby'
    ? locations.filter(location => location.address || location.asset_id || location.description?.trim() || location.short_description?.trim())
    : locations
  if (defaultLocationGrid && defaultLocations.length) {
    blocks = [...blocks, {
      id: 'homepage-locations', type: 'location_grid',
      position: Math.max(-1, ...blocks.map(block => block.position)) + 1,
      data: { title: locationCopy.locationGroupLine(defaultLocations.length), description: locationCopy.findUsKicker, location_ids: defaultLocations.map(location => location.id) },
      media: [],
    }]
  }
  if (homepageMenu) {
    const ctaTypes = ['cta', 'booking_cta', 'contact_cta']
    blocks = [...blocks].sort((left, right) => Number(ctaTypes.includes(left.type)) - Number(ctaTypes.includes(right.type)))
  }
  // A social_posts block reads the organization's feed through the one public
  // post reader, with its own scope and limit; nothing about a post is stored
  // on the block.
  const socialFeeds = new Map(await Promise.all(blocks.filter(block => block.type === 'social_posts').map(async (block) => {
    const locationId = typeof block.data.location_id === 'string' && block.data.location_id ? block.data.location_id : null
    // A block scoped to a location that is gone is a broken block, not an empty feed.
    if (locationId && !(await queryFirst(db, "SELECT 1 FROM business_locations WHERE id = ? AND organization_id = ? AND status = 'active'", [locationId, organizationId]))) {
      throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page location reference is unavailable' })
    }
    const limit = Number(block.data.limit)
    const feed = await listPublicSocialPosts(env, db, organizationId, { locale, locationId, window: { limit, offset: 0 },
      resource: `public-posts:${organizationId}:${locale}:${locationId ?? ''}` })
    return [block.id, feed] as const
  })))
  const reviewRows = sourceReviewRows
  const postRows = sourcePostRows
  // A page's translation is its representation row, loaded by locale in the
  // reference query above — not a resource_localizations entry. Only the media
  // alt text needs projecting here.
  const pages = localizations
    ? sourcePages.map(page => ({ ...page, media: projectLocalizedMediaAlt(page.media, localizations) }))
    : sourcePages
  const pageById = new Map(pages.map(item => [item.id, item]))
  const sourceLocationById = new Map(sourceLocations.map(item => [item.id, item]))
  const locationById = new Map(locations.map(item => [item.id, item]))
  const reviewItems = (reviewRows as unknown as Array<Record<string, unknown>>).map(row => ({
    id: String(row.id),
    title: typeof row.author_name === 'string' ? row.author_name : '',
    description: typeof row.content === 'string' ? row.content : undefined,
    value: row.rating == null ? undefined : String(row.rating),
    // The reviewer's picture, which the review record owns. It was dropped on
    // the way into the item, so a template drawing portraits drew none.
    media: Array.isArray(row.media) ? row.media : [],
  }))
  const postItems = postRows.map((post) => {
    const { cover, ...row } = attachCoverMedia(post)
    return {
      id: row.id,
      title: row.title,
      description: row.excerpt || undefined,
      url: `${articlePrefix}/${row.slug}`,
      labelKey: 'saya.posts.read_full_story',
      media: cover
        ? projectLocalizedMediaAlt([{ asset_id: cover.asset_id, slot: 'media', public_url: cover.public_url, thumbnail_url: cover.thumbnail_url, kind: cover.kind, alt_text: cover.alt_text }], localizations ?? [])
        : [],
    }
  })
  return blocks.map(block => {
    if (block.type === 'showcase' || block.type === 'language_reach' || block.type === 'steps' || block.type === 'how_to') validateContentBlockData(block.type, block.data)
    const data = { ...block.data }
    if (block.type === 'page_grid') {
      data.items = (data.page_ids as string[]).map((id) => {
        const page = pageById.get(id)
        // A reference to a page that is gone or unpublished is a broken block,
        // not a row to quietly drop: the editor chose it and needs to know.
        if (!page) throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page reference is unavailable' })
        return {
          id: page.id,
          product_id: page.product_id,
          title: page.title,
          description: page.summary ?? undefined,
          url: page.path,
          labelKey: 'saya.posts.cta_default',
          media: page.media,
        }
      })
    }
    if (block.type === 'product_grid') {
      // Explicit selections stay as authored; an unscoped homepage menu uses
      // the merchant's featured dishes, or its ordinary menu when none are featured.
      const collectionId = typeof data.collection_id === 'string' && data.collection_id.trim() ? data.collection_id : null
      const selected = Array.isArray(data.product_ids) && data.product_ids.length > 0
        ? data.product_ids.flatMap((id) => {
            const product = typeof id === 'string' ? productById.get(id) : undefined
            return product ? [product] : []
          })
        : collectionId
          ? productsByCollection.get(collectionId)
          : homepageMenu ? defaultMenuProducts : []
      if (!selected) throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page collection reference is unavailable' })
      data.items = selected.map(product => ({
        id: product.id,
        title: product.name,
        description: product.description || undefined,
        // The product's own surface. An experience is named by its own slug
        // site-wide; every other product is read under the one location that
        // publishes it, and a product published in several places has no
        // single route, so its card carries none.
        kind: product.kind,
        featured: product.featured,
        url: product.public_path ?? '',
        unavailable: !product.available,
        value: product.unit_amount === null || !product.currency
          ? product.pricing_note ?? undefined
          : product.max_unit_amount !== null && product.max_unit_amount !== product.unit_amount
            ? `${formatMinorAmount(product.unit_amount, product.currency as CurrencyCode, locale)} – ${formatMinorAmount(product.max_unit_amount, product.currency as CurrencyCode, locale)}`
            : formatMinorAmount(product.unit_amount, product.currency as CurrencyCode, locale),
        compare_at: product.compare_at_unit_amount === null || !product.currency
          ? undefined
          : formatMinorAmount(product.compare_at_unit_amount, product.currency as CurrencyCode, locale),
        labelKey: 'saya.posts.cta_default',
        // A grid item carries the one image it is drawn with, which for a
        // product is its `image` placement — the same cover `hydrateProductMedia`
        // resolves for every other product surface. It carried the product's
        // whole placement list instead, and the reader took the head of it;
        // placements are read slot-ordered, so a product with a `gallery` asset
        // handed the card that asset rather than its cover, and a gallery video
        // put an .mp4 in the card's <img src>.
        media: product.media.filter(item => item.slot === 'image'),
      }))
    }
    if (block.type === 'location_grid' && Array.isArray(data.location_ids)) {
      data.items = data.location_ids.flatMap((id) => {
        const sourceLocation = typeof id === 'string' ? sourceLocationById.get(id) : undefined
        if (!sourceLocation) {
          throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page location reference is unavailable' })
        }
        const location = locationById.get(sourceLocation.id)
        if (!location) return []
        return [{
          id: location.id,
          title: location.title,
          // The town the visitor is being sent to. A location card names it
          // above the title, and the item carried everything except that.
          ...(addressVisible ? { city: addressPlaceName(location.address) || undefined, address: formatPostalAddress(location.address) || undefined } : {}),
          description: location.short_description || location.description || undefined,
          // A location that is one home is reached as that home.
          url: template.slug === 'blawby' ? pagePath === '/contact' ? undefined : '/contact'
            : location.home_slug ? `${localizations ? `/${locale}` : ''}${publicLocationPath(location)}`
              : 'public_path' in location && typeof location.public_path === 'string' ? location.public_path : publicLocationPath(location),
          label: locationCopy.visitLocationCta,
          media: location.asset_id
            ? projectLocalizedMediaAlt([{ asset_id: location.asset_id, slot: 'hero', public_url: location.public_url, thumbnail_url: location.thumbnail_url, kind: location.kind, alt_text: location.alt_text }], localizations ?? [])
            : [],
        }]
      })
    }
    const faqSource = faqBlockSource(block)
    if (faqSource) data.items = qaItemsBySource.get(faqSource)
    if (block.type === 'testimonial_grid') data.items = reviewItems
    if (block.type === 'social_posts') {
      const feed = socialFeeds.get(block.id)!
      data.posts = feed.posts
      data.has_more = feed.page_info.has_more
    }
    if (block.type === 'feature_grid' && data.source === 'organization_posts') {
      const items = postItems
      const limit = typeof data.limit === 'number' && Number.isInteger(data.limit) && data.limit > 0 ? data.limit : items.length
      data.items = items.slice(0, limit)
    }
    return { ...block, data }
  })
}

function mapPage(
  page: TenantPageDto,
  blocks: TenantPageBlock[],
  socialMedia: { media: MediaPlacementItem[]; social_image: SocialImageSource | null },
  localeRepresentations: PublicLocaleRepresentation[],
): PublicTenantPage {
  return {
    id: page.id,
    page_id: page.page_id,
    product_id: page.product_id,
    path: page.path,
    title: page.title,
    summary: page.summary,
    page_type: page.page_type,
    recipe: page.recipe,
    sort_order: page.sort_order,
    locale: page.locale,
    blocks,
    ...socialMedia,
    localeRepresentations,
    updated_at: page.updated_at,
  }
}

export async function getPublicTenantPageForPath(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  path: string,
  options: {
    locale?: string | null
    preview?: boolean
    hydrationResources?: PublicTenantPageHydrationResources
    localizations?: readonly ExactPublicLocalization[] | null
  } = {},
): Promise<PublicTenantPage | null> {
  const page = options.preview
    ? await getTenantPageForEditor(db, await resolveVariantId(db, organizationId, path, options.locale))
    : await getPublishedTenantPage(db, organizationId, path, options.locale)
  if (!page) return null
  const localizations = page.id === page.page_id
    ? null
    : options.localizations ?? await loadExactPublicLocalizations(env, db, page.organization_id, page.locale)
  // The home page has no card of its own: it is the organization's page, and
  // its image is the organization's.
  const [blocks, media, localeRepresentations] = await Promise.all([
    hydrateBlocks(env, db, organizationId, page.path, page.locale, page.blocks, options.hydrationResources, localizations),
    page.path === '/'
      ? loadPublicSocialMedia(db, organizationId, 'organization', [organizationId]).then(organization => new Map([[page.id, {
          media: [],
          social_image: organization.get(organizationId)?.social_image ?? null,
        }]]))
      : loadPublicSocialMedia(db, organizationId, 'content_document', [page.id]),
    resolvePublicDocumentSourcePath(db, organizationId, page.page_id).then(sourcePath => listPublicLocaleRepresentations(env, db, {
      organizationId: page.organization_id,
      sourcePath,
      documentId: page.page_id,
    })),
  ])
  const localizedMedia = page.id === page.page_id
    ? media.get(page.id) ?? { media: [], social_image: null }
    : {
        ...(media.get(page.id) ?? { media: [], social_image: null }),
        media: projectLocalizedMediaAlt(media.get(page.id)?.media ?? [], localizations ?? []),
      }
  if (page.id !== page.page_id) {
    for (const block of blocks) {
      block.media = projectLocalizedMediaAlt(
        block.media.map(item => ({ ...item, alt_text: item.alt_text ?? null })),
        localizations ?? [],
      )
    }
  }
  return mapPage(page, blocks, localizedMedia, localeRepresentations)
}

async function resolveVariantId(db: DbClient, organizationId: string, path: string, locale?: string | null): Promise<string> {
  locale ??= await getSourceLocale(db, organizationId)
  const row = await queryFirst<{ id: string } | null>(db, `
    SELECT v.id
      FROM content_documents v
     WHERE v.kind = 'page' AND v.row_role IN ('root','representation') AND v.organization_id = ? AND v.path = ?
       AND (? IS NULL OR v.locale = ?)
     ORDER BY v.locale ASC
     LIMIT 1
  `, [organizationId, path, locale ?? null, locale ?? null])
  if (!row) throw new HTTPError({ statusCode: 404, statusMessage: 'Tenant page not found' })
  return row.id
}

export async function listCanonicalTenantPages(env: CloudflareEnv, db: DbClient, organizationId: string, locale?: string | null) {
  const paths = await listPublishedTenantPagePaths(db, organizationId, locale)
  const pages: PublicTenantPage[] = []
  for (const item of paths) {
    const page = await getPublicTenantPageForPath(env, db, organizationId, item.path, { locale })
    if (page) pages.push(page)
  }
  return pages
}
