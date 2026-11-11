import type { InboxUnreadCounts } from '~/server/domain/guest-threads/types'

/**
 * The unread conversations per kind, as the last list read reported them. The
 * list and the filter menu beside it share this one value rather than each
 * asking the server.
 */
export function useInboxUnread(organizationId: Ref<string | null | undefined>) {
  return useState<InboxUnreadCounts | null>(computed(() => `inbox-unread:${organizationId.value ?? 'none'}`).value, () => null)
}
