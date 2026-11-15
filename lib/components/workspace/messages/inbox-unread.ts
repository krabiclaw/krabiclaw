import { authClient } from '~/lib/auth-client'

/** Whether a reader's Current mailbox holds an unread conversation, per workspace and independent of list filters. */
export function useInboxUnread(organizationId: Ref<string | null | undefined>) {
  const session = authClient.useSession()
  const scopes = useState<Record<string, boolean | null>>('inbox-unread', () => ({}))
  const key = computed(() => JSON.stringify([session.value.data?.user.id, organizationId.value]))
  return computed({
    get: () => scopes.value[key.value] ?? null,
    set: value => { scopes.value[key.value] = value },
  })
}

export function usePersonalInboxUnread() {
  const session = authClient.useSession()
  const scopes = useState<Record<string, boolean | null>>('personal-inbox-unread', () => ({}))
  const key = computed(() => session.value.data?.user.id ?? '')
  return computed({
    get: () => scopes.value[key.value] ?? null,
    set: value => { scopes.value[key.value] = value },
  })
}
