import type { getOrganizationMembersData, getOrganizationTeamsData } from '~/server/utils/dashboard-members'
import { isRecord } from '~/utils/api-clients'

export type OrganizationMembersData = Awaited<ReturnType<typeof getOrganizationMembersData>> & {
  teams: Awaited<ReturnType<typeof getOrganizationTeamsData>>
}

export function isOrganizationMembersData(value: unknown): value is OrganizationMembersData {
  return isRecord(value) && Array.isArray(value.members)
    && value.members.every(member => isRecord(member) && typeof member.id === 'string' && typeof member.userId === 'string' && typeof member.role === 'string' && isRecord(member.user) && typeof member.user.name === 'string' && typeof member.user.email === 'string')
    && Array.isArray(value.invitations) && value.invitations.every(invitation => isRecord(invitation) && typeof invitation.id === 'string'
      && (invitation.delivery === null || isRecord(invitation.delivery) && typeof invitation.delivery.status === 'string' && typeof invitation.delivery.provider === 'string'))
    && Array.isArray(value.teams) && value.teams.every(team => isRecord(team) && typeof team.id === 'string' && typeof team.name === 'string' && typeof team.organization_id === 'string' && Array.isArray(team.member_user_ids) && team.member_user_ids.every(id => typeof id === 'string'))
}

/** The cache key the members list reads and the invite leaf refreshes. */
export const organizationMembersKey = (orgSlug: string) => `dashboard-org-members-${orgSlug}`
