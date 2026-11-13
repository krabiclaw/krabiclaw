import { organizationOptions, type CloudflareEnv } from '~/server/utils/auth'
import { listAllOrganizationMembers, organizationAdapter, roleAllows } from '~/server/utils/member-access'
import { createDb, queryAll, type DbClient } from '~/server/db'
import { isDeliverySent } from '~/server/domain/guest-threads/deliveries'
import { organizationRoleLabel } from '~/utils/organization-access'
import type { GuestThreadDeliveryRow } from '~/server/domain/guest-threads/types'

type InvitationDelivery = Pick<GuestThreadDeliveryRow, 'status' | 'provider' | 'provider_message_id' | 'error'>

export async function getInvitationDeliveries(db: DbClient, organizationId: string, invitations: { id: string }[]) {
  if (!invitations.length) return new Map<string, InvitationDelivery>()
  // The invitation's audit entry owns every send. Better Auth can update expiresAt
  // when resending, and the stored expiry has lower precision than the email hook.
  const rows = await queryAll<InvitationDelivery & { invitationId: string }>(db, `
    SELECT requested.value AS invitationId, d.status, d.provider, d.provider_message_id, d.error
    FROM json_each(?) requested
    JOIN activity_entries a ON a.dedupe_key = 'organization-invitation:' || requested.value
      AND a.organization_id = ? AND a.event_name = 'member.invited'
    JOIN guest_thread_deliveries d ON d.id = (
      SELECT receipt.id FROM guest_thread_deliveries receipt
      WHERE receipt.activity_entry_id = a.id AND receipt.channel = 'email'
      ORDER BY receipt.created_at DESC, receipt.id DESC LIMIT 1
    )`, [JSON.stringify(invitations.map(invitation => invitation.id)), organizationId])
  return new Map(rows.map(({ invitationId, ...delivery }) => [invitationId, delivery]))
}

export async function getOrganizationMembersData(env: CloudflareEnv, organization: { id: string; role: string }, userId: string) {
  const principal = { organizationId: organization.id, role: organization.role }
  const [canInvite, canCancel, canUpdate, canRemove] = await Promise.all([
    roleAllows({ ...principal, permissions: { invitation: ['create'] } }),
    roleAllows({ ...principal, permissions: { invitation: ['cancel'] } }),
    roleAllows({ ...principal, permissions: { member: ['update'] } }),
    roleAllows({ ...principal, permissions: { member: ['delete'] } }),
  ])
  const creatorRole = organizationOptions.creatorRole
  const hasCreatorRole = (role: string) => role.split(',').map(value => value.trim()).includes(creatorRole)
  const roleLabel = (role: string) => role.split(',').map(value => organizationRoleLabel(value.trim())).join(', ')
  const canGrantOwner = hasCreatorRole(organization.role)
  const roleChoices = (['member', 'admin', creatorRole] as const)
    .filter(role => role !== creatorRole || canGrantOwner)
    .map(value => ({ value, label: organizationRoleLabel(value) }))
  const inviteRoles = canInvite ? roleChoices : []
  const adapter = await organizationAdapter(env)
  const [memberRows, invitationRows] = await Promise.all([
    listAllOrganizationMembers(adapter, organization.id),
    canInvite || canCancel ? adapter.findPendingInvitations({ organizationId: organization.id }) : [],
  ])
  const onlyOwner = memberRows.filter(member => hasCreatorRole(member.role)).length === 1
  const roleOrder = new Map([['owner', 0], ['admin', 1]])
  const members = memberRows.sort((left, right) => (roleOrder.get(left.role) ?? 99) - (roleOrder.get(right.role) ?? 99) || left.user.name.localeCompare(right.user.name))
    .map(member => {
      const owner = hasCreatorRole(member.role)
      return {
        id: member.id,
        userId: member.userId,
        user: { name: member.user.name, email: member.user.email, image: member.user.image ?? null },
        role: member.role,
        roleLabel: roleLabel(member.role),
        roleChoices: canUpdate && (!owner || canGrantOwner) && !(owner && onlyOwner && member.userId === userId) ? roleChoices : [],
        canRemove: canRemove && !owner && member.userId !== userId,
      }
    })
  const deliveries = await getInvitationDeliveries(createDb(env.DB), organization.id, invitationRows)
  const invitations = invitationRows.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .map(invitation => {
      const delivery = deliveries.get(invitation.id) ?? null
      return {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        roleLabel: roleLabel(invitation.role),
        expiresAt: invitation.expiresAt,
        canResend: canInvite && (!hasCreatorRole(invitation.role) || canGrantOwner),
        canCancel,
        delivery: {
          sent: delivery !== null && isDeliverySent(delivery),
          failed: delivery?.status === 'failed',
          message: delivery?.error || (delivery ? 'Email: ' + (delivery.provider === 'log_only' ? 'recorded locally' : delivery.status) : 'Email delivery is unconfirmed'),
        },
      }
    })

  return { members, invitations, inviteRoles }
}
