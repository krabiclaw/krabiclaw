import { HTTPError, defineHandler  } from 'nitro';

import { cloudflareEnv, textResponse } from '~/server/utils/api-response'
import {
  buildLlmsTxt, buildTenantBlogLinkEntries, buildPlatformBlogLinkEntries, buildPlatformDocLinkEntries, listPublishedTenantBlogPostsForLlm, listPublishedPlatformBlogPostsForLlm, listPublishedDocsForLlm, resolvePublicOrigin, } from '~/server/utils/platform-llm'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return textResponse('Database not available\n', { status: 500 })

  const origin = resolvePublicOrigin(event)
  const isTenant = event.context.tenantType === 'tenant'
  const organizationId = isTenant ? String(event.context.organizationId || '') : ''
  const organizationName = (event.context.organization as { name?: string | null } | undefined)?.name?.trim() || ''
  if (isTenant && organizationId && !organizationName) throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant brand name is not configured' })

  if (isTenant && organizationId) {
    const orgRecord = event.context.organization as { name?: string | null; vertical?: string | null } | undefined
    const vertical = orgRecord?.vertical
    const coreLinks: Array<{ title: string; path: string; description: string }> = []
    if (vertical === 'restaurant') {
      coreLinks.push(
        { title: 'Menu', path: '/menu', description: 'Current food and drink menu, pricing, and dietary details.' },
        { title: 'Reservations', path: '/reservations', description: 'Table bookings and online reservation availability.' },
        { title: 'Locations', path: '/locations', description: 'Physical branch locations, opening hours, and contact details.' },
      )
    } else if (vertical === 'lodging') {
      coreLinks.push(
        { title: 'Places to stay', path: '/stays', description: 'Home listings, stay details, nightly availability, and direct booking.' },
        { title: 'Contact', path: '/contact', description: 'Contact the host about a stay.' },
      )
    } else if (vertical === 'service') {
      coreLinks.push(
        { title: 'Contact', path: '/contact', description: 'Office location, consultation inquiry, and contact details.' },
        { title: 'Schedule', path: '/schedule', description: 'Book an appointment or consultation.' },
      )
    } else {
      coreLinks.push(
        { title: 'Locations', path: '/locations', description: 'Locations, opening hours, and contact details.' },
        { title: 'Contact', path: '/contact', description: 'Get in touch with our team.' },
      )
    }

    const [docs, posts] = await Promise.all([
      listPublishedDocsForLlm(db, organizationId),
      listPublishedTenantBlogPostsForLlm(db, organizationId, env, 'blog'),
    ])
    return textResponse(
      buildLlmsTxt(
        origin,
        buildPlatformDocLinkEntries(docs, origin),
        buildTenantBlogLinkEntries(posts ?? [], origin),
        {
          title: organizationName,
          intro: `${organizationName} website, offerings, and public content available for machine retrieval and citation.`,
          coreLinks,
          includeDocsOptionalLinks: false,
          blogIndexDescription: 'Machine-readable manifest of published tenant blog posts.',
          blogRssDescription: 'Chronological feed for published tenant blog posts.',
          blogJsonFeedDescription: 'JSON Feed export for published tenant blog posts.',
          fullContextDescription: 'Aggregated export of published tenant blog posts.',
        },
      ),
    )
  }

  const [docs, posts] = await Promise.all([
    listPublishedDocsForLlm(db, String(event.context.organizationId)), listPublishedPlatformBlogPostsForLlm(db, env), ])

  return textResponse(
    buildLlmsTxt(
      origin,
      buildPlatformDocLinkEntries(docs ?? [], origin),
      buildPlatformBlogLinkEntries(posts ?? [], origin),
      {
        coreHeading: 'Platform & Solutions',
        coreLinks: [
          { title: 'KrabiClaw Model Context Protocol (MCP)', path: '/plugin', description: 'Manage websites, menus, stay availability, and bookings directly via Claude Desktop, ChatGPT, or compatible MCP clients.' },
          { title: 'Pricing & Plans', path: '/pricing', description: 'Published plans, included features, and payment pricing.' },
          { title: 'Law firms (Blawby)', path: '/legal', description: 'Law firm websites, practice areas, and legal consultation requests.' },
          { title: 'Restaurants (Saya)', path: '/restaurants', description: 'Restaurant websites, menus, and table reservations.' },
          { title: 'Lodging & Stays', path: '/lodging', description: 'Lodging websites, home listings, nightly availability, and direct stay booking.' },
          { title: 'Experiences', path: '/experiences', description: 'Experience websites, dated sessions, and ticketed bookings.' },
        ],
      },
    ),
  )
})
