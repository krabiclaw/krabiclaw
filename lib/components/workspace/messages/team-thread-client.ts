import { isRecord } from '~/utils/api-clients'
import type { TeamMember } from '~/server/domain/team-messages'
const nullableString = (value: unknown) => value === null || typeof value === 'string'
const identity = (value: unknown) => isRecord(value) && typeof value.id === 'string' && typeof value.member_id === 'string' && typeof value.name === 'string' && nullableString(value.image)

export function isTeamMembersResponse(value: unknown): value is { members: TeamMember[] } {
  return isRecord(value) && Array.isArray(value.members) && value.members.every(member => identity(member) && isRecord(member) && typeof member.email === 'string' && typeof member.role === 'string')
}

export type TeamGroupOperation =
  | { action: 'rename'; name: string | null }
  | { action: 'add'; member_user_ids: string[] }
  | { action: 'remove'; user_id: string }
  | { action: 'leave' }

/** Keep the leave form alive until its keyed request reports its result. */
export const useTeamGroupLeaveRequest = () => useState<string | null>('team-group-leave-request', () => null)
