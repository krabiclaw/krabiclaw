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

/** Each unfinished action keeps its key until its result has been read back. */
export async function useTeamGroup() {
  const route = useRoute()
  const api = useDashboardApi()
  const threadId = computed(() => String(route.params.conversation_id))
  const { data, error, refresh } = await useConversation(threadId).request
  const thread = computed(() => data.value?.conversation.kind === 'team' ? data.value.conversation : null)
  const leaving = useTeamGroupLeaveRequest()
  const keys = new Map<string, string>()
  async function operate(operation: TeamGroupOperation) {
    const id = threadId.value
    const identity = JSON.stringify([id, operation])
    if (!keys.has(identity)) keys.set(identity, crypto.randomUUID())
    if (operation.action === 'leave') leaving.value = id
    try {
      const result = await api(`/api/dashboard/team/threads/${encodeURIComponent(id)}/operations`, {
        method: 'POST', body: { ...operation, idempotency_key: keys.get(identity) },
        validate: (value): value is { status: 'updated' | 'left'; conversation_id: string } => isRecord(value)
          && value.conversation_id === id && value.status === (operation.action === 'leave' ? 'left' : 'updated'),
      })
      await refresh()
      // Having left, the conversation is no longer this member's to read: 404 is the proof.
      if (operation.action === 'leave') {
        if (error.value?.statusCode !== 404) throw new Error('Leaving the conversation could not be verified. Retry the same action.')
      } else {
        if (error.value) throw error.value
        const saved = thread.value
        const verified = saved && (
          operation.action === 'rename' ? saved.name === operation.name
            : operation.action === 'add' ? operation.member_user_ids.every(userId => saved.participants.some(person => person.id === userId))
              : !saved.participants.some(person => person.id === operation.user_id))
        if (!verified) throw new Error('The conversation change could not be verified. Retry the same action.')
      }
      keys.delete(identity)
      return result
    } finally { if (leaving.value === id) leaving.value = null }
  }
  return { thread, error, operate }
}
