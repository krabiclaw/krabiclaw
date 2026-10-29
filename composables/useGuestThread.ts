import { authClient } from '~/lib/auth-client'
import { isThreadDetailResponse, type ThreadDetail } from '~/lib/components/workspace/messages/guest-thread-client'

/**
 * One guest thread, loaded once per route.
 *
 * The conversation and the record behind it are two levels of the same editor
 * chain and both need this thread: the conversation to draw it, the record
 * level to know which booking it refers to. Both call this, and the shared
 * `useAsyncData` key means that is one request.
 */
export async function useGuestThread(threadId: Ref<string> | ComputedRef<string>, personalScope: Ref<boolean> | ComputedRef<boolean> = ref(false)) {
  const session = authClient.useSession()
  const dashboard = useDashboardOrganization()
  const dashboardScope = useDashboardRouteScope()
  const dashboardApi = useDashboardApi(dashboardScope)

  const organizationId = computed(() => dashboard.organizationId.value)
  const key = computed(() => `${personalScope.value ? `account-guest-thread:${session.value.data?.user.id}` : `dashboard-guest-thread:${organizationId.value ?? 'pending-organization'}`}:${threadId.value}`)

  const { data, pending, error, refresh } = await useAsyncData<{ thread: ThreadDetail }>(key, async () => {
    if (personalScope.value) return await applicationFetch<{thread:ThreadDetail}>(`/api/account/messages/${encodeURIComponent(threadId.value)}`,{validate:isThreadDetailResponse})
    if (!dashboardScope.value) {
      throw createError({ statusCode: 400, statusMessage: 'Dashboard route scope is incomplete' })
    }
    if (!organizationId.value) {
      throw createError({ statusCode: 400, statusMessage: 'Thread detail requires organization scope' })
    }
    return await dashboardApi<{ thread: ThreadDetail }>(
      `/api/dashboard/organizations/${organizationId.value}/guest-threads/${threadId.value}`,
      { validate: isThreadDetailResponse },
    )
  }, { server: !personalScope.value })

  // A revoked resource is no longer a displayable cached conversation.
  watch(error, cause => {
    if (cause?.statusCode === 403 || cause?.statusCode === 404) data.value = undefined
  }, { flush: 'sync' })

  const thread = computed(() => data.value?.thread ?? null)

  return { data, thread, pending, error, refresh, organizationId }
}
