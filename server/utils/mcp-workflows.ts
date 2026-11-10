import { HTTPError } from 'nitro'
import type { CloudflareEnv } from "~/server/utils/auth";
import { queryAll, queryFirst } from "~/server/db";
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { listUserOrganizations, resolveOrganizationMembership } from '~/server/utils/member-access'
import { publicTenantVisibilitySql } from '~/server/utils/public-base'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'

export async function listOrganizationsForUser(
  db: D1Database,
  env: CloudflareEnv,
  userId: string,
) {
  const orgIds = (await listUserOrganizations(env, userId)).map(organization => organization.id)
  if (!orgIds.length) return [];

  const organizations = await queryAll<Record<string, unknown> & { id: string; subdomain: string | null; public_url: string | null }>(db, `
    SELECT s.id, s.theme_id, s.name, s.slug, s.subdomain,
           (SELECT domain FROM organization_domains WHERE organization_id = s.id AND role = 'canonical' AND status = 'active' AND type = 'custom') AS custom_domain, (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = s.id AND role = 'canonical' AND status = 'active' AND ${publicTenantVisibilitySql('s', false)}) AS public_url, s.status, s."createdAt" AS created_at, s.updated_at, s.onboarding_status
    FROM organization s
    WHERE s.id IN (SELECT value FROM json_each(?))
    ORDER BY s."createdAt" DESC
  `, [d1JsonStringSet(orgIds)]);
  return organizations.map(organization => ({ ...organization, public_url: organization.public_url ? tenantOrganizationOrigin({
    platformDomain: env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
    freeOrganizationDomain: env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '',
    subdomain: organization.subdomain ?? '',
    canonicalDomain: organization.public_url,
  }) : null }))
}

export async function getOrganizationForMcp(
  db: D1Database,
  env: CloudflareEnv,
  organizationId: string,
  userId: string,
) {
  const organization = await queryFirst<Record<string, unknown> & { subdomain: string | null; public_url: string | null }>(db, `
      SELECT s.id, s.name, s.theme_id, s.slug, s.subdomain,
             (SELECT domain FROM organization_domains WHERE organization_id = s.id AND role = 'canonical' AND status = 'active' AND type = 'custom') AS custom_domain, (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = s.id AND role = 'canonical' AND status = 'active' AND ${publicTenantVisibilitySql('s', false)}) AS public_url, s.status, s.updated_at, s.onboarding_status
      FROM organization s
      WHERE s.id = ?
      LIMIT 1
    `, [organizationId]);

  const membership = await resolveOrganizationMembership(env, { organizationId, userId })
  if (!organization || !membership) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found or access denied' });
  return { ...organization, public_url: organization.public_url ? tenantOrganizationOrigin({
    platformDomain: env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
    freeOrganizationDomain: env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '',
    subdomain: organization.subdomain ?? '',
    canonicalDomain: organization.public_url,
  }) : null };
}


export async function listContactSubmissions(
  db: D1Database,
  organizationId: string,
  opts: { locationIds?: string[] | null } = {},
) {
  const params: string[] = [organizationId]
  let locationClause = ''
  if (opts.locationIds) {
    if (opts.locationIds.length === 0) return []
    locationClause = `AND location_id IN (SELECT value FROM json_each(?))`
    params.push(d1JsonStringSet(opts.locationIds))
  }
  return await queryAll<Record<string, unknown>>(db, `
    SELECT id, organization_id, location_id, json_extract(payload_json, '$.guest.name') AS name, json_extract(payload_json, '$.guest.email') AS email, json_extract(payload_json, '$.subject') AS subject, json_extract(payload_json, '$.message') AS message, created_at FROM requests
    WHERE kind = 'contact' AND organization_id = ?
      ${locationClause}
    ORDER BY created_at DESC
    LIMIT 200
  `, params);
}

export async function listLocationReviews(
  db: D1Database,
  organizationId: string,
  locationId: string,
) {
  const rows = await queryAll<Record<string, unknown>>(db, `
    SELECT r.id, r.author_name, r.rating, r.title, r.content, r.owner_reply, r.owner_reply_at,
           r.source, r.status, r.created_at, r.updated_at
    FROM reviews r
    WHERE r.organization_id = ? AND r.location_id = ?
    ORDER BY r.created_at DESC
  `, [organizationId, locationId]);

  const { attachReviewMedia } = await import('~/server/utils/organization-reviews')
  return await attachReviewMedia(db, organizationId, rows)
}
