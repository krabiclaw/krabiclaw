import { prepareOrganizationLanguageSettings } from '~/server/utils/organization-languages'
import { organizationDomainsDashboardPayload, prepareOrganizationDomains } from '~/server/utils/domain-read-model'
import { prepareDashboardLocationOverview, prepareDashboardProductRead } from '~/server/utils/dashboard-editor-resources'
import { PUBLIC_CACHE_REVISION_SQL, publicCacheRevision } from '~/server/utils/edge-cache'
// Tenant resolution middleware: every host, Blawby's own included, resolves
// to an organization. The organization's site decides whether it renders as
// the platform (marketing, docs, blog) or as a customer site.

import { HTTPError, defineHandler  } from 'nitro';
import type { H3Event } from 'nitro';
import { getCookie, getQuery, redirect, setResponseHeader } from 'nitro/h3';
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from "~/server/db";
import { TENANT_TYPES } from "~/utils/tenant-routing";
import { cloudflareEnv, isInternalSelfFetch, readRequiredBody } from "../utils/api-response";
import {
  BLAWBY_FREE_SITE_HOST, environmentTenantAliasSlug, isNonProductionHost, LEGACY_FREE_SITE_HOST, normalizeHost,
  hostnameOf,
  isPlatformHost,
  usesTenantHeader,
} from "../utils/tenant-hosts";
import { clearPreviewAuthorization, previewSecretOf, PREVIEW_COOKIE_NAME, PREVIEW_TOKEN_QUERY, PUBLIC_WEBSITE_QUERY, resolvePreviewAuthorization } from "../utils/preview-token";
import { PLATFORM_SITE, resolvePublicSite } from "~/utils/site-routing";
import { organizationSocialMediaFromJson } from '~/server/utils/public-social-image'
import { resolveOrganizationFontPreset } from '~/shared/organization-fonts'
import { parseSitePalette, resolveSitePalette } from '~/shared/site-palette'
import { parseSiteRecipe } from '~/shared/site-recipe'
import { LOGO_SLOTS, ORIGINAL_LOGO_PRESENTATION, parseLogoPresentation, type SiteLogo } from '~/shared/media-placement-contract'
import { publicTenantPageSql } from '~/server/utils/content/pages'
import { buildLoginUrl } from '~/shared/auth/return-target'
import { BROWSER_ERROR_PATH } from '~/shared/error-telemetry'
import { dashboardSessionUserQuery, getAuthSession, type DashboardAuthRead } from '~/server/utils/auth'
import { dashboardOrganizationFrom, getDashboardSession, prepareDashboardLocations, readDashboardMembership } from '~/server/utils/dashboard-context'
import { prepareDashboardWorkspaceAccess, readDashboardWorkspaceAccess } from '~/server/utils/dashboard-context-service'
import { membershipBySlugQuery, BATCH_VIEWER, withViewer } from '~/server/utils/member-access'
import { prepareToday } from '~/server/domain/today'
import { staffAccessWritesEnabled } from '~/server/domain/listing-access'
import { readDashboardTodayDocument } from '~/server/utils/dashboard-today'
import { readPublicSourceLocale, sourceLocaleQuery } from '~/server/utils/localization'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import { calendarCoverageQuery } from '~/server/domain/member-scheduling'
import { calendarConnectionQuery, calendarSettingsFromRows, readCalendarSettingsDocument } from '~/server/utils/google-calendar'
import { prepareTenantPageEditor, websiteEditorOrganization } from '~/server/utils/tenant-pages-api'
import { prepareConnectionSummary, prepareWebsiteSettings } from '~/server/utils/organization-settings'
import { prepareOrganizationReviews } from '~/server/utils/organization-reviews'
import { preparePublicLocationDocument } from '~/server/utils/public-route'
import { preparePublicAuthoredPage } from '~/server/utils/public-tenant-pages'
import { preparePublicInquiryForm } from '~/server/domain/form-questions'
import { isDocumentOnlyPublicPath } from '~/shared/public-locale-routes'
import { blogPostCategoriesQuery, prepareBlogList, prepareBlogPost } from '~/server/utils/content/publishing'
import { articleCategoriesQuery, readArticleCategories } from '~/server/utils/content/article-categories'
import { isArticleCollection } from '~/utils/article-collections'
import { dashboardOrigin } from '~/server/utils/dashboard-notification-links'
import { prepareSocialConnections, presentSocialConnections } from '~/server/utils/social-publication'
import { preparePost, preparePostList } from '~/server/utils/post-management'
import { mcpPageWindow } from '~/server/utils/mcp-pagination'
import { prepareDashboardQa } from '~/server/utils/location-qa'
import { dashboardLocationSlug, dashboardProductId, rendersWebsiteDocument, websiteBlogPost, websitePageVariant, websiteQuestion, websiteSocialPost } from '~/utils/dashboard-document'
import { readDashboardConnectionsDocument } from '~/server/utils/dashboard-connections'
import { prepareDashboardCatalog, readDashboardCatalogDocument } from '~/server/utils/dashboard-catalog'
import { setDashboardSocketScope } from '~/server/utils/dashboard-socket-scope'
import { prepareDashboardBookingRead, readDashboardBookingDocument } from '~/server/utils/dashboard-bookings'
import { publicBaseColumns, seedPublicBase, type PublicBase } from '~/server/utils/public-base'
import { placesPresenceQuery } from '~/server/domain/places'
import { prepareDashboardAgendaDocument } from '~/server/utils/dashboard-agenda-reader'
import { isValidCalendarDate } from '~/utils/timezone'
import { parseDate } from '@internationalized/date'
import { prepareDashboardEarningsDocument } from '~/server/utils/dashboard-earnings'
import { PUBLIC_CONFIG_COLUMNS, type PublicConfigRow } from '~/server/utils/organization-config'
import { publicTenantRedirectQuery, type PublicTenantRedirect } from '~/server/utils/public-redirects'
import { prepareBookingCreation, preparePublicTimedQuote, timedBookingConversationId, type PublicTimedQuoteRead } from '~/server/domain/product-bookings'
import { preparePublicProductAvailability, type PublicAvailabilityRead } from '~/server/utils/public-session-booking'
import { preparePaymentHandoff, preparePaymentReturn } from '~/server/domain/payments/intent'
import { prepareGuestBookingReceipt, type GuestReceiptRead } from '~/server/utils/guest-booking-receipt'
import { readBearerToken } from '~/server/utils/reservation-cancel-token'
import { splitLocalePrefix } from '~/utils/tenant-locale-path'
import { platformLocale } from '~/shared/platform-locales'
import { publicLocalizationsQuery, type StoredPublicLocalizationRow } from '~/server/utils/public-localization'
import { preparePublicShellRows, publicDocumentCollectionKind, type PublicDocumentShell } from '~/server/utils/public-shell-query'
import { isRecord } from '~/server/utils/type-guards'
import { openPaymentReturnDocument, paymentReturnDocumentGuard, sealPaymentReturnDocument, type AuthorizedPaymentReturnDocument } from '~/server/utils/payment-return-document'

