import { getSourceLocale } from '~/server/utils/organization-locales'
import { defineHandler, HTTPError, type H3Event } from 'nitro';
import {    redirect, setResponseHeader } from 'nitro/h3';
import { queryFirst } from '~/server/db'
import { cloudflareEnv } from '~/server/utils/api-response'
import { TENANT_TYPES } from '~/utils/tenant-routing'
import { EXPERIENCE_PRESENTATION } from '~/utils/product-presentation'

const redirects: Record<string, string> = {
  // Every site's policies are its page documents under /policies.
  '/privacy': '/policies/privacy',
  '/terms': '/policies/terms',
  '/privacy-policy': '/policies/privacy',
  '/terms-and-conditions': '/policies/terms',
  // Preserve older guessed/short docs URLs while keeping the published article
  // slug as the canonical destination.
  '/docs/getting-started/getting-started-with-krabiclaw-in-chatgpt': '/docs/getting-started',
  '/docs/getting-started/getting-started-with-krabiclaw': '/docs/getting-started',
  '/docs/getting-started/connect-krabiclaw-to-chatgpt': '/docs/mcp-setup',
  // A documentation category was never a page of its own: /docs/{category}
  // answered only when some article's slug happened to equal the category
  // slug. The index is where that reader was going.
  '/docs/integrations': '/docs',
  '/docs/menu-management': '/docs',
  '/docs/theme-customization': '/docs',
  '/docs/seo-marketing': '/docs',
  '/docs/advanced': '/docs',
}

/**
 * Krabiclaw's own articles used to carry their category between the prefix and
 * the slug — /blog/{category}/{slug}, /docs/{category}/{slug}, and the same
 * shape for both markdown mirrors. They are addressed by slug now, so any URL
 * published under the old shape keeps working by dropping the segment that
 * stopped meaning anything. Listing the moved articles instead would go stale
 * the first time one is renamed. `/{blog,docs}/category/{slug}` is a category's
 * own page now, and no old category was named "category", so it is not one.
 */
const ARTICLE_CATEGORY_PATH = /^\/(blog|docs|blog-md|docs-md)\/(?!category\/)[^/]+\/([^/]+)$/

function articlePathWithoutCategory(pathname: string): string | null {
  const match = ARTICLE_CATEGORY_PATH.exec(pathname)
  return match ? `/${match[1]}/${match[2]}` : null
}

// Platform-domain-only (krabiclaw.com bare host) paths Google Search Console
// keeps recrawling with no current or planned replacement (see issue #317).
// A plain 404 lets Google keep retrying indefinitely; 410 Gone is a stronger,
// faster de-index signal. `/posts` is not one of them: Krabiclaw's own site
// has a post feed like every other template.
const PLATFORM_GONE_PATHS = new Set(['/changelog'])

/**
 * Links written before the catalog epoch (#919), and during the week it moved.
 *
 * `/experiences` and `/locations/<location>/experiences` are routes again, so
 * nothing redirects them. Two things still point at pages that moved: the
 * cancellation link mailed with every booking taken before the cutover, and
 * the location-scoped URL an experience briefly had between the cutover
 * and this change. An experience's page is named by its own slug.
 */
async function resolveRetiredExperiencePath(event: H3Event, path: string) {
  // A guest cancelling from an email sent before the epoch. The link carries
  // the booking in its query and the token in its fragment, and the page that
  // reads both is the same page under its own name.
  if (path === '/experiences/cancel') return '/bookings/cancel'

  const moved = /^\/locations\/[^/]+\/(?:products|menu)\/([^/]+)$/.exec(path)
  if (!moved) return null
  // A stale link can carry anything; a pathname the URL parser kept but
  // percent-decoding rejects is simply not a slug we ever issued.
  let slug: string
  try {
    slug = decodeURIComponent(moved[1]!)
  } catch {
    return null
  }
  const db = cloudflareEnv(event).db
  const organizationId = event.context.organizationId as string | null | undefined
  if (!db || !organizationId) return null
  // Product kind owns the route. A service can take bookings while retaining
  // its branch's product URL.
  const experience = await queryFirst<{ slug: string } | null>(db, `
    SELECT p.slug FROM products p
      JOIN product_publications pp ON pp.product_id = p.id AND pp.organization_id = ? AND pp.published = 1
     WHERE p.slug = ? AND p.active = 1 AND p.kind = 'experience'
     LIMIT 1
  `, [organizationId, slug])
  if (!experience) return null
  return EXPERIENCE_PRESENTATION.productPath('', experience.slug)
}

