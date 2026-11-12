<template>
  <div
    class="flex min-h-0 w-full min-w-0 flex-1 flex-col"
    :data-conversation-list-hydrated="listHydrated ? 'true' : 'false'"
  >
    <!-- The list's controls: Airbnb's two pills, the kind menu and Unread. Search and settings sit beside the title. -->
    <header class="shrink-0 pb-2" :class="dashboardGutterClass">
      <slot name="filters" />
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto" :class="dashboardGutterClass">
      <UAlert
        v-if="threadsError || nextPageError"
        color="error"
        variant="soft"
        class="mb-3"
        title="Messages could not be loaded"
        :description="getErrorMessage(threadsError || nextPageError, 'Guest thread request failed')"
      />

      <!-- A conversation that gains a message slides to its new place; one
           that leaves this list fades and the rest close up behind it. -->
      <TransitionGroup
        tag="div"
        class="relative -mx-3"
        move-class="transition-transform duration-300 ease-out motion-reduce:transition-none"
        enter-from-class="opacity-0 -translate-y-1"
        enter-active-class="transition duration-300 ease-out motion-reduce:transition-none"
        leave-to-class="opacity-0"
        leave-active-class="absolute inset-x-0 transition-opacity duration-200 motion-reduce:transition-none"
      >
        <MessageRowActions
          v-for="thread in threads"
          :key="thread.id"
          :unread="thread.unread"
          :name="thread.title"
          :enabled="!personalScope"
          :archivable="!pastOnly && !blockedOnly"
          @toggle="toggleRead(thread)"
          @archive="archive(thread)"
        >
          <NuxtLink
            :to="{ path: threadRoute(thread), query: route.query }"
            :data-thread-row="thread.id"
            :aria-current="thread.id === openThreadId ? 'page' : undefined"
            class="relative flex items-start gap-4 rounded-xl py-4 pl-7 pr-3 transition duration-200 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            :class="thread.id === openThreadId ? 'bg-elevated' : 'hover:bg-elevated/60'"
          >
            <span v-if="thread.unread" class="absolute left-2.5 top-[38px] size-2 rounded-full bg-primary" :aria-label="`${thread.title}: unread`" />
            <InboxAvatar :name="thread.title" :initial="thread.avatar_initial" :support="thread.kind === 'support'" :channel="thread.kind === 'team' ? null : thread.channel" size="lg" />
            <span class="min-w-0 flex-1">
              <span class="flex items-baseline justify-between gap-3 text-sm text-muted">
                <span class="min-w-0 truncate">{{ [thread.when, thread.home].filter(Boolean).join(' · ') }}</span>
                <span class="shrink-0">{{ thread.time }}</span>
              </span>
              <span class="block truncate text-base text-highlighted" :class="thread.unread ? 'font-semibold' : 'font-medium'">{{ thread.title }}</span>
              <span v-if="thread.preview" class="mt-0.5 line-clamp-2 text-sm" :class="thread.unread ? 'text-default' : 'text-muted'">{{ thread.preview_from }}: {{ thread.preview }}</span>
            </span>
          </NuxtLink>
        </MessageRowActions>
      </TransitionGroup>

      <div v-if="pending && !threads.length" class="-mx-3 space-y-1" role="status" aria-label="Loading messages...">
        <div v-for="index in 4" :key="index" class="flex animate-pulse items-start gap-4 py-4 pl-7 pr-3">
          <div class="size-14 shrink-0 rounded-full bg-elevated/80" />
          <div class="min-w-0 flex-1 space-y-2 py-1">
            <div class="h-3 w-1/2 rounded bg-elevated/50" />
            <div class="h-4 w-1/3 rounded bg-elevated/80" />
            <div class="h-3 w-3/4 rounded bg-elevated/40" />
          </div>
        </div>
      </div>

      <div v-if="page?.pagination.has_more" class="flex justify-center py-3">
        <UButton color="neutral" variant="ghost" :loading="loadingMore" :disabled="pending" @click="loadMore">Load more conversations</UButton>
      </div>

      <div v-if="page && threads.length === 0" class="py-14 text-center">
        <p class="text-base font-medium text-highlighted">{{ emptyTitle }}</p>
        <p class="mt-1 text-sm text-muted">{{ emptyDescription }}</p>
      </div>

      <!-- Airbnb's own: a full-bleed row at the foot of the list. Past conversations are a place you go to. -->
      <NuxtLink
        v-if="page"
        :to="{ path: listRoute, query: pastOnly || blockedOnly ? withoutArchived : { ...route.query, archived: '' } }"
        class="-mx-4 mt-2 flex items-center justify-between gap-3 border-t border-default px-4 py-4 text-sm font-medium text-highlighted transition hover:bg-elevated/60 sm:-mx-6 sm:px-6"
      >
        <span>{{ pastOnly || blockedOnly ? 'Current conversations' : 'Past conversations' }}</span>
        <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-muted" />
      </NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useIntervalFn, useDocumentVisibility } from '@vueuse/core'
