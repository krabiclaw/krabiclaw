import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import type { CloudflareEnv } from '~/server/utils/auth'
import { listUserOrganizations, resolveOrganizationMembership } from '~/server/utils/member-access'
import { publicTenantVisibilitySql } from '~/server/utils/public-base'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'

export interface McpWorkspacePreferenceRow {
  user_id: string
  organization_id: string | null
  location_id: string | null
  created_at: string
  updated_at: string
}

/**
 * A tenant the caller can reach.
 *
 * This used to be an McpSiteSummary sitting beside an McpOrganizationSummary,
 * and the workspace held both plus a list of each: a tool could be given an
 * organization and a site that named different tenants. There is one.
 */
export interface McpOrganizationSummary {
  id: string
  name: string | null
  slug: string | null
  subdomain: string | null
  custom_domain: string | null
  public_url: string | null
  status: string
  onboarding_status: string
  role: string
}

export interface McpLocationSummary {
  id: string
  slug: string
  title: string
  /** The neighbourhood the address names, or its town. Derived, never stored. */
  place_name: string | null
  status: string
}

export interface ResolvedMcpWorkspace {
  preference: McpWorkspacePreferenceRow | null
  organization: McpOrganizationSummary | null
  location: McpLocationSummary | null
  organizations: McpOrganizationSummary[]
  locations: McpLocationSummary[]
}

interface ResolveWorkspaceOptions {
  organizationId?: string | null
  locationId?: string | null
  requireOrganization?: boolean
  requireLocation?: boolean
}

function normalizeId(value: string | null | undefined) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || null
}

export async function getMcpWorkspacePreference(
  db: D1Database,
  userId: string,
) {
  return await queryFirst<McpWorkspacePreferenceRow>(db, `
    SELECT user_id, organization_id, location_id, created_at, updated_at
    FROM user_workspace_state
    WHERE user_id = ?
    LIMIT 1
  `, [userId])
}

export async function listAccessibleOrganizationsForMcp(
  db: D1Database,
  env: CloudflareEnv,
  userId: string,
): Promise<McpOrganizationSummary[]> {
  const organizations = await listUserOrganizations(env, userId)
  if (!organizations.length) return []
  const memberships = await Promise.all(organizations.map(organization =>
    resolveOrganizationMembership(env, { organizationId: organization.id, userId }),
  ))
  const roleByOrganizationId = new Map(memberships.flatMap((membership, index) => membership
    ? [[organizations[index]!.id, membership.role] as const]
    : []))
  const rows = await queryAll<Omit<McpOrganizationSummary, 'role'>>(db, `
    SELECT id, name, slug, subdomain,
           (SELECT domain FROM organization_domains WHERE organization_id = organization.id AND role = 'canonical' AND status = 'active' AND type = 'custom') AS custom_domain,
           (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = organization.id AND role = 'canonical' AND status = 'active' AND ${publicTenantVisibilitySql('organization', false)}) AS public_url,
           status, onboarding_status
    FROM organization
    WHERE id IN (SELECT value FROM json_each(?))
    ORDER BY updated_at DESC, "createdAt" DESC
  `, [d1JsonStringSet(organizations.map(organization => organization.id))])
  return rows.flatMap((row) => {
    const role = roleByOrganizationId.get(row.id)
    return role ? [{ ...row, role, public_url: row.public_url ? tenantOrganizationOrigin({
      platformDomain: env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
      freeOrganizationDomain: env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '',
      subdomain: row.subdomain ?? '',
      canonicalDomain: row.public_url,
    }) : null }] : []
  })
}

export async function listLocationsForMcp(
  db: D1Database,
  organizationId: string,
) {
  const results = await queryAll<{
    id: string
    slug: string
    title: string
    place_name: string | null
    status: string
  }>(db, `
    SELECT id, slug, title, COALESCE(address ->> '$.sublocality', address ->> '$.locality') AS place_name, status
    FROM business_locations
    WHERE organization_id = ? 
    ORDER BY title ASC
  `, [organizationId])

  return results
}

