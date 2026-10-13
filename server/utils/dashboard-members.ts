import type { CloudflareEnv } from '~/server/utils/auth'
import { listAllOrganizationMembers, organizationAdapter } from '~/server/utils/member-access'
import { betterAuthTimestampToIso, type BetterAuthTimestamp } from '~/server/utils/better-auth-timestamps'
import { createDb, queryAll, type DbClient } from '~/server/db'
import type { GuestThreadDeliveryRow } from '~/server/domain/guest-threads/types'

type InvitationDelivery = Pick<GuestThreadDeliveryRow, 'status' | 'provider' | 'provider_message_id' | 'error'>

export async function getInvitationDeliveries(db: DbClient, organizationId: string, invitations: {id:string;expiresAt:string}[]) {
  const rows = invitations.length ? await queryAll<InvitationDelivery & {id:string}>(db, `SELECT d.id,d.status,d.provider,d.provider_message_id,d.error FROM guest_thread_deliveries d
    JOIN activity_entries a ON a.id=d.entry_id WHERE a.organization_id=? AND a.scope_kind='organization' AND a.event_name='member.invited'
      AND d.id IN (SELECT value FROM json_each(?))`, [organizationId, JSON.stringify(invitations.map(invitation => `organization-invitation-email:${invitation.id}:${invitation.expiresAt}`))]) : []
  const byId = new Map(rows.map(({id,...delivery}) => [id, delivery]))
  return new Map(invitations.map(invitation => [invitation.id, byId.get(`organization-invitation-email:${invitation.id}:${invitation.expiresAt}`) ?? null]))
}

export async function getOrganizationTeamsData(env: CloudflareEnv, organizationId: string) {
  const adapter = await organizationAdapter(env)
  const teams = await adapter.listTeams(organizationId)
  return Promise.all(teams.map(async team => ({
    id: team.id, name: team.name, organization_id: team.organizationId,
    created_at: betterAuthTimestampToIso(team.createdAt as BetterAuthTimestamp, 'team.createdAt'),
    updated_at: team.updatedAt ? betterAuthTimestampToIso(team.updatedAt as BetterAuthTimestamp, 'team.updatedAt') : null,
    member_user_ids: (await adapter.listTeamMembers({ teamId: team.id })).map(member => member.userId),
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
  const members = memberRows.map(member => ({
    ...member,
    createdAt: betterAuthTimestampToIso(member.createdAt as BetterAuthTimestamp, 'member.createdAt'),
  })).sort((left, right) => (roleOrder.get(left.role) ?? 99) - (roleOrder.get(right.role) ?? 99) || left.user.name.localeCompare(right.user.name))

  const invitationFacts = invitationRows.map(invitation => ({
    ...invitation,
    expiresAt: betterAuthTimestampToIso(invitation.expiresAt as BetterAuthTimestamp, 'invitation.expiresAt'),
    createdAt: betterAuthTimestampToIso(invitation.createdAt as BetterAuthTimestamp, 'invitation.createdAt'),
  })).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const deliveries = await getInvitationDeliveries(createDb(env.DB), organizationId, invitationFacts)
  const invitations = invitationFacts.map(invitation => ({...invitation, delivery:deliveries.get(invitation.id) ?? null}))

  return { members, invitations }
}