interface TenantRow extends Omit<PublicBase['organization'], 'theme_id' | 'name'>, Omit<PublicConfigRow, 'default_currency'> {
  id: string;
  public_cache_revision: string | null;
  theme_id: string | null;
  subdomain: string;
  status: string;
  onboarding_status: string;
  canonical_domain: string | null;
  name: string;
  brand_description: string | null;
  media_json: string;
  vertical: string | null;
  timezone: string;
  facebook_page_id: string | null;
  instagram_username: string | null;
  privacy_policy: number;
  terms_policy: number;
  acceptable_use_policy: number;
  font_preset: unknown;
  font_preset_type: string | null;
  palette: string | null;
  button_shape: string | null;
  button_casing: string | null;
  button_color: string | null;
  heading_casing: string | null;
  source_locale_rows: string;
  published_locales: string;
  has_payment_account: number;
  redirect_json?: string | null;
}

const TENANT_MEDIA_SELECT_SQL = `(SELECT COALESCE(json_group_array(json_object(
  'asset_id', ordered.asset_id, 'slot', ordered.slot, 'public_url', ordered.public_url,
  'thumbnail_url', ordered.thumbnail_url, 'kind', ordered.kind, 'mime_type', ordered.mime_type,
  'width', ordered.width, 'height', ordered.height, 'presentation', json(ordered.presentation_json)
)), json('[]')) FROM (
  SELECT mp.asset_id, mp.slot, ma.public_url, ma.thumbnail_url, ma.kind, ma.mime_type, ma.width, ma.height, mp.presentation_json, mp.id
  FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id AND ma.status = 'active'
  WHERE mp.organization_id = o.id AND mp.owner_type = 'organization' AND mp.owner_id = o.id AND mp.status = 'active'
  ORDER BY mp.slot, mp.sort_order, mp.id
) ordered)`

const TENANT_SELECT_SQL = `SELECT ${publicBaseColumns('o')},
             ${PUBLIC_CACHE_REVISION_SQL} AS public_cache_revision, o.subdomain, o.status, o.onboarding_status,
             ${TENANT_MEDIA_SELECT_SQL} AS media_json, o.timezone,
             EXISTS (SELECT 1 FROM stripe_connected_accounts account WHERE account.organization_id = o.id
               AND account.stripe_account_id IS NOT NULL) AS has_payment_account,
             (SELECT json_group_array(json_object('id', src.id, 'organization_id', src.organization_id,
               'locale', src.locale, 'label', src.label, 'is_source', src.is_source, 'status', src.status,
               'created_at', src.created_at, 'updated_at', src.updated_at))
               FROM (${sourceLocaleQuery({ sql: 'o.id' }).query}) src) AS source_locale_rows,
             (SELECT json_group_array(locale) FROM (SELECT locale FROM organization_locales
               WHERE organization_id = o.id AND is_source = 0 AND status = 'published' ORDER BY locale)) AS published_locales,
             (SELECT i.target_id FROM organization_integrations i WHERE i.organization_id = o.id AND i.provider = 'facebook') AS facebook_page_id,
             (SELECT i.target_name FROM organization_integrations i WHERE i.organization_id = o.id AND i.provider = 'instagram') AS instagram_username,
             EXISTS (SELECT 1 FROM content_documents d WHERE d.organization_id = o.id AND d.kind = 'page' AND d.row_role = 'root' AND d.path = '/policies/privacy' AND ${publicTenantPageSql('d')}) AS privacy_policy,
             EXISTS (SELECT 1 FROM content_documents d WHERE d.organization_id = o.id AND d.kind = 'page' AND d.row_role = 'root' AND d.path = '/policies/terms' AND ${publicTenantPageSql('d')}) AS terms_policy,
             EXISTS (SELECT 1 FROM content_documents d WHERE d.organization_id = o.id AND d.kind = 'page' AND d.row_role = 'root' AND d.path = '/policies/acceptable-use' AND ${publicTenantPageSql('d')}) AS acceptable_use_policy,
             ${PUBLIC_CONFIG_COLUMNS}`

function authoredDocumentPath(path: string) {
  return /^\/(?:about|contact|schedule|policies\/(?:privacy|terms|acceptable-use))?$/.test(path) ? path : null
}

function tenantSelectFor(event: H3Event) {
  const path = normalizedPath(event.url.pathname)
  const sourcePath = splitLocalePrefix(path).sourcePath
  const document = authoredDocumentPath(sourcePath) || isDocumentOnlyPublicPath(sourcePath)
    || /^\/(?:[A-Za-z-]+\/)?(?:reservations|pay\/[^/]+|bookings\/(?:confirmed|stay))$/.test(path)
  if (!['GET', 'HEAD'].includes(event.method) || !document) {
    return { query: TENANT_SELECT_SQL, params: [] }
  }
  const redirect = publicTenantRedirectQuery({ sql: 'o.id' }, path)
  return { query: `${TENANT_SELECT_SQL}, (SELECT json_object('toPath', toPath, 'statusCode', statusCode, 'behavior', behavior)
    FROM (${redirect.query})) AS redirect_json`, params: redirect.params }
}

