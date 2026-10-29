import { HTTPError } from 'nitro';

import { executeBatch, queryAll, queryFirst, type DbClient } from '~/server/db'
import { getOrgAdapter, hasPermission } from 'better-auth/plugins'
import { parsePhoneOrThrow } from '~/utils/phone'
import { oncePerRequest } from '~/server/utils/request-scope'
import { sessionMemberSql } from '~/server/utils/provider-allocation'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { publishAccessInvalidation, type GuestInboxPublicationEnv } from '~/server/cloudflare/guest-inbox-events'
import type { H3Event } from 'nitro'
import type { CloudflareEnv, organizationOptions } from '~/server/utils/auth'
import type { OrganizationPermissions } from '~/utils/organization-access'

// Better Auth owns membership, roles and teams. Service and appointment access
// narrows those permissions using the saved provider assignment below.

/**
 * A membership this request actually resolved: one lookup keyed by
 * (organizationId, userId) that produced all three of these fields together.
 *
 * The brand is what makes that a fact rather than a convention. Only the
 * resolvers in this module mint one, so `organizationId` and `role` cannot
 * come from different places — which is precisely the mistake the scope checks
 * below can no longer catch now that they trust `role` instead of re-reading
 * the member row.
 */
declare const resolvedMembership: unique symbol
export interface ResolvedMembership {
  readonly [resolvedMembership]: true
  readonly userId: string
  readonly organizationId: string
  readonly role: string
}

/** The one place a ResolvedMembership is made. Not exported. */
function resolvedMembershipOf<T extends { userId: string; organizationId: string; role: string }>(fields: T): T & ResolvedMembership {
  return fields as T & ResolvedMembership
}

/**
 * Who is asking, about which tenant.
 *
 * `userId`, `role` and `organizationId` are not writable by the caller: they
 * are read off a ResolvedMembership, so the scope checks can trust that `role`
 * belongs to `organizationId` without reading the member row back.
 *
 * The tenant is the organization the membership resolved against. It used to
 * also carry a `organizationId` the caller supplied separately, which is how a request
 * could authorize against one tenant and then read another.
 */
export interface MemberAccessPrincipal {
  readonly [resolvedMembership]: true
  readonly env: CloudflareEnv
  // The authenticated user, not the member row id.
  readonly userId: string
  readonly role: string
  readonly organizationId: string
  // The request this principal was minted for, when there is one. Only used to
  // memoize the team read the scope checks share; absent for scheduled work.
  readonly event?: H3Event
}

export function memberAccessPrincipal(
  membership: ResolvedMembership,
  input: { env: CloudflareEnv; event?: H3Event },
): MemberAccessPrincipal {
  return {
    env: input.env,
    userId: membership.userId,
    role: membership.role,
    organizationId: membership.organizationId,
    event: input.event,
  } as MemberAccessPrincipal
}

export async function resolveMemberId(
  input: { organizationId: string; userId: string; env: CloudflareEnv },
): Promise<string | null> {
  if (!input.env) {
    throw new Error('resolveMemberId requires CloudflareEnv so Better Auth can resolve organization membership')
  }
  const orgAdapter = await organizationAdapter(input.env)
  const member = await orgAdapter.findMemberByOrgId({
    userId: input.userId,
    organizationId: input.organizationId,
  })
  return member?.id ?? null
}

export async function findLocation(
  db: DbClient,
  input: { organizationId: string; locationId: string },
): Promise<{ id: string } | null> {
  return await queryFirst<{ id: string }>(db, `
    SELECT id FROM business_locations
    WHERE id = ? AND organization_id = ?
    LIMIT 1
  `, [input.locationId, input.organizationId])
}

