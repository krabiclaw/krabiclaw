import { authClient } from '~/lib/auth-client'
import type { InboxUnreadCounts } from '~/server/domain/guest-threads/types'

/** The current mailbox count belongs to a reader and workspace, independent of list filters. */
export function useInboxUnread(organizationId: Ref<string | null | undefined>) {
  const session = authClient.useSession()
  const scopes = useState<Record<string, InboxUnreadCounts | null>>('inbox-unread', () => ({}))
  const key = computed(() => JSON.stringify([session.value.data?.user.id, organizationId.value]))
  return computed({
    get: () => scopes.value[key.value] ?? null,
    set: value => { scopes.value[key.value] = value },
  })
}

export function usePersonalInboxUnread() {
  const session = authClient.useSession()
  const counts = useState<Record<string, number | null>>('personal-inbox-unread', () => ({}))
  const key = computed(() => session.value.data?.user.id ?? '')
  return computed({
    get: () => counts.value[key.value] ?? null,
    set: count => { counts.value[key.value] = count },
  })
}

export function isInboxUnread(value: unknown): value is InboxUnreadCounts {
  if (!isRecord(value)) return false
  const { all, guests, support, team } = value
  return [all, guests, support, team].every(count => Number.isSafeInteger(count) && Number(count) >= 0)
    && all === Number(guests) + Number(support) + Number(team)
}