async function readTenantFromHost(event: H3Event, db: DbClient, canonicalDomain: string, selection: string, parameters: string[]) {
  const read = tenantSelectFor(event)
  const host = { query: `${read.query}, ${canonicalDomain} AS canonical_domain ${selection} LIMIT 1`, params: [...read.params, ...parameters] }
  if (event.url.searchParams.has(PREVIEW_TOKEN_QUERY) || getCookie(event, PREVIEW_COOKIE_NAME)) {
    return queryFirst<TenantRow>(db, host.query, host.params)
  }

  const authorized = { query: `SELECT o.id ${selection}
    AND o.status = 'active' AND o.onboarding_status = 'active' LIMIT 1`, params: parameters }
  const tenantScope = { query: `(${authorized.query})`, params: authorized.params }
  const path = normalizedPath(event.url.pathname)
  if (event.method === 'POST') {
    const bookingSlug = /^\/api\/public\/products\/([a-zA-Z0-9_-]+)\/book$/.exec(path)?.[1]
    const returnPaymentId = /^\/api\/public\/payments\/([a-f0-9-]+)\/return$/.exec(path)?.[1]
    if (bookingSlug || returnPaymentId) {
      let body: Record<string, unknown>
      try {
        const value = await readRequiredBody<unknown>(event)
        if (!isRecord(value)) throw new HTTPError({ statusCode: 400, message: 'Invalid request body' })
        body = value
      } catch (error) {
        event.context.checkoutBodyError = error
        return queryFirst<TenantRow>(db, host.query, host.params)
      }
      event.context.checkoutBody = body
      if (bookingSlug) {
        const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : ''
        const organizationId = typeof body.organization_id === 'string' && body.organization_id.length <= 200 ? body.organization_id : ''
        const replay = organizationId && idempotencyKey.length > 0 && idempotencyKey.length <= 200
          ? { organizationId, threadId: await timedBookingConversationId(organizationId, idempotencyKey) } : undefined
        const plan = prepareBookingCreation(tenantScope, { slug: bookingSlug, body, idempotencyKey, replay }, null, false)
        const [hostRows, ...rows] = await executeBatch(db, [host, ...plan.queries], { operation: 'Read public booking creation facts' })
        const tenant = hostRows?.results[0] as TenantRow | undefined
        if (tenant?.status === 'active' && tenant.onboarding_status === 'active') {
          event.context.bookingCreation = { slug: bookingSlug, facts: plan.read(rows) }
        }
        return tenant ?? null
      }
      if (returnPaymentId && typeof body.claim === 'string') {
        if (typeof body.receipt_context === 'string') {
          const env = cloudflareEnv(event)
          const document = await openPaymentReturnDocument(env.BETTER_AUTH_SECRET, event.url.host, returnPaymentId, body.claim, body.receipt_context)
          if (document && document.language.locale === body.locale) {
            const session = await getAuthSession(event, env)
            if (session?.user.id === document.payment.buyer_user_id) {
              event.context.authorizedPaymentReturn = { ...document, userId: session.user.id,
                guard: paymentReturnDocumentGuard(authorized, document) } satisfies AuthorizedPaymentReturnDocument
              return null
            }
          }
        }
        const plan = await preparePaymentReturn(tenantScope, returnPaymentId, body.claim)
        const [hostRows, paymentRows] = await executeBatch(db, [host, plan], { operation: 'Read public payment return' })
        const tenant = hostRows?.results[0] as TenantRow | undefined
        if (tenant?.status === 'active' && tenant.onboarding_status === 'active') {
          event.context.paymentReturn = { paymentId: returnPaymentId, plan, row: paymentRows?.results[0] }
        }
        return tenant ?? null
      }
    }
  }
  if (event.method !== 'GET') return queryFirst<TenantRow>(db, host.query, host.params)

  const paymentId = /^\/api\/public\/payments\/([a-f0-9-]+)$/.exec(path)?.[1]
  const claim = getQuery(event).claim
  if (paymentId && typeof claim === 'string') {
    const plan = await preparePaymentHandoff(tenantScope, paymentId, claim)
    const [hostRows, paymentRows] = await executeBatch(db, [host, plan], { operation: 'Read checkout handoff' })
    const tenant = hostRows?.results[0] as TenantRow | undefined
    if (tenant?.status === 'active' && tenant.onboarding_status === 'active') {
      event.context.paymentHandoff = { paymentId, plan, row: paymentRows?.results[0] }
    }
    return tenant ?? null
  }
  const receiptPath = /^\/api\/public\/booking-requests\/((?:[a-zA-Z0-9_:-]|%3[aA])+)$/.exec(path)?.[1]
  const token = receiptPath && readBearerToken(event.req.headers.get('authorization'))
  if (receiptPath && token) {
    const requestId = decodeURIComponent(receiptPath)
    const queryLocale = getQuery(event).locale
    const locale = typeof queryLocale === 'string' ? queryLocale : undefined
    const plan = await prepareGuestBookingReceipt(tenantScope, requestId, token, locale)
    const [hostRows, ...rows] = await executeBatch(db, [host, ...plan.queries], { operation: 'Read guest booking receipt' })
    const tenant = hostRows?.results[0] as TenantRow | undefined
    if (tenant?.status === 'active' && tenant.onboarding_status === 'active') {
      event.context.guestReceipt = { requestId, locale, plan, rows } satisfies GuestReceiptRead
    }
    return tenant ?? null
  }

  const availabilitySlug = /^\/api\/public\/products\/([a-zA-Z0-9_-]+)\/availability$/.exec(path)?.[1]
  if (availabilitySlug) {
    const plan = preparePublicProductAvailability(tenantScope, availabilitySlug, getQuery(event))
    const [hostRows, ...rows] = await executeBatch(db, [host, ...plan.queries], { operation: 'Read public availability' })
    const tenant = hostRows?.results[0] as TenantRow | undefined
    if (tenant?.status === 'active' && tenant.onboarding_status === 'active') {
      event.context.publicAvailability = { slug: availabilitySlug, plan, rows } satisfies PublicAvailabilityRead
    }
    return tenant ?? null
  }

  const quoteSlug = /^\/api\/public\/products\/([a-zA-Z0-9_-]+)\/quote$/.exec(path)?.[1]
  if (quoteSlug) {
    const plan = preparePublicTimedQuote(tenantScope, { ...getQuery(event), slug: quoteSlug })
    const [hostRows, ...rows] = await executeBatch(db, [host, ...plan.queries], { operation: 'Read booking quote terms' })
    const tenant = hostRows?.results[0] as TenantRow | undefined
    if (tenant?.status === 'active' && tenant.onboarding_status === 'active') {
      event.context.timedQuote = { slug: quoteSlug, plan, rows } satisfies PublicTimedQuoteRead
    }
    return tenant ?? null
  }

  const routing = splitLocalePrefix(path)
  const requestedLocale = routing.localeSegment && platformLocale(routing.localeSegment)?.locale
  const sourcePath = (requestedLocale ? routing.sourcePath : path).replace(/\/$/, '') || '/'
  const collectionKind = publicDocumentCollectionKind(sourcePath)
  const includeReviews = sourcePath === '/reviews'
  const locationRoute = /^\/locations\/([a-z0-9_-]+)\/(menu|reviews)$/.exec(sourcePath)
  const privateCheckout = /^\/(?:pay\/[^/]+|bookings\/(?:confirmed|stay))$/.test(sourcePath)
  const authoredApi = path === '/api/public/pages'
  const apiPath = authoredApi ? event.url.searchParams.get('path') : null
  const authoredPath = apiPath?.startsWith('/') && !apiPath.startsWith('//') ? normalizedPath(apiPath)
    : authoredDocumentPath(sourcePath)
  if (!collectionKind && !includeReviews && !locationRoute && !privateCheckout && !authoredPath) {
    return queryFirst<TenantRow>(db, host.query, host.params)
  }

  const organization = { sql: '(SELECT id FROM viewer)' }
  const locale = { sql: `(SELECT locale FROM organization_locales WHERE organization_id = ${organization.sql} AND is_source = 1)` }
  const documentLocale = authoredApi ? event.url.searchParams.get('locale') : requestedLocale
  const plan = authoredApi ? null : preparePublicShellRows(organization, requestedLocale || locale, { collectionKind, includeReviews, previewMenu: false })
  const localizations = documentLocale ? [publicLocalizationsQuery(organization, documentLocale)] : []
  const location = locationRoute ? preparePublicLocationDocument(organization, {
    slug: locationRoute[1]!, page: locationRoute[2]!, locale: requestedLocale || undefined,
  }) : null
  const authored = authoredPath ? preparePublicAuthoredPage(organization, authoredPath, documentLocale || locale) : null
  const inquiry = !authoredApi && authoredPath === '/contact' ? preparePublicInquiryForm(organization, documentLocale || locale) : null
  const returningId = /^\/pay\/([a-f0-9-]+)$/.exec(sourcePath)?.[1]
  const returnPlan = returningId && typeof claim === 'string' && /^[a-f0-9-]{72}$/u.test(claim)
    ? await preparePaymentReturn(tenantScope, returningId, claim) : null
  const [hostRows, ...results] = await executeBatch(db, [
    host, ...[...plan?.queries ?? [], ...localizations, ...location?.queries ?? [], ...authored?.queries ?? [], ...inquiry ? [inquiry.statement] : []]
      .map(query => withViewer(authorized, query)),
    ...(returnPlan ? [returnPlan] : []),
  ], {
    operation: 'Read the public tenant document',
  })
  const tenant = hostRows?.results[0] as TenantRow | undefined
  if (tenant?.status === 'active' && tenant.onboarding_status === 'active') {
    const source = JSON.parse(tenant.source_locale_rows) as { locale: string }[]
    if (source.length === 1) {
      const shellLength = plan?.queries.length ?? 0
      const locationStart = shellLength + localizations.length
      const authoredStart = locationStart + (location?.queries.length ?? 0)
      if (plan) event.context.publicDocumentShell = {
        organizationId: tenant.id, locale: requestedLocale || source[0]!.locale, collectionKind, includeReviews, plan,
        results: results.slice(0, shellLength),
      } satisfies PublicDocumentShell
      if (documentLocale) event.context.publicDocumentLocalizations = {
        organizationId: tenant.id, locale: documentLocale,
        rows: results[shellLength]!.results as StoredPublicLocalizationRow[],
      }
      if (location) event.context.publicLocationDocument = location.read(results.slice(locationStart, authoredStart), tenant.id)
      if (authored) event.context.publicAuthoredPage = {
        organizationId: tenant.id, locale: documentLocale || source[0]!.locale, path: authoredPath!, plan: authored,
        rows: results.slice(authoredStart, authoredStart + authored.queries.length),
      }
      if (inquiry) event.context.publicInquiryForm = {
        organizationId: tenant.id, locale: documentLocale || source[0]!.locale,
        value: results[authoredStart + (authored?.queries.length ?? 0)]!.results[0],
      }
      if (returnPlan && typeof claim === 'string') {
        const resolvedLocale = requestedLocale || source[0]!.locale
        event.context.paymentReturnDocument = await sealPaymentReturnDocument(cloudflareEnv(event).BETTER_AUTH_SECRET,
          event.url.host, claim, results.at(-1)?.results[0], { locale: resolvedLocale, source: resolvedLocale === source[0]!.locale })
      }
    }
  }
  return tenant ?? null
}

