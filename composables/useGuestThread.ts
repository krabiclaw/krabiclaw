import { authClient } from '~/lib/auth-client'
import { isPagedThreadResponse, isThreadDetailResponse, type PagedThread, type ThreadDetail } from '~/lib/components/workspace/messages/guest-thread-client'

/**
 * One guest thread, loaded once per route.
 *
 * The conversation and the record behind it are two levels of the same editor
 * chain and both need this thread: the conversation to draw it, the record
 * level to know which booking it refers to. Both call this, and the shared
 * `useAsyncData` key means that is one request.
 */
export async function useGuestThread(threadId: Ref<string> | ComputedRef<string>, personalScope: Ref<boolean> | ComputedRef<boolean> = ref(false), paged = false) {
  const session = authClient.useSession()
  const dashboard = useDashboardOrganization()
  const dashboardScope = useDashboardRouteScope()
  const dashboardApi = useDashboardApi(dashboardScope)

  const organizationId = computed(() => dashboard.organizationId.value)
  const key = computed(() => `${personalScope.value ? `account-guest-thread:${session.value.data?.user.id}` : `dashboard-guest-thread:${organizationId.value ?? 'pending-organization'}${paged ? ':paged' : ''}`}:${threadId.value}`)

  const path = computed(() => `/api/dashboard/organizations/${organizationId.value}/guest-threads/${encodeURIComponent(threadId.value)}`)
  const readPage = (before?: number, signal?: AbortSignal) => dashboardApi<{ thread: PagedThread }>(`${path.value}/transcript`, {
    query: before === undefined ? undefined : { before }, signal, validate: isPagedThreadResponse,
  })

  const { data, pending, error, refresh, clear } = await useAsyncData<{ thread: ThreadDetail }>(key, async (_app, { signal }) => {
    if (personalScope.value) return await applicationFetch<{thread:ThreadDetail}>(`/api/account/messages/${encodeURIComponent(threadId.value)}`,{signal,validate:isThreadDetailResponse})
    if (!dashboardScope.value) {
      throw createError({ statusCode: 400, statusMessage: 'Dashboard route scope is incomplete' })
    }
    if (!organizationId.value) {
      throw createError({ statusCode: 400, statusMessage: 'Thread detail requires organization scope' })
    }
    if (paged) return await readPage(undefined, signal)
    return await dashboardApi<{ thread: ThreadDetail }>(
      path.value,
      { signal, validate: isThreadDetailResponse },
    )
  }, { server: !personalScope.value })

  // A revoked resource is no longer a displayable cached conversation.
  watch(error, cause => {
    if (cause?.statusCode === 403 || cause?.statusCode === 404) data.value = undefined
  }, { flush: 'sync' })

  const thread = computed(() => data.value?.thread ?? null)

  return { data, thread, pending, error, refresh, clear, organizationId, readPage }
}