export function isOrganizationWideRole(role: string): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * What a role may do, answered by Better Auth.
 *
 * `utils/organization-access.ts` declares the statements and the two roles,
 * and the plugin is configured with them (`organizationOptions.ac/roles`), so
 * this is the repository's one description of what each role can reach. It used
 * to be reached only by billing; everything else re-decided the same question
 * by hand — `role === 'owner' || role === 'admin'`, an MCP rank ladder, and a
 * list of dashboard route strings, three answers that could drift from the
 * matrix and from each other.
 *
 * `hasPermission` evaluates the role's statements in memory. It reads the
 * database only under `dynamicAccessControl`, which is off here, so this costs
 * no round trip.
 *
 * This answers "may this role do X at all"; resource guards then check its row.
 */
export type { OrganizationPermissions }

export async function roleAllows(
  input: { organizationId: string; role: string; permissions: OrganizationPermissions },
): Promise<boolean> {
  const { organizationOptions: options } = await import('~/server/utils/auth')
  return await hasPermission({
    organizationId: input.organizationId,
    role: input.role,
    options,
    permissions: input.permissions,
  }, undefined as never)
}

export async function assertRoleAllows(
  input: { organizationId: string; role: string; permissions: OrganizationPermissions; message?: string },
): Promise<void> {
  if (await roleAllows(input)) return
  throw new HTTPError({ statusCode: 403, message: input.message ?? 'Access denied', data: { code: 'FORBIDDEN', field: 'permissions' } })
}

// All surfaces use the provider adapter with the configured organization options.
export type OrganizationAdapter = ReturnType<typeof getOrgAdapter<typeof organizationOptions>>

export async function organizationAdapter(env: CloudflareEnv): Promise<OrganizationAdapter> {
  const { createAuth, organizationOptions: options } = await import('~/server/utils/auth')
  const auth = createAuth(env)
  const context = await auth.$context
  return getOrgAdapter(context as unknown as Parameters<typeof getOrgAdapter>[0], options)
}

/**
 * The two Better Auth reads every membership resolution is made of, memoized
 * for the life of one request.
 *
 * A dashboard render resolves the same membership twice: getDashboardContext
 * looks the organization up by slug, loadMemberOrganizationRow looks it up by id, and
 * each then reads the same member row for the same user. Neither can change
 * mid-request. Pass the event and the second resolution is free; without one
 * (scheduled jobs, tenant deletion) they read as before.
 */
export function organizationById(env: CloudflareEnv, id: string, event?: H3Event) {
  const read = async () => (await organizationAdapter(env)).findOrganizationById(id)
  return event ? oncePerRequest(event, `organization:${id}`, read) : read()
}

function organizationBySlug(env: CloudflareEnv, slug: string, event?: H3Event) {
  const read = async () => (await organizationAdapter(env)).findOrganizationBySlug(slug)
  return event ? oncePerRequest(event, `organization-slug:${slug}`, read) : read()
}

function membershipRow(env: CloudflareEnv, input: { organizationId: string; userId: string }, event?: H3Event) {
  const read = async () => (await organizationAdapter(env)).findMemberByOrgId(input)
  return event ? oncePerRequest(event, `membership:${input.organizationId}:${input.userId}`, read) : read()
}

export async function resolveOrganizationMembership(
  env: CloudflareEnv,
  input: { organizationId: string; userId: string },
  event?: H3Event,
): Promise<(ResolvedMembership & { memberId: string; organizationSlug: string; organizationName: string }) | null> {
  const [member, organization] = await Promise.all([
    membershipRow(env, input, event),
    organizationById(env, input.organizationId, event),
  ])
  if (!member || !organization) return null
  return resolvedMembershipOf({
    userId: input.userId,
    organizationId: input.organizationId,
    role: member.role,
    memberId: member.id,
    organizationSlug: organization.slug,
    organizationName: organization.name,
  })
}

/**
 * The membership alone, for a caller that already has an organization id but no
 * proof the asker belongs to it — an SSR data loader reading the id off the
 * rendered payload, an OAuth callback reading it out of its own state.
 *
 * One read. resolveOrganizationMembership and resolveUserOrganization also
 * fetch the organization row for its name and slug; a caller that only needs to
 * authorize does not.
 */