import { authClient } from '~/lib/auth-client'
import type { LocationQueryRaw } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'
import { isThreadListResponse, type ThreadListItem, type ThreadListPage } from '~/lib/components/workspace/messages/guest-thread-client'
import { useDashboardInvalidations } from '~/composables/useDashboardInvalidations'
import { dashboardGutterClass } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
import InboxAvatar from './InboxAvatar.vue'
import MessageRowActions from './MessageRowActions.vue'
import { useInboxUnread } from './inbox-unread'

/*
  The one list of conversations: guests', Airbnb Support's and the team's, in
  one order, read from the one list the server has for every surface. A
  conversation opens as this level's detail column through the editor frame
  (a guest's or the team's screen), so nothing here fetches or renders one.
  Every word on a row is the server's (inbox-parity.md, "The list"); this
  draws them. Read, unread and archive are the reader's own, and saved here.
*/
const props = withDefaults(defineProps<{ personalScope?: boolean }>(), { personalScope: false })
const session = authClient.useSession()
const emit = defineEmits<{ first: [target: { path: string; query: LocationQueryRaw } | null] }>()

const dashboard = useDashboardOrganization()
const route = useRoute()
const organizationId = computed(() => dashboard.organizationId.value)

const listRoute = computed(() => props.personalScope ? '/dashboard/account/messages' : `/dashboard/${String(route.params.org_slug)}/messages`)

// The open conversation, for the selected row, read from the route below this list.
const openThreadId = computed(() => {
  if (!route.path.startsWith(`${listRoute.value}/`)) return null
  const segments = route.path.slice(listRoute.value.length + 1).split('/')
  return decodeURIComponent((segments[0] === 'team' ? segments[1] : segments[0]) ?? '') || null
})

// Filter and corpus live in the URL, so a filtered list is a link.
const pastOnly = computed(() => route.query.archived !== undefined)
const blockedOnly = computed(() => !props.personalScope && route.query.blocked !== undefined)
const withoutArchived = computed(() => { const { archived: _archived, blocked: _blocked, ...rest } = route.query; return rest })
const kind = computed(() => route.query.kind === 'guests' || route.query.kind === 'support' || route.query.kind === 'team' ? route.query.kind : null)
const unreadOnly = computed(() => route.query.unread === '1')
const search = computed(() => typeof route.query.q === 'string' && route.query.q.trim() ? route.query.q.trim() : null)

const listHydrated = ref(false)
const realtime = useDashboardInvalidations()
onMounted(() => { listHydrated.value = true })

const dashboardScope = useDashboardRouteScope()
const dashboardApi = useDashboardApi(dashboardScope)
const unreadCounts = useInboxUnread(organizationId)

const emptyTitle = computed(() => search.value || kind.value || unreadOnly.value ? 'No conversations match' : 'No conversations yet.')
const emptyDescription = computed(() => {
  if (search.value) return `Nothing matched “${search.value}”.`
  if (blockedOnly.value) return 'Guests you block appear here until you unblock them.'
  if (pastOnly.value) return 'Conversations move here when you archive them, or once they have been quiet for 30 days after the last message and any stay or booking has ended.'
  return props.personalScope ? 'Your conversations with businesses will appear here.' : 'When a guest writes, the conversation appears here.'
})

const listQuery = computed(() => ({
  kind: props.personalScope ? undefined : kind.value ?? undefined,
  q: search.value ?? undefined,
  mailbox: blockedOnly.value ? 'blocked' as const : pastOnly.value ? 'past' as const : 'current' as const,
  unread: unreadOnly.value ? '1' as const : undefined,
}))

const listKey = computed(() => [
  props.personalScope ? `account-conversations:${session.value.data?.user.id}` : 'dashboard-conversations',
  String(route.params.org_slug ?? ''),
  organizationId.value,
  kind.value ?? 'all',
  search.value ?? '',
  blockedOnly.value ? 'blocked' : pastOnly.value ? 'past' : 'current',
  unreadOnly.value ? 'unread' : 'any',
].join(':'))