async function resolveTenantRedirectForRequest(event: H3Event) {
  const organizationId = event.context.organizationId as string | null | undefined
  if (!organizationId) return null
  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) throw new HTTPError({ statusCode: 500, statusMessage: 'Database not available' })
  const url = event.url
  const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '')
  const firstSegment = path.split('/')[1] || ''
  const sourceLocale = await getSourceLocale(db, organizationId)
  const localized = firstSegment && firstSegment !== sourceLocale
    ? await queryFirst<{ locale: string } | null>(db, `
        SELECT locale FROM organization_locales
         WHERE organization_id = ? AND locale = ? AND is_source = 0 AND status = 'published'
         LIMIT 1
      `, [organizationId, firstSegment])
    : null
  const locale = localized?.locale ?? sourceLocale
  const tenantPagePath = localized ? (path.slice(locale.length + 1) || '/') : path

  const exactPage = await queryFirst<{ id: string } | null>(db, `
    SELECT id FROM content_documents
     WHERE kind = 'page' AND row_role IN ('root','representation') AND organization_id = ? AND locale = ? AND path = ?
     LIMIT 1
  `, [organizationId, locale, tenantPagePath])
  if (exactPage) return null

  const localeRedirect = await queryFirst<{
    toPath: string | null
    statusCode: number | null
    behavior: string
  } | null>(db, `
    SELECT to_path AS toPath, status_code AS statusCode, behavior
      FROM organization_redirects
     WHERE organization_id = ? AND locale = ? AND from_path = ?
     LIMIT 1
  `, [organizationId, locale, path])
  if (localeRedirect) return localeRedirect

  return null
}

export default defineHandler(async (event) => {
  const url = event.url
  const normalizedPathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '')
  if (event.context.tenantType === TENANT_TYPES.PLATFORM && normalizedPathname === '/features') {
    return redirect(`/products${url.search}`, 301)
  }

  // The MCP connector URL is meant for ChatGPT's "Connect" flow, but people
  // tap it directly from emails/WhatsApp messages instead of copying it.
  // Send browsers (GET requesting HTML) to the docs page explaining what this
  // URL is for; leave POST and non-browser GET clients (MCP probes) alone so
  // they still reach server/api/mcp.ts.
  if (
    normalizedPathname === '/api/mcp' &&
    event.req.method === 'GET' &&
    ((event.req.headers.get('accept')) ?? '').includes('text/html')
  ) {
    return redirect('/docs/mcp-setup', 302)
  }

  if (event.context.tenantType === TENANT_TYPES.PLATFORM && PLATFORM_GONE_PATHS.has(normalizedPathname)) {
    throw new HTTPError({ statusCode: 410, statusMessage: 'Gone' })
  }

  const target = redirects[normalizedPathname]
    ?? (event.context.tenantType === TENANT_TYPES.PLATFORM ? articlePathWithoutCategory(normalizedPathname) : null)
  if (target) {
    const targetWithParams = `${target}${url.search}${url.hash}`
    // Permanent redirect for SEO
    return redirect(targetWithParams, 301)
  }

  const tenantRedirect = (event.context.tenantRedirect as {
    toPath: string | null
    statusCode: number | null
    behavior: string
  } | null | undefined) ?? await resolveTenantRedirectForRequest(event)
  if (event.context.tenantType === TENANT_TYPES.TENANT && tenantRedirect) {
    if (tenantRedirect.behavior === 'gone') {
      throw new HTTPError({ statusCode: 410, statusMessage: 'Gone' })
    }
    if (tenantRedirect.behavior === 'noindex') {
      setResponseHeader(event, 'x-robots-tag', 'noindex, nofollow')
    }
    if (tenantRedirect.behavior === 'redirect') {
      const isLocalTarget = Boolean(tenantRedirect.toPath && /^\/(?![/\\])/.test(tenantRedirect.toPath))
      const isApprovedMediaTarget = (() => {
        try {
          const targetUrl = new URL(tenantRedirect.toPath || '')
          return targetUrl.protocol === 'https:' && ['media.krabiclaw.com', 'images.krabiclaw.com'].includes(targetUrl.hostname)
        } catch {
          return false
        }
      })()
      if (!isLocalTarget && !isApprovedMediaTarget) {
        throw new HTTPError({ statusCode: 500, statusMessage: 'Invalid tenant redirect target' })
      }
      const statusCode = [301, 302, 307, 308].includes(tenantRedirect.statusCode ?? 0)
        ? tenantRedirect.statusCode!
        : 301
      const target = isLocalTarget
        ? `${tenantRedirect.toPath}${url.search}${url.hash}`
        : (() => {
            const external = new URL(tenantRedirect.toPath!)
            external.search = url.search
            external.hash = url.hash
            return external.toString()
          })()
      return redirect(target, statusCode)
    }
  }

  // After the tenant's own redirects: a merchant who has written a rule for
  // one of these paths has said where it goes, and this is the default for the
  // ones nobody wrote.
  if (event.context.tenantType === TENANT_TYPES.TENANT) {
    const retired = await resolveRetiredExperiencePath(event, normalizedPathname)
    if (retired) return redirect(`${retired}${url.search}${url.hash}`, 301)
  }

  if (event.req.method === 'GET') {
    const platformOrganizationId = event.context.tenantType === TENANT_TYPES.PLATFORM ? event.context.organizationId as string | null : null
    if (platformOrganizationId) {
      const db = cloudflareEnv(event).db
      if (db) {
        // A lookup that failed is not "no redirect configured": swallowing it
        // served a 404 for a path the tenant had already pointed somewhere.
        const redirected = await queryFirst<{ to_path: string } | null>(db, `
          SELECT to_path FROM organization_redirects
           WHERE organization_id = ? AND locale = (SELECT locale FROM organization_locales WHERE organization_id = ? AND is_source = 1) AND from_path = ? AND behavior = 'redirect' LIMIT 1
        `, [platformOrganizationId, platformOrganizationId, normalizedPathname])
        if (redirected) return redirect(`${redirected.to_path}${url.search}${url.hash}`, 301)
      }
    }
  }

})