export async function resolveMembership(
  env: CloudflareEnv,
  input: { organizationId: string; userId: string },
): Promise<ResolvedMembership | null> {
  const adapter = await organizationAdapter(env)
  const member = await adapter.findMemberByOrgId(input)
  if (!member) return null
  return resolvedMembershipOf({
    userId: input.userId,
    organizationId: input.organizationId,
    role: member.role,
  })
}

export async function resolveUserOrganization(
  env: CloudflareEnv,
  input: { userId: string; organizationId?: string | null; organizationSlug?: string | null },
  event?: H3Event,
): Promise<(ResolvedMembership & {
  id: string
  name: string
  slug: string
  memberId: string
}) | null> {
  const organization = input.organizationId
    ? await organizationById(env, input.organizationId, event)
    : input.organizationSlug
      ? await organizationBySlug(env, input.organizationSlug, event)
      : null
  if (!organization) return null
  const member = await membershipRow(env, { userId: input.userId, organizationId: organization.id }, event)
  if (!member) return null
  return resolvedMembershipOf({
    userId: input.userId,
    organizationId: organization.id,
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    role: member.role,
    memberId: member.id,
  })
}

// adapter.listMembers pages at 100 by default — every caller that needs the
// complete membership (not just a bounded page for display) must walk every
// page via its own total, or a large organization silently loses members
// past the first 100.
export async function listAllOrganizationMembers(adapter: OrganizationAdapter, organizationId: string) {
  const pageSize = 100
  const firstPage = await adapter.listMembers({ organizationId, limit: pageSize, offset: 0, sortBy: 'createdAt', sortOrder: 'asc' })
  const members = [...firstPage.members]
  for (let offset = pageSize; offset < firstPage.total; offset += pageSize) {
    const page = await adapter.listMembers({ organizationId, limit: pageSize, offset, sortBy: 'createdAt', sortOrder: 'asc' })
    members.push(...page.members)
  }
  return members
}

/**
 * The person internal alerts go to, as an identity rather than just an address.
 *
 * The user id comes back with the email because a notification preference is
 * per person (user_notification_preferences), so the sender needs to know whose
 * preference applies, not only where to post the message.
 */
/**
 * Everyone this tenant's internal alerts may go to, as identities.
 *
 * One list for both channels. This used to pick a single owner/admin for email
 * — sorted so that an `@example.test` address lost a tie, a test concern
 * deciding who a real tenant hears from — while WhatsApp went to whatever
 * number was typed into a settings field. Two sources, two answers, and a
 * location's own people could be in neither.
 *
 * Who is the membership; whether, and over which channel, is each person's own
 * `user_notification_preferences`; where is their account email and their
 * verified phone. A member with no verified phone simply has no WhatsApp
 * address, which is not a failure and nothing to report.
 */
export interface OrganizationNotificationMember {
  userId: string
  email: string
  phone: string | null
}