// One loader for the list: the first render, a filter change and a live
// update all go through it, and a refresh keeps the rows already on screen.
const nextPageError = ref<unknown>(null)
const loadingMore = ref(false)
let pageController: AbortController | null = null
let loadedScope = listKey.value
let loadedPages = 1
async function loadPage(offset: number, signal?: AbortSignal): Promise<ThreadListPage> {
  const query = { ...listQuery.value, limit: 100, offset }
  if (!props.personalScope && !dashboardScope.value) {
    throw createError({ statusCode: 400, statusMessage: 'Dashboard route scope is incomplete' })
  }
  const page = props.personalScope
    ? await applicationFetch<ThreadListPage>('/api/account/messages', { query, signal, validate: isThreadListResponse })
    : await dashboardApi<ThreadListPage>(`/api/dashboard/organizations/${organizationId.value}/conversations`, { query, signal, validate: isThreadListResponse })
  if (page.pagination.limit !== query.limit || page.pagination.offset !== offset) throw createError({ statusCode: 502, statusMessage: 'Messages returned a different page than requested' })
  return page
}
/** A conversation already loaded that reappears on a later page means the list moved between reads. */
class ShiftedPages extends Error {}
function appendLoadedPage(before: ThreadListPage, page: ThreadListPage): ThreadListPage {
  const ids = new Set(before.threads.map(thread => thread.id))
  if (page.threads.some(thread => ids.has(thread.id))) throw new ShiftedPages('Conversations moved between pages while loading')
  return { threads: [...before.threads, ...page.threads], pagination: page.pagination }
}
// New activity reorders the inbox while its pages are read, which shifts a row
// across a page boundary. That ordinary case re-reads the window from the top;
// only a window that keeps shifting is reported.
const WINDOW_READ_ATTEMPTS = 3
async function loadWindow(pages: number, scope: string, signal: AbortSignal): Promise<{ page: ThreadListPage; fetched: number }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      let page = await loadPage(0, signal)
      let fetched = 1
      while (fetched < pages && page.pagination.next_offset !== null) {
        if (scope !== listKey.value) throw new DOMException('The message scope changed', 'AbortError')
        page = appendLoadedPage(page, await loadPage(page.pagination.next_offset, signal))
        fetched += 1
      }
      return { page, fetched }
    } catch (error) {
      if (!(error instanceof ShiftedPages)) throw error
      if (attempt === WINDOW_READ_ATTEMPTS) throw createError({ statusCode: 409, statusMessage: 'Conversations kept changing while loading. Reload messages to continue.' })
    }
  }
}
// Which list the rows on screen belong to. A refresh of the same list keeps
// its rows; a different list (another mailbox, filter or search) shows the
// loading state until its own rows arrive, never the previous list's.
const rowsKey = ref(listKey.value)
const { data, pending, error: threadsError, refresh } = await useAsyncData<ThreadListPage>(listKey, async (_app, { signal }) => {
  pageController?.abort()
  nextPageError.value = null
  const scope = listKey.value
  if (loadedScope !== scope) { loadedScope = scope; loadedPages = 1 }
  const { page, fetched } = await loadWindow(loadedPages, scope, signal)
  if (scope !== listKey.value) throw new DOMException('The message scope changed', 'AbortError')
  loadedPages = fetched
  rowsKey.value = scope
  return page
}, {
  server: !props.personalScope,
  getCachedData(cacheKey, nuxtApp, ctx) {
    if (ctx?.cause === 'refresh:manual' || ctx?.cause === 'refresh:hook') return undefined
    const cached = nuxtApp.payload.data[cacheKey] as ThreadListPage | undefined
    if (cached) rowsKey.value = cacheKey
    return cached
  },
})

if (import.meta.client) {
  onMounted(() => {
    if (useNuxtApp().payload.data[listKey.value]) {
      void refresh()
    }
  })
}
const page = computed(() => rowsKey.value === listKey.value ? data.value ?? null : null)
const threads = computed(() => page.value?.threads ?? [])

