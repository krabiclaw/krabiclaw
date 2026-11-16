import { authClient } from '~/lib/auth-client'
import { isConversationEntriesPage, isConversationPage } from '~/lib/components/workspace/messages/guest-thread-client'
import type { ConversationEntriesPage, ConversationPage } from '~/shared/messages-contract'
import type { HeldRead, HeldReads } from '~/composables/useDashboardInvalidations'

/** The live session holds the five most recently read conversation heads, until the conversation, or access to its workspace, changes. */
function beginConversation(held: HeldReads, id: string, reader: string | undefined) {
  return held.begin(`conversation:${id}`, (event, page) =>
    (event.type === 'CONVERSATION_LEAVE' && event.user_id === reader && event.conversation_id === id)
    || (event.type === 'access.changed' && (!isConversationPage(page) || page.conversation.organization_id === event.organization_id))
    || ((event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE') && !event.scheduled && event.conversation_id === id))
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
    const reading = beginConversation(realtime.held, conversationId, userId.value)
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
    realtime.held.hold(reading, page, undefined, 5)
    return page
  }

  return function prefetch(conversationId: string): Promise<ConversationPage | undefined> | undefined {
    if (!userId.value || realtime.status.value !== 'open' || (!personalScope && !organizationId.value)
      || realtime.held.get(`conversation:${conversationId}`) || reads.has(conversationId)) return undefined
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
  let holding: HeldRead | undefined
  const request = useAsyncData(key, (_app, { signal }) => {
    if (!personalScope && !organizationId.value) throw createError({ statusCode: 400, statusMessage: 'Conversation requires a workspace' })
    readConnectionEpoch = realtime.connectionEpoch.value
    holding = beginConversation(realtime.held, threadId.value, userId.value)
    // A head the list is already reading is this conversation's read; a failed or ended one is read here.
    const reading = realtime.conversationReads.get(threadId.value)
    const open = () => applicationFetch<ConversationPage>(path.value, { signal, validate: isConversationPage })
    return reading ? reading.then(page => page ?? open(), open) : open()
  }, { server: !personalScope })

  if (import.meta.client) {
    const held = userId.value ? realtime.held.get(`conversation:${threadId.value}`) : undefined
    // Seed the existing request state while its fresh, authorized read runs.
    if (isConversationPage(held) && request.pending.value && !request.data.value) request.data.value = held
    watch([request.status, request.data], ([status, page]) => {
      if (status !== 'success' || !page || !holding || !userId.value || page.conversation.id !== threadId.value
        || (!personalScope && page.conversation.organization_id !== organizationId.value)) return
      realtime.held.hold(holding, page, undefined, 5)
    }, { immediate: true })
  }

  watch(request.error, error => {
    if (error?.statusCode === 401 || error?.statusCode === 403 || error?.statusCode === 404) {
      realtime.held.take(`conversation:${threadId.value}`)
      request.data.value = undefined
    }
  }, { flush: 'sync' })

  return { request, readPage, path, organizationId, missedEvents: () => realtime.reconnectEpoch.value > readConnectionEpoch }
}