export async function listOrganizationNotificationMembers(
  env: CloudflareEnv,
  organizationId: string,
  options: { /** Explicit previous/new provider notices. */ includeMemberIds?: readonly string[]; requestId?: string } = {},
): Promise<OrganizationNotificationMember[]> {
  const adapter = await organizationAdapter(env)
  const members = await listAllOrganizationMembers(adapter, organizationId)
  // Keyed by user, not by member row: a duplicated membership must not become
  // a duplicated alert.
  const byUserId = new Map<string, { id: string; email: string }>()
  const included = new Set(options.includeMemberIds)
  if (options.requestId) {
    const scope = assignedGuestThreadScope('r', { column: 'recipient.userId' })
    const responsible = await queryAll<{ id: string }>(env.DB, `SELECT recipient.id FROM member recipient JOIN requests r ON r.organization_id = recipient.organizationId
      WHERE recipient.organizationId = ? AND r.id = ? AND ${scope.sql}`, [organizationId, options.requestId])
    for (const member of responsible) included.add(member.id)
  }
  for (const member of members) {
    if (!(isOrganizationWideRole(member.role) || included.has(member.id))) continue
    byUserId.set(member.user.id, { id: member.user.id, email: member.user.email })
  }
  if (byUserId.size === 0) return []

  // listMembers carries only the identity columns Better Auth shows next to a
  // member, so the verified phone is read from the user model through the same
  // adapter that owns it. Reading `member.user.phoneNumber` silently produced
  // undefined for everyone, which is a tenant hearing nothing on WhatsApp.
  const { createAuth } = await import('~/server/utils/auth')
  const auth = createAuth(env)
  const context = await auth.$context
  const ids = [...byUserId.keys()]
  const rows = await context.adapter.findMany<Pick<typeof auth.$Infer.Session.user, 'id' | 'phoneNumber' | 'phoneNumberVerified'>>({
    model: 'user',
    where: [{ field: 'id', operator: 'in', value: ids }],
    select: ['id', 'phoneNumber', 'phoneNumberVerified'],
    limit: ids.length,
  })
  const usersById = new Map(rows.map(row => [row.id, row]))

  return ids.map(id => {
    const user = usersById.get(id)
    if (!user) throw new Error(`Better Auth user ${id} is missing for an organization notification member`)
    return {
      userId: id,
      email: byUserId.get(id)!.email,
      phone: user.phoneNumber && user.phoneNumberVerified ? user.phoneNumber : null,
    }
  })
}

export async function listUserOrganizations(env: CloudflareEnv, userId: string) {
  const adapter = await organizationAdapter(env)
  return await adapter.listOrganizations(userId)
}

export async function findOrganizationById(env: CloudflareEnv, organizationId: string) {
  return await organizationAdapter(env).then(adapter => adapter.findOrganizationById(organizationId))
}

/**
 * Organization-wide management access.
 *
 * Authorization is the Better Auth organization role (owner or admin).
 */
export async function assertOrganizationWideAccess(_db: DbClient, input: MemberAccessPrincipal): Promise<void> {
  if (isOrganizationWideRole(input.role)) return
  throw new HTTPError({ statusCode: 404, message: 'Not found or access denied' })
}

export interface ResponsibilityTarget {
  assigned_member_id: string | null
  assigned_team_id: string | null
}

/** Validate the effective member-or-team pair against Better Auth's own rows. */
export async function assertResponsibilityTarget(db: DbClient, organizationId: string, patch: { assigned_member_id?: unknown; assigned_team_id?: unknown }, current?: ResponsibilityTarget): Promise<ResponsibilityTarget> {
  const memberId = patch.assigned_member_id === undefined ? current?.assigned_member_id ?? null : patch.assigned_member_id
  const teamId = patch.assigned_team_id === undefined ? current?.assigned_team_id ?? null : patch.assigned_team_id
  for (const [field, value] of [['assigned_member_id', memberId], ['assigned_team_id', teamId]] as const) {
    if (value !== null && (typeof value !== 'string' || !value.trim())) throw new HTTPError({ statusCode: 422, message: 'Choose a current member or team of this workspace, or leave responsibility unassigned', data: { code: 'INVALID_RESPONSIBILITY', field } })
  }
  if (memberId !== null && teamId !== null) throw new HTTPError({ statusCode: 422, message: 'Choose one responsible member or team', data: { code: 'RESPONSIBILITY_TARGET_CONFLICT', field: 'assigned_team_id' } })
  if (memberId !== null && !await queryFirst(db, 'SELECT id FROM member WHERE organizationId = ? AND id = ?', [organizationId, memberId])) {
    throw new HTTPError({ statusCode: 422, message: 'The responsible member must belong to this organization', data: { code: 'INVALID_RESPONSIBILITY', field: 'assigned_member_id' } })
  }
  if (teamId !== null && !await queryFirst(db, 'SELECT id FROM team WHERE organizationId = ? AND id = ?', [organizationId, teamId])) {
    throw new HTTPError({ statusCode: 422, message: 'The responsible team must belong to this organization', data: { code: 'INVALID_RESPONSIBILITY', field: 'assigned_team_id' } })
  }
  return { assigned_member_id: memberId as string | null, assigned_team_id: teamId as string | null }
}

