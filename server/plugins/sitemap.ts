import type { ProductKind } from '~/shared/product-details'
import { catalogNavigation, locationSurfacePath, productSurfaceOf, presentationForProduct, resolveProductPresentation } from '~/utils/product-presentation'
import { PUBLIC_CONTENT_SECTION_QUERIES, PUBLIC_CONTENT_SECTIONS, productCatalogRows, publicContentSectionRows, publicSections, type PublicContentSectionRow } from '~/server/utils/public-shell-query'
import { publicLocationHomeSlugSql, publicLocationSql } from '~/server/utils/public-locations'
import type { PublicSiteSection } from '~/utils/public-resource-contracts'
import { publicTenantPageSql } from '~/server/utils/content/pages'
import { isSubscriptionStateInvalid } from '~/server/utils/billing-access'
import type { SitemapUrlInput } from '#sitemap/types'

import { definePlugin, HTTPError } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { cloudflareEnv } from '~/server/utils/api-response'
import { isNonIndexableHost, PLATFORM_SITEMAP_ROUTES } from '~/server/utils/seo-policy'
import { isDemoOrganization } from '~/shared/demo'
import { ARTICLE_COLLECTIONS, collectionCategoryPath, isArticleCollection } from '~/utils/article-collections'
import { tenantBlogPostPath } from '~/utils/tenant-blog-route'
import { TENANT_TYPES } from '~/utils/tenant-routing'
import { resolvePublicTemplate } from '~/utils/template-registry'
import { assertOrganizationLanguageEntitlement } from '~/server/utils/localization'
import { listOrganizationProducts } from '~/server/utils/product-management'

// A collection path that is a section is listed only when the section has something on it.
const SECTION_PATHS: Record<string, PublicSiteSection> = {
  '/menu': 'menu', '/products': 'products', '/experiences': 'experiences', '/stays': 'stays', '/reservations': 'reservations',
  '/blog': 'blog', '/posts': 'posts', '/reviews': 'reviews', '/qa': 'qa', '/photos': 'photos',
}

interface SitemapEntry {
  loc: string
  lastmod?: string
}

async function listPublishedTenantSitemapPages(db: DbClient, organizationId: string) {
  return await queryAll<{ path: string | null; lastmod: string | null }>(db, `
    SELECT v.path, v.updated_at AS lastmod
      FROM content_documents v
     WHERE v.organization_id = ? AND v.kind = 'page' AND v.row_role = 'root'
       AND ${publicTenantPageSql('v')}
     ORDER BY lastmod ASC, path ASC
  `, [organizationId])
}

/**
 * A site's listed articles, on every template, the index of each collection
 * that has one (the blog at its template's prefix, the docs at /docs), and
 * each category page that lists at least one of them. KrabiClaw's site and
 * every customer's read the same queries.
 */
async function listSitemapArticleEntries(db: DbClient, organizationId: string, template: Parameters<typeof tenantBlogPostPath>[0]): Promise<SitemapEntry[]> {
  const articles = await queryAll<{ slug: string | null; collection: string | null; updated_at: string | null }>(db, `
    SELECT slug, (metadata_json ->> '$.collection') AS collection, updated_at
      FROM content_documents
     WHERE organization_id = ? AND kind = 'article' AND row_role = 'root' AND status = 'published' AND visibility = 'listed'
  `, [organizationId])
  const entries: SitemapEntry[] = []
  for (const article of articles) {
    if (!article.slug) continue
    if (!isArticleCollection(article.collection)) throw new Error(`Article ${article.slug} has no valid collection`)
    entries.push({ loc: ARTICLE_COLLECTIONS[article.collection].pathPrefix })
    entries.push({ loc: tenantBlogPostPath(template, article.slug, article.collection), lastmod: article.updated_at ?? undefined })
  }
  const categories = await queryAll<{ slug: string; collection: string; lastmod: string | null }>(db, `
    SELECT c.slug, c.collection, MAX(root.updated_at) AS lastmod
      FROM article_categories c
      JOIN article_category_articles m ON m.category_id = c.id
      JOIN content_documents root ON root.id = m.article_id AND root.status = 'published' AND root.visibility = 'listed'
     WHERE c.organization_id = ?
     GROUP BY c.id
  `, [organizationId])
  for (const category of categories) {
    if (!isArticleCollection(category.collection)) throw new Error(`Category ${category.slug} has no valid collection`)
    entries.push({ loc: collectionCategoryPath(category.collection, category.slug), lastmod: category.lastmod ?? undefined })
  }
  return entries
}

