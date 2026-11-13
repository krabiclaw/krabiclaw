import type { getOrganizationMembersData } from '~/server/utils/dashboard-members'
import type { Serialize } from 'nitro/types'
import { isRecord } from '~/utils/api-clients'

export type OrganizationMembersData = Serialize<Awaited<ReturnType<typeof getOrganizationMembersData>>>

export function isOrganizationMembersData(value: unknown): value is OrganizationMembersData {
  const roles = (items: unknown) => Array.isArray(items) && items.every(item => isRecord(item) && typeof item.label === 'string'
    && (item.value === 'member' || item.value === 'admin' || item.value === 'owner'))
  return isRecord(value) && roles(value.inviteRoles) && Array.isArray(value.members)
    && value.members.every(member => isRecord(member) && typeof member.id === 'string' && typeof member.userId === 'string'
      && typeof member.role === 'string' && typeof member.roleLabel === 'string' && roles(member.roleChoices) && typeof member.canRemove === 'boolean'
      && isRecord(member.user) && typeof member.user.name === 'string' && typeof member.user.email === 'string')
    && Array.isArray(value.invitations) && value.invitations.every(invitation => isRecord(invitation) && typeof invitation.id === 'string'
      && typeof invitation.email === 'string' && typeof invitation.role === 'string' && typeof invitation.roleLabel === 'string'
      && typeof invitation.expiresAt === 'string' && typeof invitation.canCancel === 'boolean' && typeof invitation.canResend === 'boolean'
      && isRecord(invitation.delivery) && typeof invitation.delivery.sent === 'boolean' && typeof invitation.delivery.failed === 'boolean' && typeof invitation.delivery.message === 'string')
}

/** The cache key the members list reads and the invite leaf refreshes. */
export const organizationMembersKey = (orgSlug: string) => `dashboard-org-members-${orgSlug}`