/** Clear only departed/dangling current targets; booked-person history stays. */
export async function reconcileResponsibilities(env: GuestInboxPublicationEnv, db: DbClient, input: { organizationId: string; departingUserId?: string }): Promise<void> {
  const now = new Date().toISOString()
  let changed = false
  for (const [table, key] of [['business_locations', 'id'], ['product_booking_configs', 'product_id'], ['product_stay_configs', 'product_id']] as const) {
    const memberMissing = `${table}.assigned_member_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM member m WHERE m.id = ${table}.assigned_member_id AND m.organizationId = ${table}.organization_id AND m.userId IS NOT ?)`
    const teamMissing = `${table}.assigned_team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM team t WHERE t.id = ${table}.assigned_team_id AND t.organizationId = ${table}.organization_id)`
    const rows = await queryAll<ResponsibilityTarget & { resource_id: string; member_missing: number; team_missing: number }>(db,
      `SELECT ${key} AS resource_id, assigned_member_id, assigned_team_id, (${memberMissing}) AS member_missing, (${teamMissing}) AS team_missing
        FROM ${table} WHERE organization_id = ? AND ((${memberMissing}) OR (${teamMissing}))`,
      [input.departingUserId ?? null, input.organizationId, input.departingUserId ?? null])
    for (let offset = 0; offset < rows.length; offset += 400) {
      const chunk = rows.slice(offset, offset + 400)
      const results = await executeBatch(db, chunk.flatMap(row => [{
        query: `UPDATE ${table} SET assigned_member_id = CASE WHEN ${memberMissing} THEN NULL ELSE assigned_member_id END,
          assigned_team_id = CASE WHEN ${teamMissing} THEN NULL ELSE assigned_team_id END, updated_at = ?${table === 'business_locations' ? '' : ", updated_by = 'system'"}
          WHERE organization_id = ? AND ${key} = ? AND assigned_member_id IS ? AND assigned_team_id IS ? AND ((${memberMissing}) OR (${teamMissing}))`,
        params: [input.departingUserId ?? null, now, input.organizationId, row.resource_id, row.assigned_member_id, row.assigned_team_id, input.departingUserId ?? null],
      }, organizationEventQuery({ organizationId: input.organizationId, actorType: 'system', eventType: 'member.access_scope_revoked', entityType: table, entityId: row.resource_id,
        beforeState: { assigned_member_id: row.assigned_member_id, assigned_team_id: row.assigned_team_id },
        afterState: { assigned_member_id: row.member_missing ? null : row.assigned_member_id, assigned_team_id: row.team_missing ? null : row.assigned_team_id },
        onlyIfPreviousChangedOneRow: true,
      })]), { operation: 'Reconcile departed responsibility targets' })
      if (chunk.some((_row, index) => results[index * 2]?.meta.changes === 1)) changed = true
    }
  }
  if (changed) await publishAccessInvalidation(env, { organizationId: input.organizationId })
}

/** One predicate for a resource's explicit responsibility; user is bound twice. */
export function assignedResponsibilitySql(alias: string, userSql = '?'): string {
  return `((EXISTS (SELECT 1 FROM member m WHERE m.id = ${alias}.assigned_member_id AND m.organizationId = ${alias}.organization_id AND m.userId = ${userSql})
    OR EXISTS (SELECT 1 FROM team t JOIN teamMember tm ON tm.teamId = t.id
      JOIN member m ON m.userId = tm.userId AND m.organizationId = t.organizationId
      WHERE t.id = ${alias}.assigned_team_id AND t.organizationId = ${alias}.organization_id AND m.userId = ${userSql}))
    AND NOT (${alias}.assigned_member_id IS NOT NULL AND ${alias}.assigned_team_id IS NOT NULL))`
}