// Blawby's own tenant is the one active organization running the platform
// site. Platform hosts differ per environment (localhost, staging, the
// apex), so the host itself is not the key; the site is.
function platformTenantQuery() {
  return { query: `
      ${TENANT_SELECT_SQL},
             canonical.domain AS canonical_domain
      FROM organization o
      LEFT JOIN organization_domains canonical
        ON canonical.organization_id = o.id AND canonical.role = 'canonical' AND canonical.status = 'active'
      WHERE o.theme_id = ? AND o.status = 'active' AND o.onboarding_status = 'active'
      LIMIT 1
    `, params: [PLATFORM_SITE.themeId] }
}

async function resolvePlatformTenant(db: DbClient): Promise<TenantRow | null> {
  const { query, params } = platformTenantQuery()
  return queryFirst<TenantRow>(db, query, params)
}

async function resolveDashboardTenant(event: H3Event, slug: string, panel: string) {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return null
  let plan: ReturnType<typeof prepareDashboardTenant> | undefined
  const read: DashboardAuthRead = {
    queries(token) {
      plan = prepareDashboardTenant(event, db, env, membershipBySlugQuery(slug, dashboardSessionUserQuery(token)), slug, panel)
      return plan.queries
    },
  }
  const session = await getDashboardSession(event, env, read)
  if (!session?.user.id) return null
  plan ??= prepareDashboardTenant(event, db, env, membershipBySlugQuery(slug, session.user.id), slug, panel)
  const results = read.results ?? await executeBatch(db, plan.queries, { operation: 'Read the dashboard document' })
  return plan.present(results, session)
}

