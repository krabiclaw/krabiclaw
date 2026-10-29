import { isRecord } from '~/utils/api-clients'
import type { TeamMember, TeamThread, TeamMessage } from '~/server/domain/team-messages'

export type { TeamMember, TeamThread, TeamMessage }
const nullableString = (value: unknown) => value === null || typeof value === 'string'
const identity = (value: unknown) => isRecord(value) && typeof value.id === 'string' && typeof value.memberId === 'string' && typeof value.name === 'string' && nullableString(value.image)

export function isTeamMembersResponse(value: unknown): value is { members: TeamMember[] } {
  return isRecord(value) && Array.isArray(value.members) && value.members.every(member => identity(member) && isRecord(member) && typeof member.email === 'string' && typeof member.role === 'string')
}

export function isTeamThreadsResponse(value: unknown): value is { threads: TeamThread[] } {
  return isRecord(value) && Array.isArray(value.threads) && value.threads.every(thread => isRecord(thread)
    && typeof thread.id === 'string' && typeof thread.createdAt === 'string' && typeof thread.lastMessageAt === 'string'
    && nullableString(thread.name) && nullableString(thread.createdByUserId)
    && typeof thread.isGroup === 'boolean' && typeof thread.canManage === 'boolean' && typeof thread.canLeave === 'boolean'
    && nullableString(thread.stayId) && nullableString(thread.locationId)
    && (thread.stay === null || isRecord(thread.stay) && typeof thread.stay.id === 'string' && typeof thread.stay.homeName === 'string' && typeof thread.stay.checkInDate === 'string' && typeof thread.stay.checkOutDate === 'string')
    && (thread.location === null || isRecord(thread.location) && typeof thread.location.id === 'string' && typeof thread.location.title === 'string')
    && Array.isArray(thread.participants) && thread.participants.every(identity)
    && (thread.lastMessage === null || isRecord(thread.lastMessage) && typeof thread.lastMessage.id === 'string' && typeof thread.lastMessage.body === 'string' && typeof thread.lastMessage.attachmentCount === 'number')
    && typeof thread.unread === 'boolean' && typeof thread.unreadCount === 'number')
}

function isTeamMessage(value: unknown): value is TeamMessage {
  return isRecord(value) && typeof value.id === 'string' && typeof value.threadId === 'string' && nullableString(value.senderId)
    && typeof value.body === 'string' && typeof value.createdAt === 'string'
    && Array.isArray(value.attachments) && value.attachments.every(photo => isRecord(photo) && typeof photo.id === 'string' && typeof photo.url === 'string' && (photo.width === null || typeof photo.width === 'number') && (photo.height === null || typeof photo.height === 'number'))
    && Array.isArray(value.deliveries) && value.deliveries.every(delivery => isRecord(delivery) && typeof delivery.id === 'string' && delivery.channel === 'push' && typeof delivery.status === 'string' && nullableString(delivery.error) && typeof delivery.updatedAt === 'string')
}

export function isTeamMessagesResponse(value: unknown): value is { messages: TeamMessage[]; hasMore: boolean } {
  return isRecord(value) && Array.isArray(value.messages) && value.messages.every(isTeamMessage) && typeof value.hasMore === 'boolean'
    && (!value.hasMore || value.messages.length > 0) && new Set(value.messages.map(message => message.id)).size === value.messages.length
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
  | { action: 'add'; memberIds: string[] }
  | { action: 'remove'; userId: string }
  | { action: 'leave' }

/** Keep the leave form alive until its keyed request reports its result. */
export const useTeamGroupLeaveRequest = () => useState<string | null>('team-group-leave-request', () => null)

/** Each unfinished action keeps its key until its result has been read back. */
export async function useTeamGroup() {
  const route = useRoute()
  const api = useDashboardApi()
  const { data, error, refresh } = await useTeamThreads()
  const threadId = computed(() => String(route.params.teamThreadId))
  const thread = computed(() => data.value?.threads.find(item => item.id === threadId.value) ?? null)
  const leaving = useTeamGroupLeaveRequest()
  const keys = new Map<string, string>()
  async function operate(operation: TeamGroupOperation) {
    const id = threadId.value
    const identity = JSON.stringify([id, operation])
    if (!keys.has(identity)) keys.set(identity, crypto.randomUUID())
    if (operation.action === 'leave') leaving.value = id
    try {
      const result = await api(`/api/dashboard/team/threads/${encodeURIComponent(id)}/operations`, {
        method: 'POST', body: { ...operation, idempotencyKey: keys.get(identity) },
        validate: (value): value is { status: 'updated' | 'left'; threadId: string } => isRecord(value)
          && value.threadId === id && value.status === (operation.action === 'leave' ? 'left' : 'updated'),
      })
      await refresh()
      if (error.value) throw error.value
      const saved = data.value?.threads.find(item => item.id === id)
      const verified = operation.action === 'leave' ? !saved : saved && (
        operation.action === 'rename' ? saved.name === operation.name
          : operation.action === 'add' ? operation.memberIds.every(userId => saved.participants.some(person => person.id === userId))
            : !saved.participants.some(person => person.id === operation.userId))
      if (!verified) throw new Error('The conversation change could not be verified. Retry the same action.')
      keys.delete(identity)
      return result
    } finally { if (leaving.value === id) leaving.value = null }
  }
  return { thread, error, operate }
}

export async function useTeamThreads() {
  const dashboard = useDashboardOrganization()
  const api = useDashboardApi()
  return useAsyncData(() => `team-threads:${dashboard.organizationId.value}`, () => api('/api/dashboard/team/threads', { validate: isTeamThreadsResponse }))
}
