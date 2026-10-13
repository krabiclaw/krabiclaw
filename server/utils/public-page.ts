import { parseOpeningHours, parseSpecialHours } from '~/shared/reservation-hours'
import { oncePerRequest } from '~/server/utils/request-scope'
import { parseGoogleReviewMetadata } from '~/shared/google-review'
// Canonical route-capability-driven public page service.
//   ?page=home|about|contact|location|reviews|photos|qa|...
//   ?location=slug          scope content to a location
//   ?datasets=content,products   include only the named route capabilities
// All inline D1 queries run in a single executeBatch() call.
import { executeBatch, queryFirst, type BatchQuery } from "~/server/db";
import { HTTPError, type H3Event } from 'nitro';
import {  setHeader } from 'nitro/h3';
import { cloudflareEnv } from "~/server/utils/api-response";
import { calculateMapEmbedUrl } from "~/server/utils/google-places";
import {
  buildPublicReviewAggregate,
  normalizePublicReviewAggregateRows,
} from "~/server/utils/public-review-aggregate";
import { getPublicTenantPageForPath, type PublicTenantPage } from "~/server/utils/public-tenant-pages";
import { listCollections, listOrganizationProducts } from '~/server/utils/product-management'
import { previewSecretOf, resolvePreviewAuthorization } from "~/server/utils/preview-token";
import {
  toResolvedMediaAsset,
  type MediaAsset,
} from "~/server/utils/media-asset-manager";
import { getMediaPlacements } from '~/server/utils/media-placement'
import type { Collection, Product } from '~/server/types/products'
import { COVER_SELECT, attachCoverMedia, coverJoinSql } from "~/server/utils/content/cover";
import { ARTICLE_CATEGORY_SELECT, articleCategoryJoinSql, attachArticleCategory, localizeArticleCategories } from '~/server/utils/content/article-categories'
import { getContentBlocksForDocument } from '~/server/utils/content/documents'
import {
  buildPublicResourceCacheKey,
  getPublicResourceCache,
  putPublicResourceCache,
} from "~/server/utils/public-resource-cache";
import { recordRequestPhase } from "~/server/utils/request-metrics";
import { isNonProductionHost } from "~/server/utils/tenant-hosts";
import { loadPublicBase } from "~/server/utils/public-base";
import { appendPublicShellQueries, buildPublicShellPayload } from "~/server/utils/public-shell-query";
import { isPublicPagePayload } from '~/utils/public-resource-contracts'
import type { LocalizedResourceType } from '~/server/utils/localization-registry'
import { listPublicLocaleRepresentations } from '~/server/utils/public-locale-representations'
import { normalizeVertical } from '~/utils/vertical-copy'
import { resolvePublicTemplate } from '~/utils/template-registry'
import { isPublicSourceRouteRoot } from '~/shared/public-locale-routes'
import { templateRendersPageDocumentAt } from '~/shared/tenant-page-paths'
import { parsePostalAddress } from '~/utils/postal-address'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { assertPublicOrganizationLanguageEntitlement } from '~/server/utils/localization'
import {
  loadExactPublicLocalizations,
  projectExactLocalizedCollection,
  projectExactLocalizedResource,
  projectLocalizedMediaAlt,
  resolveLocalizedRouteResourceId,
  type ExactPublicLocalization,
} from '~/server/utils/public-localization'

interface OrganizationContent {
  id: string
  organization_id: string
  location_id?: string
  page: string
  field: string
  value?: string
  type: string
  source: string
  content?: string
  hero_title?: string | null
  hero_subtitle?: string | null
  media?: Array<{ asset_id: string; slot: string; public_url?: string | null; thumbnail_url?: string | null; kind?: string | null }>
  updated_at: string
}

function groupContentBlocks(rows: OrganizationContent[]): Array<OrganizationContent & { _section: string }> {
  const groups = Object.create(null) as Record<string, OrganizationContent & { _section: string }>
  for (const row of rows) {
    const section = row.field?.split('.')[0] || 'unknown'
    if (!groups[section]) {
      groups[section] = { ...row, field: section, _section: section }
    } else {
      for (const key of Object.keys(row) as Array<keyof OrganizationContent>) {
        if (groups[section][key] == null) (groups[section] as unknown as Record<string, unknown>)[key] = row[key]
      }
    }
  }
  return Object.values(groups)
}

const PUBLIC_PHOTO_CATEGORY: Record<string, string> = {
  exterior: "EXTERIOR",
  interior: "INTERIOR",
  food: "FOOD",
  menu: "MENU",
  team: "TEAM",
  other: "OTHER",
};

// Typed row shapes — column names must match the SELECT exactly
interface ReviewRow {
  id: string;
  author_name: string | null;
  rating: number;
  title: string | null;
  content: string | null;
  owner_reply: string | null;
  owner_reply_at: string | null;
  source: string | null;
  original_review_date: string | null;
  original_reference: string | null;
  google_review_metadata: string | null;
  created_at: string | null;
}





type ProductMediaRow = MediaAsset & { product_id: string; slot: 'image' | 'gallery'; sort_order: number };

