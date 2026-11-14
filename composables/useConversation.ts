import { authClient } from '~/lib/auth-client'
import { isConversationPage } from '~/lib/components/workspace/messages/guest-thread-client'
import type { ConversationPage } from '~/shared/messages-contract'

/** Both activity scopes use the same message endpoint and one request per head page. */
export function useConversation(threadId: Ref<string> | ComputedRef<string>, personalScope = false) {
  const session = authClient.useSession()
  const dashboard = useDashboardOrganization()
  const organizationId = computed(() => personalScope ? undefined : dashboard.organizationId.value)
  const key = computed(() => `messages:${personalScope ? 'account:' + (session.value.data?.user.id ?? '') : organizationId.value}:${threadId.value}`)
  const path = computed(() => `/api/messages/${encodeURIComponent(threadId.value)}`)
  const readPage = (before?: number, signal?: AbortSignal) => applicationFetch<ConversationPage>(path.value, {
    query: { before }, signal, validate: isConversationPage,
  })
  const request = useAsyncData(key, (_app, { signal }) => {
    if (!personalScope && !organizationId.value) throw createError({ statusCode: 400, statusMessage: 'Conversation requires a workspace' })
    return readPage(undefined, signal)
  }, { server: !personalScope })

  watch(request.error, error => {
    if (error?.statusCode === 403 || error?.statusCode === 404) request.data.value = undefined
  }, { flush: 'sync' })

  return { request, readPage, path, organizationId }
}