function addUniqueEntries(target: SitemapUrlInput[], entries: SitemapEntry[]) {
  const existing = new Set(target.map(entry => typeof entry === 'string' ? entry : entry.loc))
  for (const entry of entries) {
    if (!entry.loc || existing.has(entry.loc)) continue
    existing.add(entry.loc)
    target.push(entry)
  }
}

export default definePlugin((nitroApp) => {
  // Runtime endpoint sources are intentionally discarded. They are fetched as
  // synthetic internal requests, which do not inherit the original tenant
  // context or Cloudflare bindings. The input hook below works on the real
  // sitemap request event and can query the correct tenant database directly.
  nitroApp.hooks.hook('sitemap:sources', (ctx) => {
    ctx.sources = []
  })

  /** The organization's listed, published short posts and their feed, on every template. */
  const socialPostEntries = async (db: DbClient, organizationId: string): Promise<SitemapEntry[]> => {
    const posts = await queryAll<{ slug: string; updated_at: string }>(db, `SELECT slug, updated_at FROM content_documents
      WHERE organization_id = ? AND kind = 'social_post' AND row_role = 'root' AND status = 'published' AND visibility = 'listed'
      ORDER BY published_at DESC`, [organizationId])
    return posts.length ? [{ loc: '/posts' }, ...posts.map(post => ({ loc: `/posts/${post.slug}`, lastmod: post.updated_at }))] : []
  }

  nitroApp.hooks.hook('sitemap:input', async (ctx) => {
    const event = ctx.event
    const hostname = event.url.hostname
    if (isNonIndexableHost(hostname) || isDemoOrganization(event.context.organization as { subdomain?: string } | undefined)) {
      ctx.urls.length = 0
      return
    }

    const env = cloudflareEnv(event)
    const db = env.db
    if (!db) {
      ctx.urls.length = 0
      return
    }

    const entries: SitemapEntry[] = []

    if (event.context.tenantType === TENANT_TYPES.PLATFORM) {
      const platformOrganizationId = event.context.organizationId as string
      entries.push(...PLATFORM_SITEMAP_ROUTES.map(loc => ({ loc })))

      // KrabiClaw's marketing pages are page documents on its own organization,
      // listed from the same table as every customer's pages.
      for (const page of await listPublishedTenantSitemapPages(db, platformOrganizationId)) {
        if (!page.path) continue
        entries.push({ loc: page.path, lastmod: page.lastmod ?? undefined })
      }

      entries.push(...await listSitemapArticleEntries(db, platformOrganizationId, { themeId: event.context.themeId as string | null | undefined }))

      entries.push(...await socialPostEntries(db, platformOrganizationId))
      ctx.urls.length = 0
      addUniqueEntries(ctx.urls, entries)
      return
    }

    if (event.context.tenantType !== TENANT_TYPES.TENANT) {
      ctx.urls.length = 0
      return
    }

    const organizationId = event.context.organizationId as string | undefined
    if (!organizationId || isDemoOrganization(event.context.organization as { subdomain?: string } | undefined)) {
      ctx.urls.length = 0
      return
    }

    const organization = await queryFirst<{ vertical: string | null; theme_id: string | null }>(
      db,
      `SELECT vertical, theme_id FROM organization WHERE id = ? AND status = 'active' LIMIT 1`,
      [organizationId],
    )

    if (!organization) {
      ctx.urls.length = 0
      return
    }

    const template = resolvePublicTemplate({ themeId: organization.theme_id, vertical: organization.vertical })
    const productPresentation = resolveProductPresentation(organization.vertical)
    const publicProducts = await listOrganizationProducts(db, { organizationId, publishedOnly: true, env })
    const publicProductIds = JSON.stringify(publicProducts.map(product => product.id))

    const localizedLocales = await queryAll<{ locale: string; organization_id: string }>(db, `
      SELECT l.locale, l.organization_id
        FROM organization_locales l
       WHERE l.organization_id = ? AND l.is_source = 0 AND l.status = 'published'
       ORDER BY l.locale
    `, [organizationId])
    for (const candidate of localizedLocales) {
      try {
        await assertOrganizationLanguageEntitlement(env, db, candidate.organization_id, candidate.locale)
      } catch (error) {
        if (error instanceof HTTPError && ['LANGUAGE_ENTITLEMENT_REQUIRED', 'LANGUAGE_NOT_ENABLED', 'LANGUAGE_NOT_PUBLISHED', 'PLATFORM_LOCALE_UNAVAILABLE'].includes(error.data?.code)) continue
        if (isSubscriptionStateInvalid(error)) {
          console.error('organization_subscription_state_invalid', { organizationId: candidate.organization_id, locale: candidate.locale })
          continue
        }
        throw error
      }
      const [resources, pages] = await Promise.all([
        queryAll<{ route_path: string; updated_at: string }>(db, `
          SELECT route_path, updated_at FROM resource_localizations
           WHERE organization_id = ? AND locale = ? AND route_path IS NOT NULL
             AND (resource_type <> 'product' OR resource_id IN (SELECT value FROM json_each(?)))
           ORDER BY route_path
        `, [organizationId, candidate.locale, publicProductIds]),
        queryAll<{ path: string; updated_at: string }>(db, `
          SELECT d.path, d.updated_at FROM content_documents d
            JOIN content_documents root ON root.id = d.root_id AND root.row_role = 'root'
           WHERE d.organization_id = ? AND d.locale = ? AND d.row_role = 'representation' AND d.path IS NOT NULL
             AND ((root.kind = 'page' AND ${publicTenantPageSql('root')}) OR (root.kind = 'article' AND root.status = 'published' AND root.visibility = 'listed')
               OR (root.kind = 'social_post' AND root.status = 'published' AND root.visibility = 'listed'))
           ORDER BY d.path
        `, [organizationId, candidate.locale]),
      ])
      for (const resource of resources) entries.push({ loc: resource.route_path, lastmod: resource.updated_at })
      // A Product's localized route is derived from the location it is offered
      // at, so a Product offered at two locations lists both.
      if (productPresentation) {
        const localizedProducts = await queryAll<{ location_path: string | null; slug: string; updated_at: string; kind: ProductKind }>(db, `
          SELECT ll.route_path AS location_path, p.slug, rl.updated_at,
                 p.kind
            FROM resource_localizations rl
            JOIN products p ON p.id = rl.resource_id AND p.organization_id = rl.organization_id
            LEFT JOIN product_locations pl ON pl.product_id = p.id AND pl.organization_id = p.organization_id
             AND pl.published = 1
            LEFT JOIN business_locations bl ON bl.id = pl.location_id AND bl.organization_id = rl.organization_id AND bl.status = 'active'
            LEFT JOIN resource_localizations ll ON ll.resource_type='business_location' AND ll.resource_id=bl.id AND ll.organization_id=rl.organization_id AND ll.locale=rl.locale
           WHERE rl.organization_id = ? AND rl.locale = ? AND rl.resource_type = 'product'
             AND p.id IN (SELECT value FROM json_each(?))
             AND (bl.id IS NOT NULL OR EXISTS (SELECT 1 FROM product_booking_configs bc WHERE bc.product_id=p.id AND bc.organization_id=p.organization_id AND bc.held_online = 1) OR p.order_url IS NOT NULL)
           ORDER BY bl.slug, p.slug
        `, [organizationId, candidate.locale, publicProductIds])
        for (const product of localizedProducts) {
          const presentation = presentationForProduct(organization.vertical, product)
          const locationSlug = product.location_path?.split('/').filter(Boolean).at(-1)
          if (product.kind !== 'experience' && product.kind !== 'stay' && !locationSlug) continue
          entries.push({ loc: `/${candidate.locale}${presentation.productPath(locationSlug ?? '', product.slug)}`, lastmod: product.updated_at })
        }
      }
      // A collection's index and each category page are read in every published
      // language, and listed where that language has an article in them.
      const localizedCategories = await queryAll<{ slug: string; collection: string; lastmod: string | null }>(db, `
        SELECT c.slug, c.collection, MAX(rep.updated_at) AS lastmod
          FROM article_categories c
          JOIN article_category_articles m ON m.category_id = c.id
          JOIN content_documents root ON root.id = m.article_id AND root.status = 'published' AND root.visibility = 'listed'
          JOIN content_documents rep ON rep.root_id = root.id AND rep.row_role = 'representation' AND rep.locale = ?
         WHERE c.organization_id = ?
         GROUP BY c.id
      `, [candidate.locale, organizationId])
      for (const category of localizedCategories) {
        if (!isArticleCollection(category.collection)) throw new Error(`Category ${category.slug} has no valid collection`)
        entries.push({ loc: `/${candidate.locale}${ARTICLE_COLLECTIONS[category.collection].pathPrefix}` })
        entries.push({ loc: `/${candidate.locale}${collectionCategoryPath(category.collection, category.slug)}`, lastmod: category.lastmod ?? undefined })
      }
      for (const page of pages) {
        const localizedPath = page.path === '/' ? `/${candidate.locale}` : `/${candidate.locale}${page.path}`
        entries.push({ loc: localizedPath, lastmod: page.updated_at })
      }
    }

    const [locations, products, posts, tenantPages, contentRows] = await Promise.all([
      queryAll<ApiRecord>(
        db,
        `SELECT bl.id, bl.slug, bl.updated_at,
                EXISTS (SELECT 1 FROM location_reservation_configs c
                         WHERE c.organization_id = bl.organization_id AND c.location_id = bl.id) AS has_reservations,
                ${publicLocationHomeSlugSql('bl')} AS home_slug
         FROM business_locations bl
         WHERE bl.organization_id = ?
           AND ${publicLocationSql('bl')}`,
        [organizationId],
      ),
      queryAll<ApiRecord>(
        db,
        `SELECT p.id, p.slug, pl.location_id, bl.slug AS location_slug, p.updated_at,
                p.kind
         FROM products p
         LEFT JOIN product_locations pl ON pl.product_id = p.id AND pl.organization_id = p.organization_id AND pl.published = 1
         LEFT JOIN business_locations bl
           ON bl.id = pl.location_id
          AND bl.organization_id = p.organization_id
          AND bl.status = 'active'
         WHERE p.organization_id = ? AND p.id IN (SELECT value FROM json_each(?))
           AND (bl.id IS NOT NULL OR EXISTS (SELECT 1 FROM product_booking_configs bc WHERE bc.product_id = p.id AND bc.organization_id = p.organization_id AND bc.held_online = 1) OR p.order_url IS NOT NULL)
         ORDER BY pl.location_id, p.name, p.id`,
        [organizationId, publicProductIds],
      ),
      listSitemapArticleEntries(db, organizationId, template),
      listPublishedTenantSitemapPages(db, organizationId),
      Promise.all(PUBLIC_CONTENT_SECTIONS.map(async section => [section, await queryAll<PublicContentSectionRow>(db, PUBLIC_CONTENT_SECTION_QUERIES[section], [organizationId])] as const))
        .then(entries => new Map(entries)).then(rows => publicContentSectionRows(section => rows.get(section)!)),
    ])
    // The sections the site's navigation offers, from the same flags.
    const sections = publicSections(organization.vertical, productCatalogRows(publicProducts), contentRows,
      locations.some(location => Number(location.has_reservations) === 1))

    entries.push(...template.sitemap.exactPaths
      .filter(loc => !(loc in SECTION_PATHS) || sections.site[SECTION_PATHS[loc]!])
      .map(loc => ({ loc })))
    for (const item of catalogNavigation(organization.vertical, sections.site)) entries.push({ loc: item.path })
    if (sections.site.reservations) entries.push({ loc: '/reservations' })

    // A location that is one home is listed as that home's page, below.
    const locationPages = locations.filter(location => location.slug && !location.home_slug)
    if (locationPages.length > 0) entries.push({ loc: '/locations' })

    entries.push(
      ...locationPages.map(location => ({ loc: `/locations/${location.slug}`, lastmod: location.updated_at as string | undefined })),
      ...locationPages.flatMap(location => [...new Set(products.filter(product => product.location_id === location.id).map(product => productSurfaceOf(organization.vertical, { kind: product.kind as ProductKind })))]
        .filter(surface => surface !== 'stays')
        .map(surface => ({ loc: locationSurfacePath(String(location.slug), surface), lastmod: location.updated_at as string | undefined }))),
      ...(productPresentation
        ? products
            .filter(product => product.slug && (product.kind === 'experience' || product.kind === 'stay' || product.location_slug))
            .map(product => ({
              loc: presentationForProduct(organization.vertical, { kind: product.kind as ProductKind })
                .productPath(String(product.location_slug ?? ''), String(product.slug)),
              lastmod: product.updated_at as string | undefined,
            }))
        : []),
      ...posts,
      ...tenantPages
        .filter(page => page.path)
        .map(page => ({ loc: page.path as string, lastmod: page.lastmod ?? undefined })),
      ...await socialPostEntries(db, organizationId),
    )

    ctx.urls.length = 0
    addUniqueEntries(ctx.urls, entries)
  })
})