interface PublicPageLoadOptions {
  mutateResponseHeaders?: boolean
  signal?: AbortSignal
}

/**
 * The canonical source path of this route, which is what a locale
 * representation is keyed by. Every published locale route has one, whether or
 * not it carries a tenant page document: /menu and /locations render products
 * and locations, and still have /th/menu and /th/locations.
 *
 * Where the *document* lives is a different question, answered per template in
 * utils/template-registry.ts. Collapsing the two is what made /th/menu 404.
 */
function routeSourcePath(page: string | null): string | null {
  if (!page) return null
  if (page === 'home') return '/'
  // A location detail route is its business_locations row, not a page.
  if (page === 'locations') return '/locations'
  if (isPublicSourceRouteRoot(page)) return `/${page}`
  return null
}

function tenantPageToContentRows(page: PublicTenantPage): OrganizationContent[] {
  const rows: OrganizationContent[] = []
  for (const block of page.blocks) {
    const data = block.data
    const field = typeof data.field === 'string' && data.field.trim()
      ? data.field.trim()
      : `${block.type}.${block.position}`
    const base = {
      id: block.id,
      organization_id: '',
      page: page.path === '/' ? 'home' : page.path.slice(1).replaceAll('/', '-'),
      field,
      type: block.type === 'image' || block.type === 'gallery' ? 'media' : 'text',
      source: 'tenant-pages',
      updated_at: page.updated_at,
      media: block.media,
    } satisfies OrganizationContent
    if (block.type === 'hero') {
      rows.push({
        ...base,
        field: 'hero',
        content: typeof data.eyebrow === 'string' ? data.eyebrow : undefined,
        hero_title: typeof data.title === 'string' ? data.title : null,
        hero_subtitle: typeof data.subtitle === 'string' ? data.subtitle : null,
      })
      if (typeof data.eyebrow === 'string' && data.eyebrow.trim()) rows.push({ ...base, field: 'hero.kicker', content: data.eyebrow })
      continue
    }
    if (block.type === 'heading') {
      rows.push({ ...base, field, content: typeof data.text === 'string' ? data.text : undefined })
      continue
    }
    if (block.type === 'markdown') {
      rows.push({ ...base, content: typeof data.markdown === 'string' ? data.markdown : typeof data.content === 'string' ? data.content : undefined })
      continue
    }
    rows.push({ ...base, content: typeof data.title === 'string' ? data.title : undefined })
  }
  return rows
}



