import type { CloudflareEnv } from '~/server/utils/auth'
import { listAllOrganizationMembers, organizationAdapter, type OrganizationAdapter } from '~/server/utils/member-access'
import { createDb, queryAll, type DbClient } from '~/server/db'
import type { GuestThreadDeliveryRow } from '~/server/domain/guest-threads/types'

type InvitationDelivery = Pick<GuestThreadDeliveryRow, 'status' | 'provider' | 'provider_message_id' | 'error'>

export async function getInvitationDeliveries(db: DbClient, organizationId: string, invitations: Pick<Awaited<ReturnType<OrganizationAdapter['listInvitations']>>[number], 'id' | 'expiresAt'>[]) {
  const rows = invitations.length ? await queryAll<InvitationDelivery & {id:string}>(db, `SELECT d.id,d.status,d.provider,d.provider_message_id,d.error FROM guest_thread_deliveries d
    JOIN activity_entries a ON a.id=d.entry_id WHERE a.organization_id=? AND a.scope_kind='organization' AND a.event_name='member.invited'
      AND d.id IN (SELECT value FROM json_each(?))`, [organizationId, JSON.stringify(invitations.map(invitation => `organization-invitation-email:${invitation.id}:${invitation.expiresAt.toISOString()}`))]) : []
  const byId = new Map(rows.map(({id,...delivery}) => [id, delivery]))
  return new Map(invitations.map(invitation => [invitation.id, byId.get(`organization-invitation-email:${invitation.id}:${invitation.expiresAt.toISOString()}`) ?? null]))
}

export async function getOrganizationTeamsData(env: CloudflareEnv, organizationId: string) {
  const adapter = await organizationAdapter(env)
  const teams = await adapter.listTeams(organizationId)
  return Promise.all(teams.map(async team => ({
    ...team,
    members: await adapter.listTeamMembers({ teamId: team.id }),
  })))
}

export async function getOrganizationMembersData(env: CloudflareEnv, organizationId: string) {
  const adapter = await organizationAdapter(env)
  const [memberRows, invitationRows] = await Promise.all([
    listAllOrganizationMembers(adapter, organizationId),
    // Better Auth's own reading of "pending": not yet answered and not yet expired.
    adapter.findPendingInvitations({ organizationId }),
  ])
  const roleOrder = new Map([['owner', 0], ['admin', 1]])
  const members = memberRows.sort((left, right) => (roleOrder.get(left.role) ?? 99) - (roleOrder.get(right.role) ?? 99) || left.user.name.localeCompare(right.user.name))
  const deliveries = await getInvitationDeliveries(createDb(env.DB), organizationId, invitationRows)
  const invitations = invitationRows.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .map(invitation => ({...invitation, delivery:deliveries.get(invitation.id) ?? null}))

  return { members, invitations }
}