function prepareDashboardTenant(event: H3Event, db: D1Database, env: ReturnType<typeof cloudflareEnv>, membership: BatchQuery, slug: string, panel: string) {
  const user = { sql: BATCH_VIEWER.user }
  const host = platformTenantQuery()
  const workspace = prepareDashboardWorkspaceAccess({ sql: BATCH_VIEWER.organization }, user, true)
  const today = panel === '' ? prepareToday(db, {
    slug, membership, now: new Date(), range: event.url.searchParams.get('range') === 'upcoming' ? 'upcoming' : 'today',
    staffAccessWrites: staffAccessWritesEnabled(env),
  }) : null
  const managedOrg = { sql: `CASE WHEN ${BATCH_VIEWER.organizationWide} = 1 THEN ${BATCH_VIEWER.organization} END` }
  const connections = /^\/integrations(?:\/|$)/.test(panel) ? prepareConnectionSummary(managedOrg) : null
  const google = panel === '/integrations/google-calendar' ? [
    calendarConnectionQuery(managedOrg),
    calendarCoverageQuery({ organization: managedOrg.sql, user: BATCH_VIEWER.user,
      admin: roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ members: ['read'] })) }),
  ] : null
  const query = getQuery(event)
  const productId = dashboardProductId(panel)
  const product = productId ? prepareDashboardProductRead(productId, true, undefined, {
    access: /^\/products\/[^/]+\/team(?:\/|$)/.test(panel),
    members: /^\/products\/[^/]+\/(?:booking|team)(?:\/|$)/.test(panel),
    scheduleLocation: /^\/products\/[^/]+\/booking(?:\/|$)/.test(panel) && typeof query.location_id === 'string' && query.location_id !== 'online' ? query.location_id : undefined,
  }) : null
  if (product && query.location_id !== undefined && typeof query.location_id !== 'string') throw new HTTPError({ statusCode: 400, message: 'Invalid location scope' })
  const website = rendersWebsiteDocument(panel, query) ? prepareWebsiteSettings(managedOrg, env) : null
  const locales = panel === '/website/preferences/localization' ? prepareOrganizationLanguageSettings(managedOrg, true) : null
  const domains = panel === '/website/preferences/domains' ? prepareOrganizationDomains(managedOrg) : null
  const websitePanel = website ? panel.split('/')[2] : undefined
  const websiteList = prepareWebsitePanel(websitePanel === 'posts' ? { sql: BATCH_VIEWER.organization } : managedOrg, websitePanel, query, websiteQuestion(panel))
  const variantId = websitePageVariant(panel)
  const websiteEditor = variantId && variantId !== 'new' ? prepareTenantPageEditor(variantId) : null
  const postId = website && websiteSocialPost(panel)
  const post = postId && postId !== 'new' ? preparePost({ sql: BATCH_VIEWER.organization }, postId, BATCH_VIEWER) : null
  const postLocations = postId ? prepareDashboardLocations(websiteEditorOrganization) : null
  const postConnections = postId ? prepareSocialConnections(websiteEditorOrganization) : null
  const articleId = websiteBlogPost(panel) || (postId === 'new' && typeof query.article_id === 'string' ? query.article_id : null)
  const article = articleId && articleId !== 'new' ? prepareBlogPost(articleId, websiteEditorOrganization) : null
  const categories = articleId === 'new'
    ? articleCategoriesQuery(websiteEditorOrganization, isArticleCollection(query.collection) ? query.collection : 'blog')
    : articleId && /\/category\/?$/.test(panel) ? blogPostCategoriesQuery(articleId, websiteEditorOrganization) : null
  const catalogRead = { products: ['read'] } as const
  const catalogRoles = [...rolesAllowing({ products: ['read'] }), ...rolesAllowing({ products: ['assigned'] })]
  const catalog = panel === '/products' && query.view !== 'menu' && query.view !== 'section'
    ? prepareDashboardCatalog({
      organizationId: { sql: `CASE WHEN ${roleMatchesSql(BATCH_VIEWER.role!, catalogRoles)} THEN ${BATCH_VIEWER.organization} END` },
      assignedUserId: { user: BATCH_VIEWER.user, unrestricted: roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ products: [...catalogRead.products] })) },
    }, query) : null
  const locationSlug = dashboardLocationSlug(panel)
  const location = locationSlug ? prepareDashboardLocationOverview({ slug: locationSlug }, /^\/locations\/[^/]+\/photos\/?$/.test(panel)) : null
  const locationList = /^\/locations(?:\/[^/]+)?\/?$/.test(panel) ? prepareDashboardLocations(
    { sql: `CASE WHEN ${roleMatchesSql(BATCH_VIEWER.role!, catalogRoles)} THEN ${BATCH_VIEWER.organization} END` },
    { user: BATCH_VIEWER.user, unrestricted: roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ products: [...catalogRead.products] })) },
  ) : null
  const bookingId = /^\/bookings\/([^/]+)$/.exec(panel)?.[1]
  const booking = bookingId && bookingId !== 'new' ? prepareDashboardBookingRead(membership, bookingId) : null
  const calendar = /^\/calendar(?:\/|$)/.test(panel)
    ? withViewer(membership, placesPresenceQuery({ query: BATCH_VIEWER.organization, params: [] }, user)) : null
  const day = /^\/calendar\/(\d{4}-\d{2}-\d{2})$/.exec(panel)?.[1]
  // Calendar uses the workspace's local month. Before reading its zone the two
  // UTC offsets bound the possible months, including across New Year's Day.
  const now = Date.now()
  const earlyMonth = new Date(now - 12 * 3_600_000).toISOString().slice(0, 7)
  const lateMonth = new Date(now + 14 * 3_600_000).toISOString().slice(0, 7)
  const chosenMonth = day?.slice(0, 7) ?? (typeof query.month === 'string' ? query.month : null)
  const month = day || panel === '/calendar' ? `${chosenMonth ?? earlyMonth}-01` : null
  const agenda = month && isValidCalendarDate(month) && (!day || isValidCalendarDate(day)) && !query.product_id && query.view !== 'year'
    ? prepareDashboardAgendaDocument(db, membership, slug, {
      from: month, to: parseDate(chosenMonth ? month : `${lateMonth}-01`).add({ months: 1 }).subtract({ days: 1 }).toString(),
      location_id: query.location_id === '__all__' ? undefined : query.location_id,
      assigned_member_id: query.assigned_member_id === '__all__' ? undefined : query.assigned_member_id,
      kinds: query.kinds === '__all__' ? undefined : query.kinds,
    })
    : null
  const earningsMonths = new Set([new Date().toISOString().slice(0, 7)])
  if (panel === '/earnings/performance' && typeof query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month)) earningsMonths.add(query.month)
  const earnings = /^\/earnings(?:\/|$)/.test(panel) ? prepareDashboardEarningsDocument(membership, earningsMonths, /^\/earnings\/payouts(?:\/|$)/.test(panel)) : null
  const queries = [
    host, membership,
    ...workspace.queries.map(query => withViewer(membership, query)),
    ...(today?.queries.slice(1) ?? []),
    ...(connections?.queries.map(query => withViewer(membership, query)) ?? []),
    ...(google?.map(query => withViewer(membership, query)) ?? []),
    ...(catalog?.queries.map(query => withViewer(membership, query)) ?? []),
    ...[...(locationList?.queries ?? []), ...(location?.queries ?? [])].map(query => withViewer(membership, query)),
    ...(product?.queries.map(query => withViewer(membership, query)) ?? []),
    ...(booking?.queries ?? []),
    ...(calendar ? [calendar, ...agenda?.queries ?? []] : []),
    ...(earnings?.queries ?? []),
    ...(website?.queries.map(query => withViewer(membership, query)) ?? []),
    ...(websiteList?.queries.map(query => withViewer(membership, query)) ?? []),
    ...(websiteEditor?.queries.map(query => withViewer(membership, query)) ?? []),
    ...(article?.queries.map(query => withViewer(membership, query)) ?? []),
    ...(categories ? [withViewer(membership, categories)] : []),
    ...(locales?.queries.map(query => withViewer(membership, query)) ?? []),
    ...(domains?.queries.map(query => withViewer(membership, query)) ?? []),
    ...[...(post?.queries ?? []), ...(postLocations?.queries ?? []), ...(postConnections?.queries ?? [])].map(query => withViewer(membership, query)),
  ]
  return { queries, present }

  async function present([tenantResult, viewerResult, ...rest]: D1Result[], session: NonNullable<Awaited<ReturnType<typeof getDashboardSession>>>) {
    const tenant = tenantResult!.results[0] as TenantRow | undefined
    if (!tenant) return null
    await readPublicSourceLocale(event, db, tenant.id, JSON.parse(tenant.source_locale_rows) as unknown[])
    const viewer = viewerResult!.results[0]
    const organization = dashboardOrganizationFrom(viewer)
    const userId = session.user.id
    if (organization.userId !== userId) throw new Error('Dashboard membership does not match the Better Auth session')
    await readDashboardMembership(event, slug, async () => viewer)
    const access = await readDashboardWorkspaceAccess(event, { db, env, organization }, true, workspace.read(rest.slice(0, workspace.queries.length), organization.id))
    const panelRows = rest.slice(workspace.queries.length)
    if (today) await readDashboardTodayDocument(event, slug, () => today.read([viewerResult!, ...panelRows]))
    if (connections && (viewer as { organization_wide: number }).organization_wide === 1) {
      await readDashboardConnectionsDocument(event, slug, connections.read(panelRows))
      if (google) await readCalendarSettingsDocument(event, slug, calendarSettingsFromRows(panelRows.slice(connections.queries.length)))
    }
    if (catalog) await readDashboardCatalogDocument(event, slug, catalog.read(panelRows, organization.id))
    if (locales && (viewer as { organization_wide: number }).organization_wide === 1) event.context.dashboardLocales = { organization_id: organization.id, resource: locales.read(panelRows.slice(website?.queries.length ?? 0), organization.id, organization.slug) }
    if (domains && (viewer as { organization_wide: number }).organization_wide === 1) event.context.dashboardDomains = { organization_id: organization.id, resource: await organizationDomainsDashboardPayload(domains.read(panelRows.slice(website?.queries.length ?? 0)), organization, env, access.effective_plan) }
    if (locationList) event.context.dashboardLocations = { organization_id: organization.id, resource: { success: true, locations: locationList.read(panelRows.slice(0, locationList.queries.length), organization.id).locations } }
    if (location) event.context.dashboardLocation = { organization_id: organization.id, resource: location.read(panelRows.slice(locationList?.queries.length ?? 0), organization) }
    if (product && productId) {
      const locationId = typeof query.location_id === 'string' && query.location_id !== 'online' ? query.location_id : null
      event.context.dashboardProduct = { organization_id: organization.id, product_id: productId,
        path: `${locationId ? `locations/${encodeURIComponent(locationId)}/` : ''}products/${encodeURIComponent(productId)}`,
        resource: await product.read(panelRows, { env, db, organization }, locationId) }
    }
    if (booking && bookingId) await readDashboardBookingDocument(event, { orgSlug: slug, bookingId }, [viewerResult!, ...panelRows])
    if (calendar) {
      event.context.dashboardCalendarPresence = { slug, has_places: (panelRows[0]!.results[0] as { has_places: number }).has_places === 1 }
      if (agenda) await agenda.apply(event, panelRows.slice(1), { env, organization })
    }
    if (earnings && panelRows[2]?.results.length) earnings.apply(event, panelRows, organization)
    const wholeWorkspace = (viewer as { organization_wide: number }).organization_wide === 1
    if (website && (wholeWorkspace || ['qa', 'posts'].includes(websitePanel ?? '') && typeof query.location_id === 'string')) {
      const content = new Map<string, unknown>()
      let offset = website.queries.length
      if (websiteList) {
        const list = websiteList.read(panelRows.slice(offset, offset + websiteList.queries.length), organization.id)
        content.set(list.endpoint, list.value)
        offset += websiteList.queries.length
      }
      if (websiteEditor) {
        content.set(`pages/${encodeURIComponent(variantId!)}`, await websiteEditor.read(panelRows.slice(offset), organization, env))
      }
      if (article) {
        content.set(`blog/${encodeURIComponent(articleId!)}`, { post: await article.read(panelRows.slice(offset, offset + article.queries.length), env) })
        offset += article.queries.length
      }
      if (categories) content.set('blog/categories', { categories: readArticleCategories(panelRows[offset++]!.results) })
      if (post) {
        const saved = await post.read(panelRows.slice(offset, offset + post.queries.length), env)
        if (saved) content.set(`posts/${encodeURIComponent(postId!)}`, { success: true, post: saved })
        offset += post.queries.length
      }
      if (postLocations) {
        content.set('post-locations', { success: true, locations: postLocations.read(panelRows.slice(offset, offset + postLocations.queries.length), organization.id).locations })
        offset += postLocations.queries.length
      }
      if (postConnections) {
        const saved = postConnections.read(panelRows.slice(offset, offset + postConnections.queries.length), organization.id)
        content.set('post-connections', saved.connections.some(connection => connection.connected)
          ? { channels: [], requires_live_validation: true }
          : await presentSocialConnections(env, organization.id, { dashboardBase: dashboardOrigin(env, { orgSlug: organization.slug, locationSlug: null }) }, saved))
      }
      event.context.dashboardWebsite = { settings: wholeWorkspace ? website.read(panelRows.slice(0, website.queries.length)) : null, content }
    }
    setResponseHeader(event, 'cache-control', 'private, no-store')
    await setDashboardSocketScope(event, env, { slug, organizationId: organization.id, sessionId: session.session.id, userId })
    return tenant
  }
}

