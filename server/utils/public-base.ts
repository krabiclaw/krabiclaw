import { HTTPError } from 'nitro';
import { oncePerRequest } from '~/server/utils/request-scope'

import type { H3Event } from 'nitro'
import { queryFirst } from '~/server/db'
import { cloudflareEnv } from '~/server/utils/api-response'
import { recordRequestPhase } from '~/server/utils/request-metrics'
import type { CurrencyCode } from '~/shared/currencies'

export interface PublicBase {
  organization: {
    id: string
    organization_id: string
    default_currency: CurrencyCode | null
    contact_email: string | null
    contact_phone: string | null
    name: string | null
    brand_description: string | null
    vertical: string | null
    theme_id: string
    seo_title: string | null
    seo_description: string | null
    canonical_url: string | null
    search_console_verification: string | null
  }
}

/**
 * What a public request may see of a tenant, as a SQL predicate on an aliased
 * `organization` row — the query half of the rule
 * server/middleware/tenant-resolution.ts applies at the host, so a surface
 * reached by id answers the same way as one reached by hostname.
 *
 * Live and provisioned is public. Draft, and still-provisioning, belong to the
 * holder of the tenant's preview token. `suspended` is Krabiclaw's own hold and
 * is nobody's to look past.
 */
export function publicTenantVisibilitySql(alias: string, previewAuthorized: boolean | undefined): string {
  return previewAuthorized
    ? `${alias}.status <> 'suspended'`
    : `${alias}.status = 'active' AND ${alias}.onboarding_status = 'active'`
}

export function loadPublicBase(
  event: H3Event,
  organizationId: string,
  options: { previewAuthorized?: boolean } = {},
): Promise<PublicBase> {
  const key = `public-base:${organizationId}:${options.previewAuthorized ? 'preview' : 'public'}`
  return oncePerRequest(event, key, async () => {
    const startedAt = performance.now()
    const db = cloudflareEnv(event).DB
    if (!db) throw new HTTPError({ statusCode: 503, statusMessage: 'Database unavailable' })
    try {
      const organization = await queryFirst<PublicBase['organization']>(
        db,
        `SELECT s.id, s.default_currency, s.contact_email, s.contact_phone, s.name, s.vertical,
                s.theme_id,
                s.brand_description,
                s.seo_title, s.seo_description, s.canonical_url,
                (SELECT i.verification_token FROM organization_integrations i WHERE i.organization_id = s.id AND i.provider = 'google_search_console') AS search_console_verification
           FROM organization s
          WHERE s.id = ? AND ${publicTenantVisibilitySql('s', options.previewAuthorized)}
          LIMIT 1`,
        [organizationId],
      )
      if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
      return { organization }
    } finally {
      recordRequestPhase(event, 'base', startedAt)
    }
  })
}