/** The offering's responsibility, using the same member/team matching. */
export const ASSIGNED_SERVICE_SQL = `(p.kind = 'service' OR p.kind = 'experience') AND EXISTS (
  SELECT 1 FROM product_booking_configs c
  WHERE c.organization_id = p.organization_id AND c.product_id = p.id
    AND ${assignedResponsibilitySql('c')}
)`

export async function assertProductAccess(db: DbClient, input: MemberAccessPrincipal & { productId: string; patch?: Record<string, unknown> }): Promise<void> {
  if (await roleAllows({ ...input, permissions: { products: ['update'] } })) return
  await assertRoleAllows({ ...input, permissions: { products: ['assigned'] } })
  const assigned = await queryFirst<{ kind: string; scheduling_mode: string; assigned_member_id: string | null; assigned_team_id: string | null; held_online: number }>(db, `SELECT p.kind, c.scheduling_mode, c.assigned_member_id, c.assigned_team_id, c.held_online
    FROM products p JOIN product_booking_configs c ON c.product_id = p.id AND c.organization_id = p.organization_id
    WHERE p.organization_id = ? AND p.id = ? AND (${ASSIGNED_SERVICE_SQL})`, [input.organizationId, input.productId, input.userId, input.userId])
  if (!assigned) throw new HTTPError({ statusCode: 404, message: 'Offering not found or access denied' })
  if (input.patch?.kind !== undefined && input.patch.kind !== assigned.kind) throw new HTTPError({ statusCode: 403, message: 'Offering kind requires admin access' })
  const booking = input.patch?.booking && typeof input.patch.booking === 'object' ? input.patch.booking as Record<string, unknown> : input.patch
  for (const field of ['scheduling_mode', 'assigned_member_id', 'assigned_team_id', 'held_online']) {
    if (booking?.[field] !== undefined && booking[field] !== (field === 'held_online' ? assigned[field as keyof typeof assigned] === 1 : assigned[field as keyof typeof assigned])) throw new HTTPError({ statusCode: 403, message: 'Offering assignment requires admin access' })
  }
  if (input.patch?.booking !== undefined) throw new HTTPError({ statusCode: 403, message: 'Offering creation requires admin access; edit saved booking settings and schedule separately' })
}

/** A booked provider is an individual fact, independent of current responsibility. */
export function assignedBookingSql(alias: string, userSql = '?'): string {
  return `EXISTS (SELECT 1 FROM member m
    WHERE m.id = ${alias}.assigned_member_id AND m.organizationId = ${alias}.organization_id AND m.userId = ${userSql})`
}