function prepareWebsitePanel(organization: { sql: string }, panel: string | undefined, query: Record<string, unknown>, qaId: string | null) {
  if (panel === 'reviews') {
    const reviews = prepareOrganizationReviews(organization, { locationId: typeof query.location_id === 'string' ? query.location_id.trim() : null })
    return { queries: reviews.queries, read: (rows: D1Result[], id: string) => ({ endpoint: 'reviews', value: { reviews: reviews.read(rows, id) } }) }
  }
  if (panel === 'blog') {
    const list = prepareBlogList(organization, null, mcpPageWindow({}, { resource: '' }), null)
    return { queries: list.queries, read: (rows: D1Result[], id: string) => ({ endpoint: 'blog/posts', value: list.read(rows, { resource: `blog-posts:${id}::` }) }) }
  }
  if (panel === 'posts') {
    const locationId = typeof query.location_id === 'string' && query.location_id.trim() ? query.location_id.trim() : null
    const list = preparePostList(organization, { locationId }, mcpPageWindow({}, { resource: '' }), BATCH_VIEWER)
    return { queries: list.queries, read: (rows: D1Result[], id: string) => ({
      endpoint: 'posts', value: { success: true, ...list.read(rows, { resource: `posts:${id}::${locationId ?? ''}` }) },
    }) }
  }
  if (panel === 'qa' && qaId !== 'new') {
    const location = typeof query.location_id === 'string' ? query.location_id : null
    const qa = prepareDashboardQa(location, qaId ? { id: qaId } : { ...query, scopes: '1' })
    return {
      queries: qa.queries,
      read: (rows: D1Result[]) => ({
        endpoint: location ? `locations/${location}/qa` : 'qa',
        value: qa.read(rows),
      }),
    }
  }
  return null
}

function publicTenantMedia(tenant: Pick<TenantRow, 'media_json'>) {
  return organizationSocialMediaFromJson(tenant.media_json)
}

/** The site's logo and its optional dark-ground logo, each as its placement presents it. */
function siteLogos(mediaJson: string): SiteLogo[] {
  const placements = JSON.parse(mediaJson) as Array<{ slot: string; public_url: string | null; presentation: unknown }>
  return placements
    .filter(item => (LOGO_SLOTS as readonly string[]).includes(item.slot) && item.public_url)
    .map(item => ({
      slot: item.slot as SiteLogo['slot'],
      url: item.public_url!,
      presentation: item.presentation == null ? ORIGINAL_LOGO_PRESENTATION : parseLogoPresentation(item.presentation),
    }))
}

/** The profiles a site links to are the accounts connected in Integrations, and only those. */
function connectedSocialProfiles(tenant: Pick<TenantRow, 'facebook_page_id' | 'instagram_username'>) {
  return [
    ...(tenant.facebook_page_id ? [{ network: 'facebook' as const, url: `https://www.facebook.com/${encodeURIComponent(tenant.facebook_page_id)}` }] : []),
    ...(tenant.instagram_username ? [{ network: 'instagram' as const, url: `https://www.instagram.com/${encodeURIComponent(tenant.instagram_username)}/` }] : []),
  ]
}