async function loadMore() {
  const before = data.value
  if (!before || before.pagination.next_offset === null || loadingMore.value || pending.value) return
  const key = listKey.value
  const controller = new AbortController()
  pageController = controller
  loadingMore.value = true
  nextPageError.value = null
  try {
    const page = await loadPage(before.pagination.next_offset, controller.signal)
    if (controller.signal.aborted || key !== listKey.value || data.value !== before) return
    try {
      data.value = appendLoadedPage(before, page)
      loadedPages = Math.ceil(data.value.threads.length / 100)
    } catch (shift) {
      if (!(shift instanceof ShiftedPages)) throw shift
      // The list moved since the loaded pages were read: read the window and the next page again.
      loadedPages = Math.ceil(before.threads.length / 100) + 1
      await refresh()
    }
  } catch (error) {
    if (!controller.signal.aborted) nextPageError.value = error
  } finally {
    if (pageController === controller) { pageController = null; loadingMore.value = false }
  }
}
watch(listKey, () => pageController?.abort())
onScopeDispose(() => pageController?.abort())

const documentVisibility=useDocumentVisibility()
useIntervalFn(()=>{if(props.personalScope&&documentVisibility.value==='visible')void refresh()},15_000)

// The newest thread, for the index above to open into its second column on
// arrival. The list only says which; whether there is a column is the shell's.
// While a list loads there is none: the rows on screen may be another
// mailbox's, and the shell must not keep one of them to open.
watch([threads, openThreadId, pending], ([rows, open, loading]) => {
  if (open) return
  if (loading) { emit('first', null); return }
  const first = rows[0]
  emit('first', first ? { path: threadRoute(first), query: route.query } : null)
}, { immediate: true })

// A conversation opens beside this list: a guest's at its id, the team's on the team screen.
function threadRoute(thread: ThreadListItem) {
  return thread.kind === 'team' ? `${listRoute.value}/team/${encodeURIComponent(thread.id)}` : `${listRoute.value}/${encodeURIComponent(thread.id)}`
}

// Read or unread without opening it: the row changes at once, and the list and
// its counts are read again from the server once it has saved.
const toast = useToast()
// A row being saved takes no second toggle, so a failure cannot put back a state the member has since changed.
const toggling = new Set<string>()
async function toggleRead(thread: ThreadListItem) {
  if (toggling.has(thread.id)) return
  toggling.add(thread.id)
  try { await saveRead(thread) } finally { toggling.delete(thread.id) }
}
async function saveRead(thread: ThreadListItem) {
  const read = thread.unread
  const mark = (unread: boolean) => {
    if (data.value) data.value = { ...data.value, threads: data.value.threads.map(row => row.id === thread.id ? { ...row, unread } : row) }
  }
  mark(!read)
  try {
    await dashboardApi(`${conversationPath(thread)}/${read ? 'read' : 'unread'}`, {
      method: 'POST',
      ...(read ? { body: {} } : {}),
      validate: (value: unknown): value is { read: boolean } => typeof value === 'object' && value !== null && Reflect.get(value, 'read') === read,
    })
    refreshConversationUnreadCount()
  } catch (error) {
    mark(read)
    toast.add({ color: 'error', title: read ? 'Could not mark as read' : 'Could not mark as unread', description: getErrorMessage(error, 'Try again') })
  }
  // Saved or not, the server says what the row is now: a save can land while telling other devices fails.
  await refresh()
}

function conversationPath(thread: ThreadListItem) {
  return `/api/dashboard/organizations/${organizationId.value}/conversations/${encodeURIComponent(thread.id)}`
}

// Archive files the conversation away for this member alone; a new message from someone else brings it back.
async function archive(thread: ThreadListItem) {
  if (toggling.has(thread.id)) return
  toggling.add(thread.id)
  try {
    await dashboardApi(`${conversationPath(thread)}/archive`, {
      method: 'POST',
      body: { archived: true },
      validate: (value: unknown): value is { archived: boolean } => typeof value === 'object' && value !== null && Reflect.get(value, 'archived') === true,
    })
    refreshConversationUnreadCount()
  } catch (error) {
    toast.add({ color: 'error', title: 'Could not archive the conversation', description: getErrorMessage(error, 'Try again') })
  } finally {
    toggling.delete(thread.id)
  }
  await refresh()
}

// The menu's counts are the list's, read with it.
watch(data, page => { if (page?.unread) unreadCounts.value = page.unread }, { immediate: true })

watch(realtime.event, (event) => {
  // MESSAGE_ACK: this member read, marked or archived a conversation on another device or tab.
  if (props.personalScope || !event || !['access.changed', 'MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_ACK', 'CONVERSATION_LEAVE'].includes(event.type)) return
  if (organizationId.value && event.organization_id !== organizationId.value) return
  void refresh()
})

watch(realtime.connectionEpoch, (epoch) => {
  if (epoch <= 0) return
  if (!props.personalScope) realtime.connect()
  void refresh()
})
</script>