export async function resolveMcpWorkspace(
  db: D1Database,
  env: CloudflareEnv,
  userId: string,
  options: ResolveWorkspaceOptions = {},
): Promise<ResolvedMcpWorkspace> {
  const preference = await getMcpWorkspacePreference(db, userId)
  const organizations = await listAccessibleOrganizationsForMcp(db, env, userId)

  const requestedOrganizationId = normalizeId(options.organizationId)
  const preferredOrganizationId = normalizeId(preference?.organization_id)

  // Exact technical identifiers (id, subdomain, custom domain) resolve directly
  // here — they're unambiguous and the full candidate list is already in memory,
  // so this costs nothing extra. Fuzzy name matching deliberately is not
  // attempted: two tenants can share a word in their name, and guessing wrong is
  // worse than requiring list_organizations first for that case.
  let organization = requestedOrganizationId
    ? organizations.find((entry) => entry.id === requestedOrganizationId) ??
      organizations.find((entry) =>
        entry.subdomain === requestedOrganizationId ||
        entry.custom_domain === requestedOrganizationId,
      ) ??
      null
    : null

  if (requestedOrganizationId && !organization) {
    const domain = await queryFirst<{ organization_id: string }>(db, "SELECT organization_id FROM organization_domains WHERE domain = ? AND status = 'active' LIMIT 1", [requestedOrganizationId])
    organization = organizations.find(entry => entry.id === domain?.organization_id) ?? null
  }

  if (!requestedOrganizationId) {
    if (preferredOrganizationId) {
      organization = organizations.find((entry) => entry.id === preferredOrganizationId) ?? null
    }
    if (!organization && organizations.length === 1) {
      organization = organizations[0] ?? null
    }
  }

  if (options.requireOrganization && !organization) {
    throw new Error(
      organizations.length === 0
        ? 'No accessible organization found.'
        : 'Organization context is required. Call set_workspace_context or pass organization_id explicitly.',
    )
  }

  const locations = organization
    ? await listLocationsForMcp(db, organization.id)
    : []

  const requestedLocationId = normalizeId(options.locationId)
  const preferredLocationId = organization?.id === preferredOrganizationId
    ? normalizeId(preference?.location_id)
    : null
  const selectedLocationId = requestedLocationId ?? preferredLocationId
  const location = selectedLocationId
    ? locations.find((entry) => entry.id === selectedLocationId) ??
      locations.find((entry) => entry.slug === selectedLocationId) ??
      null
    : null

  if (options.requireLocation && !location) {
    if (requestedLocationId) {
      throw new Error(
        `Location "${requestedLocationId}" was not found on the active organization.`,
      )
    }
    throw new Error(
      locations.length === 0
        ? 'No location found for the active organization.'
        : 'Location context is required. Call set_workspace_context or pass location_id explicitly.',
    )
  }

  return {
    preference: preference ?? null,
    organization,
    location,
    organizations,
    locations,
  }
}

export async function upsertMcpWorkspacePreference(
  db: D1Database,
  input: {
    userId: string
    organizationId: string | null
    locationId: string | null
  },
) {
  const now = new Date().toISOString()
  await execute(db, `
    INSERT INTO user_workspace_state (
      user_id, organization_id, location_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      organization_id = excluded.organization_id,
      location_id = excluded.location_id,
      updated_at = excluded.updated_at
  `, [
    input.userId,
    input.organizationId,
    input.locationId,
    now,
    now,
  ])
}

export type JsonSerializable = string | number | boolean | null | { [key: string]: JsonSerializable } | JsonSerializable[]

function nowIso() {
  return new Date().toISOString()
}

function jsonOrNull(value: JsonSerializable | null | undefined): string | null {
  return value == null ? null : JSON.stringify(value)
}

export async function getWhatsAppWorkspaceState(
  db: DbClient,
  userId: string,
): Promise<{
  user_id: string
  pending_confirmation: string | null
  last_inbound_id: string | null
  updated_at: string
} | null> {
  const result = await queryFirst<{
    user_id: string
    pending_confirmation: string | null
    last_inbound_id: string | null
    updated_at: string
  }>(db, `
    SELECT user_id, whatsapp_pending_confirmation AS pending_confirmation, whatsapp_last_inbound_id AS last_inbound_id, whatsapp_updated_at AS updated_at
      FROM user_workspace_state
     WHERE user_id = ? AND whatsapp_updated_at IS NOT NULL LIMIT 1
  `, [userId])
  return result ?? null
}

export async function patchWhatsAppWorkspaceState(
  db: DbClient,
  opts: {
    userId: string
    pendingConfirmation?: JsonSerializable | null
    lastInboundId?: string | null
  }
): Promise<void> {
  const updateFields: string[] = []
  if ('pendingConfirmation' in opts) updateFields.push('whatsapp_pending_confirmation = excluded.whatsapp_pending_confirmation')
  if ('lastInboundId' in opts) updateFields.push('whatsapp_last_inbound_id = excluded.whatsapp_last_inbound_id')
  updateFields.push('whatsapp_updated_at = excluded.whatsapp_updated_at')

  await execute(db, `
    INSERT INTO user_workspace_state
      (user_id, whatsapp_pending_confirmation, whatsapp_last_inbound_id, whatsapp_updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      ${updateFields.join(',\n      ')}
  `, [
    opts.userId,
    jsonOrNull(opts.pendingConfirmation),
    opts.lastInboundId ?? null,
    nowIso(),
  ])
}
