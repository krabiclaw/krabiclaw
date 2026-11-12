import { isRecord } from '~/utils/api-clients'
import type { TeamMember, TeamThread, TeamMessage } from '~/server/domain/team-messages'

export type { TeamMember, TeamThread, TeamMessage }
const nullableString = (value: unknown) => value === null || typeof value === 'string'
const identity = (value: unknown) => isRecord(value) && typeof value.id === 'string' && typeof value.member_id === 'string' && typeof value.name === 'string' && nullableString(value.image)

export function isTeamMembersResponse(value: unknown): value is { members: TeamMember[] } {
  return isRecord(value) && Array.isArray(value.members) && value.members.every(member => identity(member) && isRecord(member) && typeof member.email === 'string' && typeof member.role === 'string')
}

/** One team conversation as its screen draws it; what is unread is the conversation list's. */
export function isTeamThreadResponse(value: unknown, id: string): value is { thread: TeamThread } {
  const thread = isRecord(value) ? value.thread : null
  return isRecord(thread) && thread.id === id && typeof thread.created_at === 'string' && typeof thread.last_message_at === 'string'
    && nullableString(thread.name) && nullableString(thread.created_by_user_id)
    && typeof thread.is_group === 'boolean' && typeof thread.can_manage === 'boolean' && typeof thread.can_leave === 'boolean'
    && nullableString(thread.booking_id) && nullableString(thread.location_id)
    && (thread.record === null || isRecord(thread.record) && typeof thread.record.id === 'string' && typeof thread.record.title === 'string')
    && (thread.stay === null || isRecord(thread.stay) && typeof thread.stay.id === 'string' && typeof thread.stay.name === 'string' && typeof thread.stay.check_in_date === 'string' && typeof thread.stay.check_out_date === 'string')
    && (thread.job === null || isRecord(thread.job) && typeof thread.job.id === 'string' && typeof thread.job.version === 'number' && isRecord(thread.job.sheet) && isRecord(thread.job.can))
    && (thread.location === null || isRecord(thread.location) && typeof thread.location.id === 'string' && typeof thread.location.title === 'string')
    && Array.isArray(thread.participants) && thread.participants.every(identity)
}

function isTeamMessage(value: unknown): value is TeamMessage {
  return isRecord(value) && typeof value.id === 'string' && typeof value.conversation_id === 'string' && nullableString(value.author_user_id) && typeof value.automatic === 'boolean'
    && typeof value.body === 'string' && typeof value.created_at === 'string'
    && Array.isArray(value.attachments) && value.attachments.every(photo => isRecord(photo) && typeof photo.id === 'string' && typeof photo.url === 'string' && (photo.width === null || typeof photo.width === 'number') && (photo.height === null || typeof photo.height === 'number'))
    && Array.isArray(value.deliveries) && value.deliveries.every(delivery => isRecord(delivery) && typeof delivery.id === 'string' && (delivery.channel === 'email' || delivery.channel === 'whatsapp' || delivery.channel === 'push') && typeof delivery.status === 'string' && nullableString(delivery.error) && typeof delivery.updated_at === 'string')
}

export function isTeamMessagesResponse(value: unknown): value is { messages: TeamMessage[]; has_more: boolean } {
  return isRecord(value) && Array.isArray(value.messages) && value.messages.every(isTeamMessage) && typeof value.has_more === 'boolean'
    && (!value.has_more || value.messages.length > 0) && new Set(value.messages.map(message => message.id)).size === value.messages.length
}

export function isTeamMessageResponse(value: unknown): value is { message: TeamMessage } {
  return isRecord(value) && isTeamMessage(value.message)
}

export function teamThreadName(thread: TeamThread, userId: string | undefined) {
  if (thread.name !== null) return thread.name
  const others = thread.participants.filter(member => member.id !== userId)
  return others.length ? others.map(member => member.name).join(', ') : 'You'
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
  const { data, error, refresh } = await useTeamThread(threadId)
  const thread = computed(() => data.value?.thread ?? null)
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
        const saved = data.value?.thread
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

/** One team conversation: who is in it, what it is about and what this member may do to it. */
export async function useTeamThread(threadId: Ref<string> | ComputedRef<string>) {
  const dashboard = useDashboardOrganization()
  const api = useDashboardApi()
  return useAsyncData(
    () => `team-conversation:${dashboard.organizationId.value}:${threadId.value}`,
    () => api(`/api/dashboard/team/threads/${encodeURIComponent(threadId.value)}/messages`, { query: { limit: 1 }, validate: (value): value is { thread: TeamThread } => isTeamThreadResponse(value, threadId.value) }),
    {
      getCachedData(cacheKey, nuxtApp, ctx) {
        if (ctx?.cause === 'refresh:manual' || ctx?.cause === 'refresh:hook') return undefined
        return nuxtApp.payload.data[cacheKey] as { thread: TeamThread } | undefined
      },
    },
  )
}