export interface SpentSubdomainResolution {
  spent: true
  successorDomain: string | null
}

function isSpentSubdomainResolution(
  value: TenantRow | SpentSubdomainResolution,
): value is SpentSubdomainResolution {
  return 'spent' in value
}

function normalizedPath(pathname: string) {
  return pathname === "/" ? "/" : pathname.replace(/\/$/, "");
}

function requireTenantMetadata(tenant: Pick<TenantRow, 'theme_id' | 'vertical' | 'name'>, source: string) {
  const themeId = tenant.theme_id?.trim()
  const vertical = tenant.vertical?.trim()
  const name = tenant.name?.trim()
  if (!themeId || !vertical || !name) {
    throw new HTTPError({
      statusCode: 500,
      statusMessage: `Tenant ${source} is missing canonical identity or site metadata`,
      data: { code: 'TENANT_METADATA_INCOMPLETE' },
    })
  }
  return { themeId, vertical, name }
}

async function resolveRegisteredSubdomainTenant(
  event: H3Event,
  db: DbClient,
  tenantSlug: string,
): Promise<TenantRow | null> {
  return readTenantFromHost(event, db, 'canonical.domain', `
      FROM organization o
      JOIN organization_domains requested
        ON requested.organization_id = o.id
       AND requested.type = 'subdomain'
       AND requested.status = 'active'
      LEFT JOIN organization_domains canonical
        ON canonical.organization_id = o.id
       AND canonical.role = 'canonical'
       AND canonical.status = 'active'
      WHERE o.subdomain = ?
    `, [tenantSlug])
}

/**
 * The one place `organization.status` decides anything. A tenant is served
 * publicly only when it is Live and provisioning has finished; a Draft tenant,
 * or one still provisioning, is served to a holder of a valid preview token for
 * it — which is what "preview" means everywhere in this product: the real site,
 * on its real host, rendered by the real templates, with unpublished content
 * and no caching.
 *
 * `suspended` is Blawby's own hold and is nobody's to look past, the owner's
 * preview token included.
 *
 * Returns false when the request may not see this tenant at all.
 */
async function authorizeTenant(event: H3Event, tenant: TenantRow): Promise<boolean> {
  if (tenant.status === 'suspended') {
    event.context.previewAuthorized = false
    return false
  }
  const previewSecret = previewSecretOf(cloudflareEnv(event))
  const authorized = await resolvePreviewAuthorization(event, tenant.id, previewSecret)
  event.context.previewAuthorized = authorized
  // A live site is public either way; the flag still travels, because preview
  // also means "show me the drafts" — an unpublished article on a site that is
  // already live is previewed the same way.
  return (tenant.status === 'active' && tenant.onboarding_status === 'active') || authorized
}

function setResolvedTenantContext(
  event: H3Event,
  tenant: TenantRow,
  host: string,
  canonicalDomain: string | null,
) {
  const metadata = requireTenantMetadata(tenant, tenant.id)
  const socialMedia = publicTenantMedia(tenant)
  const resolvedSite = resolvePublicSite({ themeId: metadata.themeId})
  const siteSurface = resolvedSite.slug
  const isPlatform = siteSurface === 'platform'
  const logos = siteLogos(tenant.media_json)
  const fontPreset = resolveOrganizationFontPreset(tenant.font_preset_type === null ? undefined : tenant.font_preset)
  const palette = !isPlatform
    ? resolveSitePalette(tenant.palette === null ? undefined : parseSitePalette(JSON.parse(tenant.palette)))
    : null
  const recipe = parseSiteRecipe(tenant)

  event.context.organizationId = tenant.id
  event.context.themeId = metadata.themeId
  event.context.tenantType = isPlatform ? TENANT_TYPES.PLATFORM : TENANT_TYPES.TENANT
  event.context.tenantHost = hostnameOf(host)
  event.context.canonicalDomain = canonicalDomain
  event.context.organization = {
    id: tenant.id,
    subdomain: tenant.subdomain,
    name: metadata.name,
    brand_description: tenant.brand_description,
    theme_id: metadata.themeId,
    vertical: metadata.vertical,
    // The business's own clock: a visit is counted on its local day.
    timezone: tenant.timezone,
    has_payment_account: tenant.has_payment_account === 1,
    site: resolvedSite,
    fontPreset,
    palette,
    recipe,
    logos,
    social_profiles: connectedSocialProfiles(tenant),
    policies: [
      ...(tenant.privacy_policy ? ['privacy' as const] : []),
      ...(tenant.terms_policy ? ['terms' as const] : []),
      ...(tenant.acceptable_use_policy ? ['acceptable-use' as const] : []),
    ],
    ...socialMedia,
  }
}

const SESSION_SCOPED_API_PREFIXES = ["/api/dashboard", "/api/organizations", "/api/editor/organizations", "/api/messages", "/api/mcp", "/api/integrations/channex"] as const;

