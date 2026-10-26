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
  const others = thread.participants.filter(member => member.id !== userId)
  return others.length ? others.map(member => member.name).join(', ') : 'You'
}

export async function useTeamThreads() {
  const dashboard = useDashboardOrganization()
  const api = useDashboardApi()
  return useAsyncData(() => `team-threads:${dashboard.organizationId.value}`, () => api('/api/dashboard/team/threads', { validate: isTeamThreadsResponse }))
}
