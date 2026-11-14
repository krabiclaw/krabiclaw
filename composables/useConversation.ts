import { authClient } from '~/lib/auth-client'
import { isConversationEntriesPage, isConversationPage } from '~/lib/components/workspace/messages/guest-thread-client'
import type { ConversationEntriesPage, ConversationPage } from '~/shared/messages-contract'

/** Both activity scopes use the same message endpoint and one request per head page. */
export function useConversation(threadId: Ref<string> | ComputedRef<string>, personalScope = false) {
  const session = authClient.useSession()
  const dashboard = useDashboardOrganization()
  const realtime = useDashboardInvalidations()
  const organizationId = computed(() => personalScope ? undefined : dashboard.organizationId.value)
  const key = computed(() => `messages:${personalScope ? 'account:' + (session.value.data?.user.id ?? '') : organizationId.value}:${threadId.value}`)
  const path = computed(() => `/api/messages/${encodeURIComponent(threadId.value)}`)
  const readPage = (before: number, signal?: AbortSignal) => applicationFetch<ConversationEntriesPage>(path.value, {
    query: { before }, signal, validate: isConversationEntriesPage,
  })
  let readConnectionEpoch = 0
  const request = useAsyncData(key, (_app, { signal }) => {
    if (!personalScope && !organizationId.value) throw createError({ statusCode: 400, statusMessage: 'Conversation requires a workspace' })
    readConnectionEpoch = realtime.connectionEpoch.value
    return applicationFetch<ConversationPage>(path.value, { signal, validate: isConversationPage })
  }, { server: !personalScope })

  watch(request.error, error => {
    if (error?.statusCode === 403 || error?.statusCode === 404) request.data.value = undefined
  }, { flush: 'sync' })

  return { request, readPage, path, organizationId, missedEvents: () => realtime.connectionEpoch.value > readConnectionEpoch }
}