export default defineHandler(async (event) => {
  // Nested self-fetches (i18n/icon/internal API calls during SSR) never carry
  // tenant context downstream handlers rely on — the real inbound request
  // already resolved tenant type/host before triggering these. Skip the DB
  // lookup and host parsing entirely rather than redoing it per phantom request.
  // Nuxt carries the resolved public organization in its native error payload.
  // Error rendering must not repeat the operation that produced the error.
  if (isInternalSelfFetch(event)) {
    return;
  }

  const url = event.url;
  // Domain verification belongs to the request host and does not read a site.
  if (url.pathname === '/.well-known/openai-apps-challenge') return;
  const tenantPath = normalizedPath(url.pathname);
  // Diagnostics must still reach operational logs when tenant/D1 resolution fails.
  if (tenantPath === BROWSER_ERROR_PATH) return;
  if (tenantPath === "/api/auth" || tenantPath.startsWith("/api/auth/")) return;
  // The health check pings D1 and reads no tenant; local E2E routes assert their
  // own access and never read one either. A fresh database has no platform
  // organization until the E2E seed's bootstrap creates it.
  if (tenantPath === "/api/health" || tenantPath.startsWith("/api/dev/")) return;
  // The dashboard, organization, Messages and MCP APIs are scoped by the session and the
  // organization the request names, never by the host. Resolving the platform
  // site for them cost every call its tenant row, its redirect lookups and the
  // preview check before authentication ran: six D1 statements and 100-190 ms
  // on a 401. Nothing on these paths reads the resolved tenant; the one shared
  // helper, resolvePublicOrigin, answers the platform origin without it.
  if (tenantPath === '/api/integrations/social-connections' || SESSION_SCOPED_API_PREFIXES.some(prefix => tenantPath === prefix || tenantPath.startsWith(`${prefix}/`))) return;
  // `/api/public/**` used to be skipped here because each of those routes
  // carried its own site id in the path. That id was a second answer to "which
  // tenant", arriving beside the host that already knew — and a route reachable
  // with one tenant's id on another tenant's domain. The id is gone and the
  // host is the only answer, so the public API resolves here like everything
  // else and reads `event.context.organizationId`.
  const host = (event.req.headers.get("host")) || "";
  const env = cloudflareEnv(event);
  // Dashboard deep links must first reach the host that owns the OAuth cookie.
  const dashboard = tenantPath === '/dashboard' || tenantPath.startsWith('/dashboard/')
  const browserEntry = event.method === 'HEAD' || (event.method === 'GET' && event.req.headers.get('accept')?.includes('text/html'))
  if (browserEntry && (dashboard || tenantPath === '/login' || tenantPath === '/signup'
    || tenantPath === '/forgot-password' || /^\/accept-invitation\/[^/]+$/.test(tenantPath))) {
    const authOrigin = env.BETTER_AUTH_URL && new URL(env.BETTER_AUTH_URL)
    const freeSiteHost = normalizeHost(env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN)
    if (authOrigin && authOrigin.protocol === 'https:' && !isNonProductionHost(authOrigin.hostname)
      && authOrigin.hostname !== url.hostname && (url.hostname === freeSiteHost
        || (freeSiteHost === BLAWBY_FREE_SITE_HOST && url.hostname === LEGACY_FREE_SITE_HOST))) {
      return redirect(`${authOrigin.origin}${url.pathname}${url.search}`, 302)
    }
  }

  // The local harness and the staging alias name the tenant explicitly.
  // An unresolvable selector must never become the platform's homepage.
  const previewSlug = usesTenantHeader(host) ? event.req.headers.get("x-preview-tenant") : null
  const aliasSlug = environmentTenantAliasSlug(host, env)
  const requestedSlug = previewSlug ?? aliasSlug
  const isPlatformRequest = requestedSlug === null && isPlatformHost(host, env)
  const workspaceSlug = isPlatformRequest && event.method === 'GET'
    ? /^\/dashboard\/([a-z0-9-]+)(?:\/|$)/.exec(tenantPath)?.[1] : undefined
  const workspaceDocument = workspaceSlug && !['account', 'app', 'onboarding', 'select-organization'].includes(workspaceSlug)
  const workspaceTenant = workspaceDocument
    ? await resolveDashboardTenant(event, workspaceSlug, tenantPath.slice(`/dashboard/${workspaceSlug}`.length)) : undefined
  if (event.method === 'GET' && dashboard && !(await getDashboardSession(event, env))?.user.id) {
    return redirect(buildLoginUrl({ redirect: `${url.pathname}${url.search}` }), 302)
  }

  const tenant = workspaceDocument ? workspaceTenant
    : requestedSlug !== null
      ? env.db && /^[a-z0-9-]+$/.test(requestedSlug) ? await resolveRegisteredSubdomainTenant(event, env.db, requestedSlug) : null
      : isPlatformRequest ? env.db ? await resolvePlatformTenant(env.db) : null : await resolveTenant(host, event)

  // The return route carries the live host predicate into its settlement batch.
  if (event.context.authorizedPaymentReturn) return

  if (tenant && isSpentSubdomainResolution(tenant)) {
    if (tenant.successorDomain) {
      const status = event.method === 'GET' || event.method === 'HEAD' ? 301 : 308
      return redirect(`https://${tenant.successorDomain}${url.pathname}${url.search}`, status)
    }
    throw new HTTPError({ statusCode: 410, statusMessage: 'Gone' })
  }

  if (tenant && !isPlatformRequest && event.method === 'GET' && tenantPath === '/' && url.search === PUBLIC_WEBSITE_QUERY) {
    clearPreviewAuthorization(event)
    setResponseHeader(event, 'cache-control', 'private, no-store')
    return redirect('/', 303)
  }

  if (tenant && await authorizeTenant(event, tenant)) {
    try {
      await publicCacheRevision(event, env.db!, tenant.id, tenant.public_cache_revision)
      setResolvedTenantContext(event, tenant, host, requestedSlug !== null ? hostnameOf(host) : tenant.canonical_domain)
      const { id, default_currency, contact_email, contact_phone, vertical, brand_description, seo_title,
        seo_description, canonical_url, search_console_verification, has_compliance, name } = tenant
      await seedPublicBase(event, {
        id, default_currency, contact_email, contact_phone, vertical, brand_description, seo_title, seo_description, canonical_url,
        search_console_verification, has_compliance, theme_id: tenant.theme_id!, name,
      }, event.context.previewAuthorized === true)
      event.context.tenantSourceLocaleRows = { organizationId: tenant.id, rows: JSON.parse(tenant.source_locale_rows) as unknown[],
        published: JSON.parse(tenant.published_locales) as string[] }
      event.context.tenantConfigRow = tenant
      if (tenant.redirect_json !== undefined) event.context.tenantRedirect = tenant.redirect_json ? JSON.parse(tenant.redirect_json) as PublicTenantRedirect : null
    } catch (error) {
      if (HTTPError.isError(error)) throw error
      throw new HTTPError({
        statusCode: 500,
        statusMessage: 'Tenant metadata is invalid',
        cause: error,
        data: { code: 'TENANT_METADATA_INVALID', reason: error instanceof Error ? error.message : String(error) },
      })
    }
    return
  }

  if (isPlatformRequest) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'No active organization runs the platform site', data: { code: 'PLATFORM_TENANT_MISSING' } })
  }
  throw new HTTPError({ statusCode: 404, statusMessage: 'Organization Not Found' })
});

export async function resolveTenant(
  host: string,
  event: H3Event,
): Promise<TenantRow | SpentSubdomainResolution | null> {
  const runtimeEnv = cloudflareEnv(event);
  const db = runtimeEnv.db;
  const hostname = hostnameOf(host);

  if (!db || !hostname) return null;

  // Local development support (e.g., demo.localhost)
  if (hostname.includes(".localhost")) {
    const subdomain = hostname.split(".")[0];
    if (!subdomain) return null
    return await readTenantFromHost(event, db, "o.subdomain || '.localhost'", `
      FROM organization o
      WHERE o.subdomain = ?
    `, [subdomain]);
  }

  const tenant = await readTenantFromHost(event, db, 'COALESCE(canonical.domain, sd.domain)', `
    FROM organization o
    JOIN organization_domains sd ON o.id = sd.organization_id
    LEFT JOIN organization_domains canonical
      ON canonical.organization_id = o.id AND canonical.role = 'canonical' AND canonical.status = 'active'
    WHERE sd.domain = ? AND sd.type IN ('custom', 'subdomain') AND sd.status = 'active'
  `, [hostname])
  if (tenant || event.context.authorizedPaymentReturn) return tenant

  const spent = await queryFirst<{ successor_domain: string | null }>(
    db,
    "SELECT successor_domain FROM organization_domains WHERE domain = ? AND status = 'retired' LIMIT 1",
    [hostname],
  )
  return spent
    ? { spent: true, successorDomain: spent.successor_domain }
    : null
}