/** The same assigned-conversation scope is used by lists, reads, writes and realtime. */
export function assignedGuestThreadScope(alias: string, user: string | { /** Trusted query column, never request input. */ column: string }): { sql: string; params: string[] } {
  const userSql = typeof user === 'string' ? '?' : user.column
  const sql = `((${alias}.kind = 'booking' AND EXISTS (SELECT 1 FROM bookings b WHERE b.request_id = ${alias}.id AND b.organization_id = ${alias}.organization_id AND ${assignedBookingSql('b', userSql)}))
      OR (${alias}.kind = 'booking' AND EXISTS (SELECT 1 FROM bookings b JOIN product_booking_configs c ON c.product_id = b.product_id AND c.organization_id = b.organization_id
        WHERE b.request_id = ${alias}.id AND b.organization_id = ${alias}.organization_id AND ${assignedResponsibilitySql('c', userSql)}))
      OR (${alias}.kind = 'stay' AND EXISTS (SELECT 1 FROM stays st JOIN product_stay_configs c ON c.organization_id = st.organization_id AND c.product_id = st.product_id
        WHERE st.request_id = ${alias}.id AND st.organization_id = ${alias}.organization_id AND ${assignedResponsibilitySql('c', userSql)}))
      OR (${alias}.kind = 'stay' AND EXISTS (SELECT 1 FROM channel_threads ct JOIN product_stay_configs c ON c.organization_id = ct.organization_id AND c.product_id = ct.product_id
        WHERE ct.request_id = ${alias}.id AND ct.organization_id = ${alias}.organization_id AND ${assignedResponsibilitySql('c', userSql)}))
      OR (${alias}.kind = 'contact' AND ${alias}.location_id IS NOT NULL AND EXISTS (SELECT 1 FROM business_locations bl
        WHERE bl.id = ${alias}.location_id AND bl.organization_id = ${alias}.organization_id AND ${assignedResponsibilitySql('bl', userSql)}))
      OR (${alias}.kind = 'reservation' AND EXISTS (SELECT 1 FROM reservations res JOIN business_locations bl ON bl.id = res.location_id AND bl.organization_id = res.organization_id
        WHERE res.request_id = ${alias}.id AND res.organization_id = ${alias}.organization_id AND ${assignedResponsibilitySql('bl', userSql)})))`
  return { sql, params: typeof user === 'string' ? Array(sql.match(/\?/g)?.length ?? 0).fill(user) : [] }
}

/** Appointments retain their own member even after the service is reassigned. */
export async function assertAssignedBookingAccess(db: DbClient, input: MemberAccessPrincipal & { bookingId?: string; requestId?: string; sessionId?: string }): Promise<void> {
  if (await roleAllows({ ...input, permissions: { operations: ['update'] } })) return
  await assertRoleAllows({ ...input, permissions: { operations: ['assigned'] } })
  const threadScope = assignedGuestThreadScope('r', input.userId)
  const assigned = input.requestId && !input.bookingId
    ? await queryFirst(db, `SELECT r.id FROM requests r WHERE r.organization_id = ? AND r.id = ? AND ${threadScope.sql}`, [input.organizationId, input.requestId, ...threadScope.params])
    : await queryFirst(db, `SELECT b.id FROM bookings b LEFT JOIN requests r ON r.id = b.request_id AND r.organization_id = b.organization_id
      LEFT JOIN product_booking_configs c ON c.product_id = b.product_id AND c.organization_id = b.organization_id
      WHERE b.organization_id = ? AND b.id = ? AND (${assignedBookingSql('b')} OR ${assignedResponsibilitySql('c')} OR (r.id IS NOT NULL AND ${threadScope.sql}))`,
    [input.organizationId, input.bookingId, input.userId, input.userId, input.userId, ...threadScope.params])
  if (!assigned) throw new HTTPError({ statusCode: 404, message: 'Conversation not found or access denied', data: { code: 'THREAD_NOT_FOUND', field: input.requestId ? 'threadId' : 'bookingId' } })
  if (input.sessionId) {
    const destination = await queryFirst(db, `SELECT s.id FROM product_sessions s JOIN bookings b ON b.product_id = s.product_id AND b.organization_id = s.organization_id
      WHERE b.organization_id = ? AND ${input.bookingId ? 'b.id' : 'b.request_id'} = ? AND s.id = ? AND ${sessionMemberSql('s')} = b.assigned_member_id`, [input.organizationId, input.bookingId ?? input.requestId, input.sessionId])
    if (!destination) throw new HTTPError({ statusCode: 403, message: 'Changing the assigned provider requires admin access', data: { code: 'PROVIDER_ASSIGNMENT_FORBIDDEN', field: 'sessionId' } })
  }
}

