import { authClient } from '~/lib/auth-client'
import { isConversationEntriesPage, isConversationPage } from '~/lib/components/workspace/messages/guest-thread-client'
import type { ConversationEntriesPage, ConversationPage } from '~/shared/messages-contract'

/** Both activity scopes use the same message endpoint and one request per head page. */
export function useConversation(threadId: Ref<string> | ComputedRef<string>, personalScope = false) {
  const session = authClient.useSession()
  const userId = computed(() => session.value.data?.user.id)
  const dashboard = useDashboardOrganization()
  const realtime = useDashboardInvalidations()
  const organizationId = computed(() => personalScope ? undefined : dashboard.organizationId.value)
  const key = computed(() => `messages:${personalScope ? 'account:' + (userId.value ?? '') : organizationId.value}:${threadId.value}`)
  const path = computed(() => `/api/messages/${encodeURIComponent(threadId.value)}`)
  const readPage = (before: number, signal?: AbortSignal) => applicationFetch<ConversationEntriesPage>(path.value, {
    query: { before }, signal, validate: isConversationEntriesPage,
  })
  let readConnectionEpoch = 0
  let readUserId: string | undefined
  const request = useAsyncData(key, (_app, { signal }) => {
    if (!personalScope && !organizationId.value) throw createError({ statusCode: 400, statusMessage: 'Conversation requires a workspace' })
    readConnectionEpoch = realtime.connectionEpoch.value
    readUserId = userId.value
    return applicationFetch<ConversationPage>(path.value, { signal, validate: isConversationPage })
  }, { server: !personalScope })

  if (import.meta.client) {
    const recent = realtime.recentConversations
    const held = userId.value && realtime.status.value === 'open' ? recent.get(threadId.value) : undefined
    // Seed the existing request state while its fresh, authorized read runs.
    if (held && request.pending.value && !request.data.value) request.data.value = held
    watch([request.status, request.data], ([status, page]) => {
      if (status !== 'success' || !page || !readUserId || userId.value !== readUserId
        || realtime.status.value !== 'open' || readConnectionEpoch !== realtime.connectionEpoch.value) return
      const id = page.conversation.id
      if (id !== threadId.value || (!personalScope && page.conversation.organization_id !== organizationId.value)) return
      recent.delete(id)
      recent.set(id, page)
      const oldest = recent.keys().next().value
      if (recent.size > 5 && oldest) recent.delete(oldest)
    }, { immediate: true })
  }

  watch(request.error, error => {
    if (error?.statusCode === 401 || error?.statusCode === 403 || error?.statusCode === 404) {
      realtime.recentConversations.delete(threadId.value)
      request.data.value = undefined
    }
  }, { flush: 'sync' })

  return { request, readPage, path, organizationId, missedEvents: () => realtime.reconnectEpoch.value > readConnectionEpoch }
}