async function loadPublicPageSource(
  event: H3Event,
  organizationId: string,
  query: Record<string, string | undefined>,
  options: PublicPageLoadOptions = {},
) {
  options.signal?.throwIfAborted();
  const mutateResponseHeaders = options.mutateResponseHeaders ?? true;
  const env = cloudflareEnv(event);
  const db = env.DB;
  if (!db) throw new HTTPError({ statusCode: 503, statusMessage: "Database unavailable" });

  const isPreviewAuthorized = await resolvePreviewAuthorization(event, organizationId, previewSecretOf(env));
  options.signal?.throwIfAborted();

  if (mutateResponseHeaders) {
    setHeader(
      event,
      "cache-control",
      isPreviewAuthorized
        ? "private, no-store"
        : "public, max-age=60, stale-while-revalidate=300",
    );
  }
  const page = typeof query.page === "string" ? query.page : null;
  const locationSlug =
    typeof query.location === "string" ? query.location : null;
  const requestedDatasets = new Set(
    typeof query.datasets === "string" && query.datasets
      ? query.datasets.split(",")
      : [],
  );
  const includeProducts = requestedDatasets.has('products');
  const blogSlug = typeof query.blogSlug === "string" ? query.blogSlug : null;
  const locale = typeof query.locale === "string" ? query.locale : undefined;

  // Validate query inputs before using KV cache — only allow known-safe values
  // to prevent unbounded cache entries from arbitrary variants.
  const VALID_DATASETS = new Set([
    'content', 'location', 'products', 'reviews', 'photos', 'qa',
    'blogPost', 'reservationPolicies',
  ]);
  // Mirrors composables/usePublicPageRequest.ts's getPublicPageRequest() — the only
  // page values the frontend ever requests. A regex alone (e.g. /^[a-z0-9_-]+$/)
  // would still let an attacker mint unlimited distinct cache keys by varying
  // the page value; allowlisting against the real route set bounds that space.
  const VALID_PAGES = new Set([
    'home', 'locations', 'location', 'about', 'contact', 'reservations',
    'qa', 'reviews', 'posts', 'photos', 'menu', 'products',
    'experiences', 'blog',
  ]);
  const areDatasetsValid = [...requestedDatasets].every(dataset => VALID_DATASETS.has(dataset));
  const isValidLocale = locale === undefined || /^[a-z]{2}(-[A-Z]{2})?$/.test(locale);
  const isValidPage = page === null || VALID_PAGES.has(page);
  // locationSlug/blogSlug can't be allowlisted up front — they're
  // arbitrary per-tenant slugs resolved against D1. The regex here only bounds
  // the character set for a cheap pre-DB shape check; the actual cache *write*
  // below is additionally gated on the slug having resolved to a real row, so
  // slugs that don't correspond to an existing entity never populate the cache.
  const isValidLocation = locationSlug === null || /^[a-z0-9_-]+$/.test(locationSlug);
  const isValidBlogSlug = blogSlug === null || /^[a-z0-9_-]+$/.test(blogSlug);

  const allInputsValid = areDatasetsValid && isValidLocale && isValidPage &&
    isValidLocation && isValidBlogSlug;
  if (!allInputsValid) {
    throw new HTTPError({ statusCode: 400, statusMessage: "Invalid public page query" });
  }

  // Read-through KV cache for the D1 batch below. Skipped for preview-authorized
  // requests (isPreviewAuthorized gates the whole read/write, not just the key —
  // omitting the token from the key alone would let a preview response collide
  // with the public cache entry for the same page/location) and for preview/staging
  // hosts, whose D1 gets reseeded on every CI push —
  // a 60s-old cached response could serve pre-reseed content into a fresh E2E run.
  // Also skipped if any query input is invalid to prevent unbounded cache entries.
  const host = (event.req.headers.get("host")) ?? "";
  const usePageCache = !isPreviewAuthorized && !isNonProductionHost(host) && allInputsValid;
  const cacheKey = buildPublicResourceCacheKey(organizationId, {
    contract: 'page',
    page,
    location: locationSlug,
    datasets: [...requestedDatasets],
    blogSlug,
    locale,
  });
  if (usePageCache) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kv = (env as any).ORGANIZATION_CACHE as KVNamespace | undefined;
    if (kv) {
      const cacheStartedAt = performance.now();
      const cached = await getPublicResourceCache(kv, cacheKey);
      recordRequestPhase(event, "cache", cacheStartedAt);
      options.signal?.throwIfAborted();
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as unknown;
          if (!isPublicPagePayload(parsed, page ?? 'home')) {
            throw new Error("Page cache contract mismatch");
          }
          if (mutateResponseHeaders) setHeader(event, "x-bootstrap-cache", "HIT");
          return parsed;
        } catch (error) {
          await kv.delete(cacheKey);
          throw new HTTPError({ statusCode: 500, statusMessage: "Public page cache is invalid", cause: error });
        }
      }
      if (mutateResponseHeaders) setHeader(event, "x-bootstrap-cache", "MISS");
    } else {
      if (mutateResponseHeaders) setHeader(event, "x-bootstrap-cache", "NO-KV");
    }
  } else {
    if (mutateResponseHeaders) setHeader(event, "x-bootstrap-cache", "SKIP");
  }

  const { organization } = await loadPublicBase(event, organizationId, { previewAuthorized: isPreviewAuthorized });
  options.signal?.throwIfAborted();

  const orgId = organization.id;
  const sourceLocale = await getSourceLocale(db, orgId)
  const language = await assertPublicOrganizationLanguageEntitlement(env, db, orgId, locale ?? sourceLocale)
  const localizedLocale = language.source ? null : language.locale
  let publicLocalizations: ExactPublicLocalization[] = []
  if (localizedLocale) {
    publicLocalizations = await loadExactPublicLocalizations(env, db, orgId, localizedLocale)
  }

  const localizedLocationId = localizedLocale && locationSlug
    ? resolveLocalizedRouteResourceId(publicLocalizations, 'business_location', `/${localizedLocale}/locations/${locationSlug}`)
    : null
  if (localizedLocale && locationSlug && !localizedLocationId) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Localized location was not found' })
  }
  const locationRow = locationSlug
    ? await queryFirst<{ id: string; slug: string }>(
        db,
        localizedLocationId
          ? `SELECT id, slug FROM business_locations WHERE organization_id = ? AND id = ? AND status = 'active' LIMIT 1`
          : `SELECT id, slug FROM business_locations WHERE organization_id = ? AND slug = ? AND status = 'active' LIMIT 1`,
        [organizationId, localizedLocationId ?? locationSlug],
      )
    : null
  const locationId = locationRow?.id;

  const normalizedVertical = normalizeVertical(organization.vertical)
  const localizedBlogPost = localizedLocale && blogSlug ? await queryFirst<{ id: string }>(db,
    `SELECT id FROM content_documents WHERE organization_id = ? AND kind = 'article' AND row_role = 'representation'
      AND locale = ? AND path = ? LIMIT 1`, [organizationId, localizedLocale, '/' + (normalizedVertical === 'service' ? 'article' : 'blog') + '/' + blogSlug]) : null
  const localizedBlogPostId = localizedBlogPost?.id ?? null
  if (localizedLocale && blogSlug && !localizedBlogPostId) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Localized blog post was not found' })
  }

  // Pages that render the sitewide reviews list
  const needsGlobalReviews =
    requestedDatasets.has("reviews") && !locationSlug;
  // Pages that display location hero images (cards or detail header)
  const needsLocations =
    requestedDatasets.has("reviews") ||
    requestedDatasets.has("location") ||
    requestedDatasets.has('products') ||
    requestedDatasets.has("reservationPolicies");

  // Build batch — one subrequest to D1 for all inline queries
  const batchStmts: BatchQuery[] = [];
  let idxLoc = -1;
  let idxReviews = -1,
    idxLocReviews = -1;
  let idxFullReviews = -1,
    idxReviewAggregate = -1,
    idxPhotos = -1,
    idxQa = -1;
  let idxProductMedia = -1;

  let idxBlogPost = -1;

  const push = (q: string, params: unknown[]) => {
    const i = batchStmts.length;
    batchStmts.push({ query: q, params });
    return i;
  };

  const shellIndexes = appendPublicShellQueries(batchStmts, orgId);
  if (needsLocations) idxLoc = shellIndexes.locations;

  if (includeProducts) {
    idxProductMedia = push(
      `SELECT ma.*, mp.owner_id AS product_id, mp.slot, mp.sort_order
         FROM media_placements mp
         JOIN media_assets ma ON ma.id = mp.asset_id
          AND ma.organization_id = mp.organization_id
          AND ma.status = 'active'
        WHERE mp.organization_id = ? 
          AND mp.owner_type = 'product' AND mp.slot IN ('image', 'gallery') AND mp.status = 'active'
        ORDER BY mp.owner_id, mp.slot, mp.sort_order, mp.id`,
      [orgId],
    )
  }


  if (needsGlobalReviews)
    idxReviews = push(
      `SELECT r.id, r.author_name, r.rating, r.content, r.created_at, r.source,
              r.original_review_date, r.original_reference, r.google_review_metadata,
              r.owner_reply, r.owner_reply_at, r.location_id, bl.title AS location_title
       FROM reviews r
       LEFT JOIN business_locations bl ON bl.id = r.location_id
       WHERE r.organization_id = ? AND r.status = 'approved'
       ORDER BY CASE WHEN r.source = 'google_places' THEN r.original_review_date ELSE r.created_at END DESC, r.id ASC LIMIT 50`,
      [organizationId],
    );


  if (locationId && requestedDatasets.has("reviews"))
    idxLocReviews = push(
      `SELECT r.id, r.author_name, r.rating, r.content, r.created_at, r.source, r.original_review_date, r.original_reference, r.google_review_metadata, r.owner_reply, r.owner_reply_at
       FROM reviews r WHERE r.location_id = ? AND r.organization_id = ? AND r.status = 'approved'
       ORDER BY CASE WHEN r.source = 'google_places' THEN r.original_review_date ELSE r.created_at END DESC, r.id ASC LIMIT 3`,
      [locationId, organizationId],
    );

  if (locationId && requestedDatasets.has("reviews"))
    idxFullReviews = push(
      `SELECT r.id, r.author_name, r.rating, r.title, r.content, r.owner_reply, r.owner_reply_at,
              r.source, r.created_at, r.original_review_date, r.original_reference, r.google_review_metadata
       FROM reviews r WHERE r.location_id = ? AND r.organization_id = ? AND r.status = 'approved'
       ORDER BY CASE WHEN r.source = 'google_places' THEN r.original_review_date ELSE r.created_at END DESC, r.id ASC LIMIT 50`,
      [locationId, organizationId],
    );

  if (locationId && requestedDatasets.has("reviews"))
    idxReviewAggregate = push(
      `SELECT rating
       FROM reviews WHERE location_id = ? AND organization_id = ? AND status = 'approved'`,
      [locationId, organizationId],
    );

  if (requestedDatasets.has("photos"))
    idxPhotos = push(
      locationId
        ? `SELECT mp.id AS placement_id, mp.owner_type, mp.owner_id, mp.slot, mp.sort_order, ma.id, ma.public_url, ma.thumbnail_url, ma.kind, ma.alt_text, ma.category, ma.created_at
           FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id
           WHERE mp.organization_id = ? AND mp.owner_type = 'business_location' AND mp.owner_id = ? AND mp.slot = 'gallery' AND mp.status = 'active' AND ma.kind = 'image' AND ma.status = 'active'
           ORDER BY mp.sort_order LIMIT 100`
        : `SELECT mp.id AS placement_id, mp.owner_type, mp.owner_id, mp.slot, mp.sort_order, ma.id, ma.public_url, ma.thumbnail_url, ma.kind, ma.alt_text, ma.category, ma.created_at
           FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id
           WHERE mp.organization_id = ? AND mp.owner_type = 'business_location' AND mp.slot = 'gallery' AND mp.status = 'active' AND ma.kind = 'image' AND ma.status = 'active'
           ORDER BY mp.owner_id, mp.sort_order LIMIT 100`,
      locationId ? [organizationId, locationId] : [organizationId],
    );

  if (requestedDatasets.has("blogPost") && blogSlug)
    idxBlogPost = push(
      `SELECT p.id, root.id AS root_id, root.slug AS source_slug, p.title, p.slug, p.summary AS excerpt, ${ARTICLE_CATEGORY_SELECT}, (p.metadata_json ->> '$.nav_title') AS nav_title, p.seo_keywords,
              root.published_at, p.created_at, p.updated_at,
              ${COVER_SELECT}
       FROM content_documents root JOIN content_documents p ON COALESCE(p.root_id,p.id) = root.id AND p.locale = ?
       ${coverJoinSql('p')}
       ${articleCategoryJoinSql('root')}
       WHERE ${localizedBlogPostId ? 'p.id' : 'p.slug'} = ? AND p.organization_id = ? AND root.row_role = 'root' AND root.kind = 'article' AND root.status = 'published'
       LIMIT 1`,
      [localizedLocale ?? "en", localizedBlogPostId ?? blogSlug, organizationId],
    );

  if (requestedDatasets.has("qa")) idxQa = push(
    `SELECT p.id, root.location_id, p.title AS question, p.summary AS answer,
      (root.metadata_json ->> '$.question_author') AS question_author, (root.metadata_json ->> '$.question_date') AS question_date,
      (root.metadata_json ->> '$.answer_author') AS answer_author, (root.metadata_json ->> '$.answer_date') AS answer_date,
      (root.metadata_json ->> '$.is_owner_answer') AS is_owner_answer, (root.metadata_json ->> '$.upvote_count') AS upvote_count,
      p.created_at, p.updated_at FROM content_documents root
      JOIN content_documents p ON COALESCE(p.root_id,p.id) = root.id AND p.locale = ?
      WHERE root.kind = 'qa' AND root.row_role = 'root' AND root.status = 'published' AND root.organization_id = ?
        AND ${locationId ? 'root.location_id = ?' : 'root.scope_path IS NULL'}
      ORDER BY is_owner_answer DESC, upvote_count DESC, root.sort_order, p.created_at`,
    [localizedLocale ?? 'en', organizationId, ...(locationId ? [locationId] : [])],
  );

  // Single D1 round trip
  options.signal?.throwIfAborted();
  const batchResults = batchStmts.length > 0
    ? await executeBatch(db, batchStmts)
    : [];
  options.signal?.throwIfAborted();

  // Extract batch results by tracked index
  const locRows = idxLoc >= 0
    ? batchResults[idxLoc] as { results: Record<string, unknown>[] }
    : { results: [] as Record<string, unknown>[] };
  const reviewRows =
    idxReviews >= 0
      ? (batchResults[idxReviews] as { results: Record<string, unknown>[] })
      : { results: [] as Record<string, unknown>[] };
  const locationReviewRows =
    idxLocReviews >= 0
      ? (batchResults[idxLocReviews] as { results: Record<string, unknown>[] })
      : { results: [] as Record<string, unknown>[] };
  const fullReviewRows =
    idxFullReviews >= 0
      ? (batchResults[idxFullReviews] as { results: ReviewRow[] })
      : { results: [] as ReviewRow[] };
  const reviewAggregateRows =
    idxReviewAggregate >= 0
      ? (batchResults[idxReviewAggregate] as { results: Array<{ rating: number | string | null }> })
      : { results: [] as Array<{ rating: number | string | null }> };
  const photoRows =
    idxPhotos >= 0
      ? (batchResults[idxPhotos] as { results: Record<string, unknown>[] })
      : { results: [] as Record<string, unknown>[] };
  const qaRows =
    idxQa >= 0
      ? (batchResults[idxQa] as { results: Record<string, unknown>[] })
      : { results: [] as Record<string, unknown>[] };
  const routePagePath = routeSourcePath(page)
  // Which paths carry a tenant page document is declared once, per template.
  const template = resolvePublicTemplate({ themeId: organization.theme_id, vertical: organization.vertical })
  const locationDocumentPath = locationRow && page === 'location'
    ? `/locations/${locationRow.slug}`
    : null
  const documentPath = locationDocumentPath && templateRendersPageDocumentAt(template, locationDocumentPath)
    ? locationDocumentPath
    : page ? template.pageDocuments.recipes[page] ?? null
    : null
  const contentPagePath = requestedDatasets.has('content') ? documentPath : null
  const tenantPageOptions = {
    locale,
    preview: isPreviewAuthorized,
    localizations: localizedLocale ? publicLocalizations : null,
  }
  // One page, one read. The home route used to read the About page as well, to
  // pull a story teaser out of it; the home document carries its own
  // image-with-text block now, so the extra D1 round trip on every home
  // request is gone with it.
  const tenantPage = contentPagePath
    ? await getPublicTenantPageForPath(env, db, organizationId, contentPagePath, tenantPageOptions)
    : null
  // These complete built-in routes may display an optional CMS content overlay.
  // The route remains valid when that optional overlay has no translated page.
  const allowsMissingLocalizedTenantPage = page === 'location' || page === 'contact'
    || page === 'reservations'
  if (contentPagePath && !tenantPage && locale && locale !== sourceLocale && !isPreviewAuthorized && !allowsMissingLocalizedTenantPage) {
    throw new HTTPError({ statusCode: 404, statusMessage: 'Localized page was not found' })
  }
  const contentRows: OrganizationContent[] = tenantPage ? tenantPageToContentRows(tenantPage) : []

  const postRow = idxBlogPost >= 0
    ? (batchResults[idxBlogPost] as { results: ApiRecord[] })?.results?.[0]
    : undefined
  if (postRow && (typeof postRow.id !== 'string' || typeof postRow.slug !== 'string')) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'Stored public blog post is invalid' })
  }
  const sourceLocationRow = locationId
    ? (locRows.results ?? []).find(row => row.id === locationId)
    : null
  const sourceLocationSlug = typeof sourceLocationRow?.slug === 'string' ? sourceLocationRow.slug : null
  let representationSourcePath = routePagePath ?? '/'
  let representationDocumentId: string | undefined
  let representationResource: { type: LocalizedResourceType; id: string; routeSuffix?: string } | undefined
  if (postRow) {
    const prefix = normalizedVertical === 'service' ? 'article' : 'blog'
    representationSourcePath = `/${prefix}/${String(postRow.source_slug)}`
    representationDocumentId = String(postRow.root_id)
  } else if (locationId && sourceLocationSlug) {
    const routeSuffix = page && page !== 'location' ? `/${page}` : ''
    representationSourcePath = `/locations/${sourceLocationSlug}${routeSuffix}`
    representationResource = { type: 'business_location', id: locationId, routeSuffix }
  }
  // These canonical reads depend on the resolved tenant and locale, not on
  // one another. Serial D1 round trips made a full menu exceed the public
  // request deadline even though its SQL completed quickly.
  const [sourceShell, canonical, sourceCollections, localeRepresentations] = await Promise.all([
    buildPublicShellPayload(db, organization, batchResults, shellIndexes, env),
    includeProducts
      ? listOrganizationProducts(db, { organizationId: orgId, kind: page === 'experiences' ? 'experience' : page === 'menu' ? 'dish' : undefined, publishedOnly: true, env })
      : [],
    includeProducts
      ? locationId
        ? Promise.all([
            listCollections(db, { organizationId: orgId, locationId: null }),
            listCollections(db, { organizationId: orgId, locationId }),
          ]).then(collections => collections.flat())
        : listCollections(db, { organizationId: orgId })
      : [],
    !representationResource && tenantPage?.localeRepresentations
      ? tenantPage.localeRepresentations
      : listPublicLocaleRepresentations(env, db, {
          organizationId: orgId,
          sourcePath: representationSourcePath,
          resource: representationResource,
          documentId: representationDocumentId,
          publishedLocaleRoute: !representationResource && !representationDocumentId && Boolean(routePagePath),
        }),
  ])
  options.signal?.throwIfAborted()
  sourceShell.platformMessages = language.platform_messages
  const shell = (() => {
    if (!localizedLocale) return sourceShell
    const organizationLocalization = publicLocalizations.find(item => item.resourceType === 'organization' && item.resourceId === organizationId)
    const localizedOrganization = organizationLocalization
      ? projectExactLocalizedResource('organization', organization, organizationLocalization)
      : { ...organization, name: null, brand_description: null, seo_title: null, seo_description: null }
    const locations = projectExactLocalizedCollection('business_location', sourceShell.locations, publicLocalizations)
    const {
      name: _sourceBrandName,
      brand_description: _sourceBrandDescription,
      seo_title: _sourceSeoTitle,
      seo_description: _sourceSeoDescription,
      ...config
    } = sourceShell.config
    if (localizedOrganization.name) {
      config.name = localizedOrganization.name
      config.seo_title = localizedOrganization.name
    }
    if (localizedOrganization.brand_description) {
      config.brand_description = localizedOrganization.brand_description
      config.seo_description = localizedOrganization.brand_description
    }
    return {
      ...sourceShell,
      organization: {
        ...sourceShell.organization,
        name: localizedOrganization.name,
        brand_description: localizedOrganization.brand_description,
      },
      locations,
      config,
      googleMaps: {
        ...sourceShell.googleMaps,
        business: null,
      },
    }
  })()

  let products: Product[] = []
  let collections: Collection[] = sourceCollections
  if (includeProducts) {
    const locationCapabilityRows = (batchResults[shellIndexes.locations] as { results: Record<string, unknown>[] })?.results ?? []
    const activeLocationIds = new Set(locationCapabilityRows.map(location => String(location.id)))
    const productMediaRows = (batchResults[idxProductMedia] as { results: ProductMediaRow[] })?.results ?? []
    const mediaByProduct = new Map<string, ProductMediaRow[]>()
    for (const row of productMediaRows) {
      const rows = mediaByProduct.get(row.product_id) ?? []
      rows.push(row)
      mediaByProduct.set(row.product_id, rows)
    }
    // One canonical read, hydrated in a single batch. This page does not
    // reassemble variants, prices and collections from its own SQL — the
    // catalog has one reader and a projection that disagreed with it is
    // exactly the drift this replaces.
    products = canonical.filter(product => product.locations.some(location => location.published
      && activeLocationIds.has(location.location_id) && (!locationSlug || location.location_id === locationId))
      || (!locationSlug && Boolean(product.order_url || product.booking?.held_online))).map((product) => {
      const media = mediaByProduct.get(product.id) ?? []
      const image = media.find(item => item.slot === 'image')
      return {
        ...product,
        image: image ? toResolvedMediaAsset(image) : null,
        gallery: media.filter(item => item.slot === 'gallery').map(toResolvedMediaAsset),
      }
    })
    // Collections are the site's merchandising order, which is what the
    // public grouping renders. A page with products and no collections shows
    // no groups rather than inventing one. A location page shows the site's
    // own collections and that location's — never another branch's, which a
    // Product offered at both would otherwise drag onto the page.
    if (localizedLocale) {
      collections = projectExactLocalizedCollection('collection', collections, publicLocalizations)
      products = projectExactLocalizedCollection('product', products, publicLocalizations).map(product => ({
        ...product,
        image: product.image ? projectLocalizedMediaAlt([product.image], publicLocalizations)[0] ?? null : null,
        gallery: projectLocalizedMediaAlt(product.gallery, publicLocalizations),
      }))
    }
  }



  // Shape locations
  const locations = (locRows.results ?? []).map((loc) => {
    const publicUrl = loc.media_public_url as string | null;

    const address = parsePostalAddress(loc.address)
    const openingHours = loc.opening_hours as string | null
    const specialHours = loc.special_hours as string | null
    return {
      id: loc.id,
      slug: loc.slug,
      title: loc.title,
      address,
      phone: loc.phone,
      email: (loc.email as string | null) ?? null,
      website_url: loc.website_url,
      maps_url: loc.maps_url,
      map_embed_url: calculateMapEmbedUrl({
        title: loc.title as string,
        maps_url: loc.maps_url as string | null,
        latitude: loc.latitude as number | null,
        longitude: loc.longitude as number | null,
        address,
      }),
      latitude: loc.latitude,
      longitude: loc.longitude,
      opening_hours: parseOpeningHours(openingHours ? JSON.parse(openingHours) : null),
      special_hours: parseSpecialHours(specialHours ? JSON.parse(specialHours) : null),
      timezone: loc.timezone,
      rating: loc.rating,
      review_count: loc.review_count,
      status: loc.status,
      media: publicUrl ? [{
        asset_id: loc.asset_id,
        slot: 'hero',
        public_url: publicUrl,
        thumbnail_url: loc.media_thumbnail_url,
        kind: loc.media_kind,
      }] : [],
      short_description: loc.short_description || null,
      description: loc.description || null,
      seo_title: (loc.seo_title as string | null) ?? null,
      seo_description: (loc.seo_description as string | null) ?? null,
      canonical_url: (loc.canonical_url as string | null) ?? null,
      robots: (loc.robots as string | null) ?? null,
    };
  });

  const needsReservationPolicies = requestedDatasets.has('reservationPolicies');
  if (needsReservationPolicies && !locale && !sourceLocale) {
    throw new HTTPError({
      statusCode: 500,
      statusMessage: 'Organization source locale is not configured',
    });
  }
  options.signal?.throwIfAborted();
  // Reservation policy is a location's own typed row. A product's booking
  // terms are its details and are read with the product, so there is no
  // second policy index to resolve here.
  const reservationPolicies = needsReservationPolicies
    ? new Map(await Promise.all(locations.map(async location => [
        String(location.id),
        await getLocationReservationConfig(db, { organizationId: orgId, locationId: String(location.id) }),
      ] as const)))
    : null
  options.signal?.throwIfAborted();
  const policyLocale = locale ?? sourceLocale!;
  // One localized field, from one place: the location's own translation. The
  // old resolver had to guess which of three scopes a rendered rule came from
  // before it could find the right translation for it.
  const localizeReservationNotes = (locationId: string, config: LocationReservationConfig): LocationReservationConfig => {
    if (!localizedLocale) return config
    const localized = publicLocalizations.find(item => item.resourceType === 'business_location' && item.resourceId === locationId)
    const values = localized?.values as { reservation?: { policy?: { additional_notes_html?: string } } } | undefined
    return { ...config, additional_notes_html: values?.reservation?.policy?.additional_notes_html ?? null }
  }
  const reservationPolicyByLocation = Object.fromEntries(
    Array.from(reservationPolicies ?? [], ([locationId, config]) => [
      locationId,
      config ? renderBookingPolicySummary(reservationPolicySummarySource(localizeReservationNotes(locationId, config)), policyLocale) : null,
    ]),
  );

  // Shape full reviews (type A)
  const locationForAggregate = locationId
    ? ((locRows.results ?? []).find((l) => l.id === locationId) ?? null)
    : null;
  const fullReviewList = fullReviewRows?.results ?? []
  const reviewMedia = await getMediaPlacements(db, { organizationId, ownerType: 'review', ownerIds: fullReviewList.map(review => String(review.id)) })
  const fullReviews = fullReviewList.map(r => ({ ...r, google_review_metadata: parseGoogleReviewMetadata(r.google_review_metadata), media: reviewMedia.get(String(r.id)) ?? [] }));
  const aggregateLocation = locationForAggregate ? {
    rating: typeof locationForAggregate.rating === 'number' ? locationForAggregate.rating : null,
    review_count: typeof locationForAggregate.review_count === 'number' ? locationForAggregate.review_count : null,
    last_synced_at: typeof locationForAggregate.last_synced_at === 'string' ? locationForAggregate.last_synced_at : null,
  } : {
    rating: null,
    review_count: null,
    last_synced_at: null,
  };
  const reviewsAggregate = buildPublicReviewAggregate(
    normalizePublicReviewAggregateRows(reviewAggregateRows.results),
    aggregateLocation,
  );

  // Shape photos (type E)
  const sourceMedia = (photoRows?.results ?? []).map((asset) => {
    if (typeof asset.id !== 'string' || (asset.alt_text !== null && typeof asset.alt_text !== 'string')) {
      throw new HTTPError({ statusCode: 500, statusMessage: 'Stored public media is invalid' })
    }
    return {
      placement_id: asset.placement_id,
      owner_type: asset.owner_type,
      owner_id: asset.owner_id,
      slot: asset.slot,
      asset_id: asset.id,
      public_url: asset.public_url,
      thumbnail_url: asset.thumbnail_url,
      kind: asset.kind,
      alt_text: asset.alt_text,
      category: PUBLIC_PHOTO_CATEGORY[String(asset.category || "other")] ?? "OTHER",
      sort_order: asset.sort_order,
    }
  });
  const media = localizedLocale
    ? projectLocalizedMediaAlt(sourceMedia, publicLocalizations)
    : sourceMedia

  let blogPost: ApiRecord | null = null;
  if (postRow) {
    options.signal?.throwIfAborted();
    const loadedBlocks = await getContentBlocksForDocument(db, String(postRow.id));
    const contentBlocks = loadedBlocks
      ? await attachPageQa(db, organizationId, tenantBlogPostPath({ themeId: organization.theme_id, vertical: organization.vertical }, String(postRow.source_slug)), loadedBlocks, localizedLocale ?? 'en')
      : loadedBlocks
    blogPost = (await localizeArticleCategories(env, db, orgId, localizedLocale ?? 'en',
      [attachArticleCategory(attachCoverMedia({ ...postRow, content_blocks: contentBlocks }))], publicLocalizations))[0]!;
  }

  const sourceQaList = (requestedDatasets.has("qa") ? qaRows?.results ?? [] : []).map((row) => {
    if (typeof row.id !== 'string') throw new HTTPError({ statusCode: 500, statusMessage: 'Stored public Q&A is invalid' })
    return { ...row, id: row.id }
  })
  const qaList = sourceQaList

  const pagePayload = {
    kind: page ?? 'home',
    success: true,
    shell,
    content: contentRows,
    content_blocks: groupContentBlocks(contentRows),
    tenant_page: tenantPage,
    products,
    collections,
    locationReviews: (locationReviewRows?.results ?? []).map(review => ({ ...review, google_review_metadata: parseGoogleReviewMetadata(review.google_review_metadata) })),
    globalReviews: needsGlobalReviews ? (reviewRows.results ?? []).map(review => ({ ...review, google_review_metadata: parseGoogleReviewMetadata(review.google_review_metadata) })) : [],
    reviewsAggregate: requestedDatasets.has("reviews") ? reviewsAggregate : null,
    reviewsList: requestedDatasets.has("reviews") ? fullReviews : [],
    media: requestedDatasets.has("photos") ? media : [],
    qaList,
    blogPost: requestedDatasets.has("blogPost") ? blogPost : null,
    reservationPolicyByLocation,
    localeRepresentations,
  };
  const payload = pagePayload;

  // Slug-shaped inputs are only worth caching once they've resolved to a real
  // row — otherwise a stream of made-up slugs (still regex-valid) would each
  // mint their own permanent KV entry. locationRow/blogPost are the actual
  // D1-resolved lookups for locationSlug/blogSlug.
  const resolvedSlugsValid =
    (!locationSlug || !!locationRow) &&
    (!blogSlug || !!blogPost);

  if (usePageCache && resolvedSlugsValid) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kv = (env as any).ORGANIZATION_CACHE as KVNamespace | undefined;
    if (kv) {
      await putPublicResourceCache(kv, cacheKey, JSON.stringify(payload));
    }
  }

  return payload;
}

export const loadPublicPage = (
  event: H3Event,
  organizationId: string,
  query: Record<string, string | undefined>,
  options?: PublicPageLoadOptions,
) => {
  if (options?.signal) {
    const startedAt = performance.now();
    return loadPublicPageSource(event, organizationId, query, options)
      .finally(() => recordRequestPhase(event, "page", startedAt));
  }
  const queryKey = JSON.stringify(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  // The flag is part of the key because it changes what the call does to the
  // response, not just what it returns: a memo shared across two callers that
  // disagree about it would let the first one's header behaviour stand for both,
  // including the `private, no-store` a preview-authorized response needs.
  const headerKey = options?.mutateResponseHeaders === false ? 'no-headers' : 'headers'
  return oncePerRequest(event, `public-page:${organizationId}:${headerKey}:${queryKey}`, () => {
    const startedAt = performance.now();
    return loadPublicPageSource(event, organizationId, query, options)
      .finally(() => recordRequestPhase(event, "page", startedAt));
  });
};
