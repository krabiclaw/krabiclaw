import { authClient } from '~/lib/auth-client'
import { isConversationEntriesPage, isConversationPage } from '~/lib/components/workspace/messages/guest-thread-client'
import type { ConversationEntriesPage, ConversationPage } from '~/shared/messages-contract'

/** The live session keeps the five most recently read conversation heads. */
function holdRecentConversation(recent: Map<string, ConversationPage>, page: ConversationPage) {
  recent.delete(page.conversation.id)
  recent.set(page.conversation.id, page)
  const oldest = recent.keys().next().value
  if (recent.size > 5 && oldest) recent.delete(oldest)
}

/**
 * Reads the heads of conversations the list shows before one is opened, so
 * opening it draws from the live session's recent conversations. A read ends
 * unheld when its conversation, the reader's access or the connection changes.
 */
export function useConversationPrefetch(personalScope = false) {
  const session = authClient.useSession()
  const userId = computed(() => session.value.data?.user.id)
  const dashboard = useDashboardOrganization()
  const realtime = useDashboardInvalidations()
  const organizationId = computed(() => personalScope ? undefined : dashboard.organizationId.value)
  const reads = new Map<string, AbortController>()
  function end(conversationId?: string) {
    for (const [id, read] of reads) {
      if (conversationId && id !== conversationId) continue
      read.abort()
      reads.delete(id)
      realtime.conversationReads.delete(id)
    }
  }
  watch(realtime.event, event => {
    if (!event) return
    if (event.type === 'access.changed') end()
    else if ('conversation_id' in event && !('scheduled' in event && event.scheduled)) end(event.conversation_id)
  }, { flush: 'sync' })
  watch([realtime.status, realtime.connectionEpoch, realtime.accessEnded, userId, organizationId], () => end(), { flush: 'sync' })
  onBeforeUnmount(() => end())

  async function read(conversationId: string, signal: AbortSignal): Promise<ConversationPage | undefined> {
    let page: ConversationPage
    try {
      page = await applicationFetch<ConversationPage>(`/api/messages/${encodeURIComponent(conversationId)}`, { signal, validate: isConversationPage })
    } catch (error) {
      if (signal.aborted) return undefined
      reads.delete(conversationId)
      realtime.conversationReads.delete(conversationId)
      throw error
    }
    if (signal.aborted) return undefined
    reads.delete(conversationId)
    realtime.conversationReads.delete(conversationId)
    if (page.conversation.id !== conversationId || (!personalScope && page.conversation.organization_id !== organizationId.value)) return undefined
    holdRecentConversation(realtime.recentConversations, page)
    return page
  }

  return function prefetch(conversationId: string): Promise<ConversationPage | undefined> | undefined {
    if (!userId.value || realtime.status.value !== 'open' || (!personalScope && !organizationId.value)
      || realtime.recentConversations.has(conversationId) || reads.has(conversationId)) return undefined
    const controller = new AbortController()
    reads.set(conversationId, controller)
    const reading = read(conversationId, controller.signal)
    realtime.conversationReads.set(conversationId, reading)
    return reading
  }
}

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
    // A head the list is already reading is this conversation's read; a failed or ended one is read here.
    const reading = realtime.conversationReads.get(threadId.value)
    const open = () => applicationFetch<ConversationPage>(path.value, { signal, validate: isConversationPage })
    return reading ? reading.then(page => page ?? open(), open) : open()
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
      holdRecentConversation(recent, page)
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
