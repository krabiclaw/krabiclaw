import { APIError } from 'better-auth'
import { z } from 'zod'
import { queryAll, type BatchQuery, type DbClient } from '~/server/db'
import {
  listingCalendarRoles, listingMessagingRoles, listingOperationsRoles, organizationRoleCards, workspaceGuestMessagingRoles,
  roleMatchesSql, rolesForVertical, type OrganizationRole, type StoredListingAccess,
} from '~/utils/organization-access'

/** The first production release reads the new schema before it writes new access. */
export function staffAccessWritesEnabled(env: { STAFF_ACCESS_WRITES?: unknown }): boolean {
  return env.STAFF_ACCESS_WRITES !== 'hold'
}

const listingKinds: Record<string, string> = { lodging: 'stay', restaurant: 'table', service: 'service', experience: 'experience' }

export const listingGrantsSchema = z.array(z.object({
  listing_id: z.string().min(1),
  access: z.enum(['tasks', 'calendar', 'calendar_and_messaging', 'operations']),
}).strict()).max(100)
export type ListingGrant = z.infer<typeof listingGrantsSchema>[number]

export function assertStaffRole(vertical: string | null, role: string): OrganizationRole {
  const allowed = rolesForVertical(vertical).find(value => value === role)
  if (!allowed) throw new APIError('BAD_REQUEST', { code: 'INVALID_WORKSPACE_ROLE', message: 'Choose a role available for this workspace.' })
  return allowed
}

export function staffListingsQuery(organizationSql: string, verticalSql: string, params: unknown[] = []): BatchQuery {
  return { query: `SELECT p.id AS listing_id, COALESCE(NULLIF(s.internal_name, ''), p.name) AS label
    FROM products p LEFT JOIN product_stay_configs s ON s.organization_id = p.organization_id AND s.product_id = p.id
    WHERE p.organization_id = ${organizationSql} AND p.kind = json_extract('${JSON.stringify(listingKinds)}', '$.' || ${verticalSql})
    ORDER BY lower(label), p.id`, params }
}

export async function staffListings(db: DbClient, organization: { id: string; vertical: string | null }) {
  const query = staffListingsQuery('?', '?', [organization.id, organization.vertical])
  return queryAll<{ listing_id: string; label: string }>(db, query.query, query.params)
}

export async function validateInvitationGrants(db: DbClient, organization: { id: string; vertical: string | null }, role: OrganizationRole, stored: unknown) {
  if (stored == null) return
  const invalid = () => new APIError('BAD_REQUEST', { code: 'INVALID_LISTING_ACCESS', message: 'Choose eligible listings and access for this role.' })
  if (typeof stored !== 'string') throw invalid()
  let value: unknown
  try { value = JSON.parse(stored) } catch { throw invalid() }
  const parsed = listingGrantsSchema.safeParse(value)
  if (!parsed.success) throw invalid()
  const distinct = new Set(parsed.data.map(grant => grant.listing_id))
  if (distinct.size !== parsed.data.length || parsed.data.some(grant => !organizationRoleCards[role].access.includes(grant.access))) throw invalid()
  if (!distinct.size) return
  const kind = organization.vertical && listingKinds[organization.vertical]
  const rows = await queryAll<{ id: string }>(db, `SELECT id FROM products
    WHERE organization_id = ? AND kind = ? AND id IN (SELECT value FROM json_each(?))`,
  [organization.id, kind, JSON.stringify([...distinct])])
  if (rows.length !== distinct.size) throw invalid()
}

const levels = {
  task: ['tasks', 'operations'],
  calendar: ['calendar', 'calendar_and_messaging', 'operations'],
  reply: ['messaging', 'calendar_and_messaging', 'operations'],
  details: ['calendar_and_messaging', 'operations'],
  update: ['operations'],
} as const
const roles = { calendar: listingCalendarRoles, details: listingCalendarRoles, reply: listingMessagingRoles, update: listingOperationsRoles }

export function listingLevelSql(alias: string, action: keyof typeof levels) {
  return `${alias}.access IN (${levels[action].map(value => `'${value}'`).join(', ')})`
}

/** Use trusted column expressions. Role and grant are both checked at read time. */
export function listingGrantSql(organization: string, product: string, member: string, action: keyof typeof levels, role?: string): string {
  const gate = action !== 'task' && role ? `${roleMatchesSql(role, roles[action])} AND ` : ''
  return `(${gate}EXISTS (SELECT 1 FROM listing_message_members access
    WHERE access.organization_id = ${organization} AND access.listing_id = ${product}
      AND access.member_id = ${member} AND ${listingLevelSql('access', action)}))`
}

export function canGrantListingAccess(role: string, access: StoredListingAccess): boolean {
  return role.split(',').some(value => {
    const card = organizationRoleCards[value.trim() as OrganizationRole]
    return access === 'messaging' ? [...roles.reply, ...workspaceGuestMessagingRoles].some(role => role === value.trim()) : card?.access.includes(access) === true
  })
}