/** The location must belong to the tenant the caller authorized against; reaching it is an org-wide role or location assignment. */
export async function assertLocationAccess(db: DbClient, input: MemberAccessPrincipal & { locationId: string; patch?: Record<string, unknown> }): Promise<void> {
  if (await roleAllows({ ...input, permissions: { locations: ['update'] } })) {
    const location = await findLocation(db, { organizationId: input.organizationId, locationId: input.locationId })
    if (!location) throw new HTTPError({ statusCode: 404, message: 'Resource not found' })
    return
  }
  await assertRoleAllows({ ...input, permissions: { locations: ['assigned'] } })
  const assigned = await queryFirst<{ id: string; assigned_member_id: string | null; assigned_team_id: string | null }>(db, `SELECT bl.id, bl.assigned_member_id, bl.assigned_team_id
    FROM business_locations bl
    WHERE bl.organization_id = ? AND bl.id = ? AND (${assignedResponsibilitySql('bl')})`, [input.organizationId, input.locationId, input.userId, input.userId])
  if (!assigned) throw new HTTPError({ statusCode: 404, message: 'Location not found or access denied' })
  if (input.patch?.assigned_member_id !== undefined && input.patch.assigned_member_id !== assigned.assigned_member_id) {
    throw new HTTPError({ statusCode: 403, message: 'Location assignment requires admin access' })
  }
  if (input.patch?.assigned_team_id !== undefined && input.patch.assigned_team_id !== assigned.assigned_team_id) {
    throw new HTTPError({ statusCode: 403, message: 'Location assignment requires admin access' })
  }
}

/** A resource that may or may not belong to one location (e.g. a review row) — dispatches to assertOrganizationWideAccess when the row's own location_id is null, assertLocationAccess otherwise. Check the target row's location_id, never a caller-supplied param. Media authorization uses its placement owner instead. */
export async function assertResourceAccess(db: DbClient, input: MemberAccessPrincipal & { resourceLocationId: string | null }): Promise<void> {
  if (input.resourceLocationId === null) {
    return assertOrganizationWideAccess(db, input)
  }
  return assertLocationAccess(db, { ...input, locationId: input.resourceLocationId })
}

export async function assertMemberScope(db: DbClient, input: MemberAccessPrincipal & { locationId?: string | null; patch?: Record<string, unknown> }): Promise<void> {
  if (input.locationId) {
    await assertLocationAccess(db, { ...input, locationId: input.locationId, patch: input.patch })
    return
  }
  await assertOrganizationWideAccess(db, input)
}

/**
 * Who, if anyone, may act on this tenant from this WhatsApp number.
 *
 * The number here is the one Meta reports as the sender of an inbound message,
 * never a number a tenant typed into a settings field. Outbound alerts resolve
 * the other way round — from the member to their own verified phone — so there
 * is no configured number left to authorize.
 *
 * Returns the user id rather than a bare boolean because the caller also has to
 * honour that person's own preferences, and resolving the number to an account
 * twice would be two implementations of one lookup.
 */
export interface WhatsAppSenderScope {
  organizationId: string
  env: CloudflareEnv
  phone: string
}

export async function resolveAuthorizedWhatsAppRecipient(
  _db: DbClient,
  input: WhatsAppSenderScope,
): Promise<{ userId: string } | null> {
  const { findVerifiedAuthUserByPhone } = await import('~/server/utils/auth')
  const user = await findVerifiedAuthUserByPhone(
    input.env,
    parsePhoneOrThrow(input.phone),
  )
  if (!user) return null
  const membership = await resolveOrganizationMembership(input.env, {
    organizationId: input.organizationId,
    userId: user.id,
  })
  if (!membership || !isOrganizationWideRole(membership.role)) return null
  return { userId: user.id }
}

export async function isAuthorizedWhatsAppRecipient(
  db: DbClient,
  input: WhatsAppSenderScope,
): Promise<boolean> {
  return (await resolveAuthorizedWhatsAppRecipient(db, input)) !== null
}
