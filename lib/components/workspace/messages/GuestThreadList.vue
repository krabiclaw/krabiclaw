<template>
  <div
    class="flex min-h-0 w-full min-w-0 flex-1 flex-col"
    :data-guest-thread-list-hydrated="listHydrated ? 'true' : 'false'"
  >
    <!--
      The list's controls. The title is the navbar's, like every other screen;
      this row holds the filters, with search at its end. Search is the
      dashboard's one search, opened from here the way it opens from the Menu.
    -->
    <header class="shrink-0 px-4 py-3">
      <!--
        Airbnb's own control: the kind is a dropdown labelled by what is
        selected, and Unread sits beside it as a toggle. Both are 40px pills.
      -->
      <div class="flex items-center gap-2">
        <UDropdownMenu
          :items="typeMenuItems"
          :content="{ align: 'start' }"
          :ui="{
            content: 'min-w-72 p-2',
            item: 'px-3 py-3 text-base gap-4',
            itemLeadingIcon: 'size-6',
          }"
        >
          <!--
            The trigger names the control, not the selection. Measured on
            Airbnb: text "All", aria-label "All, filter by message type",
            71x40 at 32px radius, 14px/400 — it reads "All" whichever option
            is checked, and the menu carries the tick.
          -->
          <UButton
            color="neutral"
            :variant="activeType || updatesView ? 'solid' : 'outline'"
            class="h-10 rounded-full px-4 text-sm font-normal"
            trailing-icon="i-lucide-chevron-down"
            aria-label="All, filter by message type"
          >
            {{ updatesView ? 'Updates' : 'All' }}
          </UButton>
        </UDropdownMenu>

        <UButton
          v-if="!updatesView"
          class="h-10 rounded-full px-4 text-sm font-normal"
          color="neutral"
          :variant="unreadOnly ? 'solid' : 'outline'"
          :aria-pressed="unreadOnly"
          @click="setQuery({ unread: unreadOnly ? undefined : '1' })"
        >
          Unread
        </UButton>
      </div>
    </header>

    <!-- Updates: what the platform told this account or business, under the same pills. -->
    <NotificationList v-if="updatesView" :personal-scope="personalScope" class="min-h-0 flex-1 overflow-y-auto px-4 pb-4" />
    <div v-else class="min-h-0 flex-1 overflow-y-auto">
      <UAlert
        v-if="realtimeFailed"
        color="warning"
        variant="soft"
        icon="i-lucide-wifi-off"
        title="Live updates are unavailable"
        description="This list may be out of date until the dashboard reconnects."
        class="m-3"
      >
        <template #actions>
          <UButton color="warning" variant="soft" size="xs" :loading="pending" @click="refreshThreads">
            Refresh
          </UButton>
        </template>
      </UAlert>

      <UAlert
        v-if="mailboxError"
        color="error"
        variant="soft"
        class="m-3"
        title="The conversation could not be moved"
        :description="mailboxError"
        close
        @update:open="mailboxError = null"
      />

      <UAlert
        v-if="threadsError"
        color="error"
        variant="soft"
        class="m-3"
        title="Messages could not be loaded"
        :description="getErrorMessage(threadsError, 'Guest thread request failed')"
      />

      <!--
        Rows run to the edge of the panel. A bordered card around the list put
        32px of gutter between the picture and the pane and made every row
        narrower than the text it holds.
      -->
      <!-- A conversation that gains a message slides to its new place; one
           archived out of this list fades and the rest close up behind it. -->
      <TransitionGroup
        tag="div"
        class="relative"
        move-class="transition-transform duration-300 ease-out motion-reduce:transition-none"
        enter-from-class="opacity-0 -translate-y-1"
        enter-active-class="transition duration-300 ease-out motion-reduce:transition-none"
        leave-to-class="opacity-0"
        leave-active-class="absolute inset-x-0 transition-opacity duration-200 motion-reduce:transition-none"
      >
        <div
          v-for="thread in threads"
          :key="thread.id"
          class="group relative mx-3"
          :data-thread-row="thread.id"
        >
          <NuxtLink
            :to="{ path: threadRoute(thread), query: route.query }"
            class="flex items-start gap-3 rounded-xl px-3 py-3 transition duration-200 active:scale-[0.99] active:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            :class="[
              thread.id === openThreadId ? 'bg-elevated' : 'hover:bg-elevated/60',
              rowActions(thread).length ? 'pr-12' : '',
            ]"
          >
            <!-- The picture leads: the location's hero, or the business's logo for
                 a thread that came to the business itself. A place with neither
                 keeps the same footprint so the rows do not reflow between them. -->
            <img
              v-if="thread.imageUrl"
              :src="thread.imageUrl"
              alt=""
              class="size-14 shrink-0 rounded-xl object-cover"
              loading="lazy"
            >
            <div v-else class="flex size-14 shrink-0 items-center justify-center rounded-xl bg-elevated">
              <UIcon name="i-lucide-image" class="size-5 text-dimmed" />
            </div>

            <div class="min-w-0 flex-1">
              <!--
                A thread with a booking leads with when it is, the way Airbnb's row
                leads with its date range. One with no booking has nothing to put
                there, so the name moves up rather than leaving an empty line for
                the picture to align against.
              -->
              <div v-if="occurrenceLine(thread)" class="flex items-baseline justify-between gap-3 text-xs text-muted">
                <span class="min-w-0 flex-1 truncate">{{ occurrenceLine(thread) }}</span>
                <span class="shrink-0">{{ formatRelativeTime(thread.lastActivityAt) }}</span>
              </div>
              <div class="flex items-baseline justify-between gap-3">
                <p class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">{{ threadName(thread) }}</p>
                <span v-if="!occurrenceLine(thread)" class="shrink-0 text-xs text-muted">{{ formatRelativeTime(thread.lastActivityAt) }}</span>
              </div>
              <p class="mt-0.5 line-clamp-2 text-sm leading-snug text-muted">{{ thread.preview?.text || 'New conversation' }}</p>
            </div>

            <Transition
              enter-from-class="scale-0"
              enter-active-class="transition-transform duration-200 ease-out motion-reduce:transition-none"
              leave-to-class="scale-0"
              leave-active-class="transition-transform duration-150 motion-reduce:transition-none"
            >
              <span
                v-if="thread.unread"
                class="mt-2 block size-2.5 shrink-0 rounded-full bg-primary"
                :aria-label="`${threadName(thread)}: unread`"
              />
            </Transition>
          </NuxtLink>

          <!--
            Airbnb's row menu: a sibling of the row's link, not inside it, so
            opening it never opens the conversation and the link stays one
            interactive element. Hover reveals it where there is a pointer; it is
            always there on a phone and always reachable by Tab.
          -->
          <UDropdownMenu
            v-if="rowActions(thread).length"
            :items="rowActions(thread)"
            :content="{ align: 'end' }"
          >
            <UButton
              icon="i-lucide-ellipsis"
              color="neutral"
              variant="ghost"
              class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 sm:data-[state=open]:opacity-100"
              :loading="mailboxSaving === thread.id"
              :aria-label="`Conversation actions for ${threadName(thread)}`"
            />
          </UDropdownMenu>
        </div>
      </TransitionGroup>

      <!--
        Airbnb's own: a 50px full-bleed row at the foot of the list, not a tab
        beside it. Past conversations are a different place you go to, not a
        lens on the one you are in.
      -->
      <NuxtLink
        v-if="data && (pastOnly || threads.length > 0)"
        :to="{ path: listRoute, query: pastOnly ? withoutArchived : { ...route.query, archived: '' } }"
        class="flex items-center justify-between gap-3 px-4 py-4 text-sm font-medium text-default transition hover:bg-elevated/60"
        :class="threads.length ? 'mt-2 border-t border-default' : ''"
      >
        <span>{{ pastOnly ? 'Current conversations' : 'Past conversations' }}</span>
        <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-muted" />
      </NuxtLink>

      <div v-if="data && threads.length === 0" class="px-6 py-14 text-center">
        <p class="text-base font-medium text-highlighted">{{ emptyTitle }}</p>
        <p class="mt-1 text-sm text-muted">{{ emptyDescription }}</p>
        <UButton
          v-if="filtersApplied"
          class="mt-5"
          color="neutral"
          variant="outline"
          label="Clear all filters"
          @click="clearFilters"
        />
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { useIntervalFn, useDocumentVisibility } from '@vueuse/core'
import NotificationList from '~/components/dashboard/NotificationList.vue'
import { authClient } from '~/lib/auth-client'
import type { LocationQueryRaw } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'
import {
  isThreadDetailResponse,
  isThreadListResponse,
  threadFilterLabel,
  type SubmissionType,
  type ThreadListItem,
} from '~/lib/components/workspace/messages/guest-thread-client'
import { resolveCmsCapabilities, type ProductFeature } from '~/config/cms-registry'
import { resolvePublicTemplate } from '~/utils/template-registry'
import { normalizeVertical, type OrganizationVertical } from '~/utils/vertical-copy'
import { useDashboardInvalidations } from '~/composables/useDashboardInvalidations'

/*
  The thread list, and only the list. A thread opens as this level's detail
  column through the editor frame, so nothing here fetches, renders or mutates
  a conversation, and this component draws no panel or navbar of its own — the
  route parent owns that chrome.
*/
const props = withDefaults(defineProps<{personalScope?:boolean}>(),{personalScope:false})
const session = authClient.useSession()
const emit = defineEmits<{ first: [target: { path: string; query: LocationQueryRaw } | null] }>()

const dashboard = useDashboardOrganization()
const { formatRelativeTime } = useHumanTime()

const route = useRoute()
const router = useRouter()

const organizationId = computed(() => dashboard.organizationId.value)

const listRoute = computed(() => {
  return props.personalScope ? '/dashboard/account/messages' : `/dashboard/${String(route.params.orgSlug)}/messages`
})

// The open thread, for the selected row. It is the segment below this list, so
// it is read from the route rather than tracked as state of its own.
const openThreadId = computed(() => {
  if (!route.path.startsWith(`${listRoute.value}/`)) return null
  return decodeURIComponent(route.path.slice(listRoute.value.length + 1).split('/')[0] ?? '') || null
})

// Filter and corpus live in the URL, so a filtered list is a link.
const pastOnly = computed(() => route.query.archived !== undefined)
const withoutArchived = computed(() => { const { archived: _archived, ...rest } = route.query; return rest })
const activeType = computed<SubmissionType | null>(() => {
  const value = route.query.filter
  return value === 'contact' || value === 'reservation' || value === 'booking' || value === 'stay' ? value : null
})
const unreadOnly = computed(() => route.query.unread === '1')
const updatesView = computed(() => route.query.view === 'updates')

function setQuery(patch: Record<string, string | undefined>) {
  void router.replace({ path: route.path, query: { ...route.query, ...patch } })
}

function clearFilters() {
  void router.replace({ path: route.path, query: {} })
}

const typeMenuItems = computed(() => [[
  ...typeOptions.value.map(option => ({
    label: option.label,
    icon: option.icon,
    type: 'checkbox' as const,
    checked: !updatesView.value && activeType.value === option.value,
    onSelect: () => setQuery({ filter: option.value ?? undefined, view: undefined }),
    ui: { itemLabel: 'text-base' },
  })),
  // Updates replaces the conversation pane, so an open conversation closes with it.
  { label: 'Updates', icon: 'i-lucide-bell', type: 'checkbox' as const, checked: updatesView.value, onSelect: () => void router.replace({ path: listRoute.value, query: { ...route.query, view: 'updates', filter: undefined, unread: undefined } }), ui: { itemLabel: 'text-base' } },
]])

const filtersApplied = computed(() => Boolean(route.query.query || route.query.filter || route.query.unread))

const listHydrated = ref(false)

const realtime = useDashboardInvalidations()
const realtimeFailed = computed(() => !props.personalScope && realtime.status.value === 'failed')

onMounted(() => {
  listHydrated.value = true
})

const capabilities = computed(() => {
  const vertical = dashboard.organization.value?.vertical
  if (!vertical) return null
  const template = resolvePublicTemplate({ themeId: dashboard.organization.value?.theme_id, vertical }).slug
  return resolveCmsCapabilities(normalizeVertical(vertical) as OrganizationVertical, template)
})

const dashboardScope = useDashboardRouteScope()
const dashboardApi = useDashboardApi(dashboardScope)
const effectiveFeatureSet = computed(() => new Set<ProductFeature>([
  ...(capabilities.value?.pages.map(page => page.feature) ?? []),
  ...(capabilities.value?.managers.map(manager => manager.id) ?? []),
]))

/*
  What this tenant can be written to about, named the way the tenant names it.
  Airbnb's pills are Homes and Experiences — what was booked, not what kind of
  record it made — so these come from the product and booking vocabularies
  rather than a list of schema words kept here.
*/
const vertical = computed(() => dashboard.organization.value?.vertical ?? null)
const typeOptions = computed(() => {
  // The account has no kinds to narrow by: its choices are All and Updates.
  if (props.personalScope) return [{ value: null, label: 'All', icon: 'i-lucide-message-square' }]
  const kinds: SubmissionType[] = []
  if (effectiveFeatureSet.value.has('reservations')) kinds.push('reservation')
  if (effectiveFeatureSet.value.has('products')) kinds.push('booking')
  // A lodging business's places to stay each carry their guest's conversation.
  if (vertical.value && normalizeVertical(vertical.value) === 'lodging') kinds.push('stay')
  if (kinds.length === 0) return [{ value: null, label: 'All', icon: 'i-lucide-message-square' }]
  return [
    { value: null, label: 'All', icon: 'i-lucide-message-square' },
    ...kinds.map(kind => ({
      value: kind,
      label: threadFilterLabel(kind, vertical.value),
      icon: kind === 'reservation' ? 'i-lucide-utensils' : kind === 'stay' ? 'i-lucide-bed-double' : 'i-lucide-ticket',
    })),
    { value: 'contact' as const, label: threadFilterLabel('contact', vertical.value), icon: 'i-lucide-mail' },
  ]
})

const emptyTitle = computed(() => {
  if (filtersApplied.value) return 'No conversations match'
  return pastOnly.value ? 'Nothing here yet' : 'No conversations yet'
})
const emptyDescription = computed(() => {
  if (route.query.query) return `Nothing matched “${route.query.query}”.`
  if (filtersApplied.value) return 'Try a different filter, or clear them to see everything.'
  if (pastOnly.value) return 'Conversations move here when their reservation, experience or stay ends, or when you archive them.'
  return props.personalScope ? 'Your conversations with businesses will appear here.' : 'New guest conversations will appear here.'
})

const listQuery = computed(() => ({
  type: activeType.value ?? undefined,
  mailbox: pastOnly.value ? 'past' as const : 'current' as const,
  unread: unreadOnly.value ? '1' as const : undefined,
}))

const listKey = computed(() => [
  props.personalScope ? `account-guest-threads:${session.value.data?.user.id}` : 'dashboard-guest-threads',
  String(route.params.orgSlug ?? ''),
  organizationId.value,
  activeType.value ?? 'all',
  pastOnly.value ? 'past' : 'current',
  unreadOnly.value ? 'unread' : 'any',
].join(':'))

// One loader for the list: the first render, a filter change and a live
// update all go through it, and a refresh keeps the rows already on screen.
const { data, pending, error: threadsError, refresh } = await useAsyncData<{ threads: ThreadListItem[] }>(listKey, async () => {
  if (props.personalScope) return await applicationFetch<{threads:ThreadListItem[]}>('/api/account/messages',{query:listQuery.value,validate:isThreadListResponse})
  if (!dashboardScope.value) {
    throw createError({ statusCode: 400, statusMessage: 'Dashboard route scope is incomplete' })
  }
  return await dashboardApi<{ threads: ThreadListItem[] }>(
    `/api/dashboard/organizations/${organizationId.value}/guest-threads`,
    { query: listQuery.value, validate: isThreadListResponse },
  )
}, { server: !props.personalScope })
const threads = computed(() => data.value?.threads ?? [])

const documentVisibility=useDocumentVisibility()
useIntervalFn(()=>{if(props.personalScope&&documentVisibility.value==='visible')void refresh()},15_000)

// The newest thread, for the index above to open into its second column on
// arrival. The list only says which; whether there is a column is the shell's.
watch([threads, openThreadId, updatesView], ([rows, open, updates]) => {
  if (updates) { emit('first', null); return }
  if (open) return
  const first = rows[0]
  emit('first', first ? { path: threadRoute(first), query: route.query } : null)
}, { immediate: true })

// A thread opens beside this list, whichever location it belongs to.
function threadRoute(thread: ThreadListItem) {
  return `${listRoute.value}/${encodeURIComponent(thread.id)}`
}

/**
 * The line the row leads with: when the booking happens, formatted once on the
 * server in the record's own timezone. A thread with no booking says where it
 * came from instead.
 */
function threadName(thread:ThreadListItem) {
  if (props.personalScope) {
    if (!thread.organizationName) throw createError({statusCode:500,statusMessage:'Conversation has no business name',fatal:true})
    return thread.organizationName
  }
  return thread.guestName
}
function occurrenceLine(thread: ThreadListItem) {
  if (thread.whenLabel) return thread.whenLabel
  return thread.locationLabel ?? ''
}

/*
  The row menu offers what the server says the thread allows. Where a
  conversation belongs is decided by the mailbox resolver, never from dates
  here, so the menu reads `canArchive` and `canUnarchive` and nothing else.
*/
const mailboxSaving = ref<string | null>(null)
const mailboxError = ref<string | null>(null)
const mailboxAttemptKeys = ref<Record<string, string>>({})

function rowActions(thread: ThreadListItem) {
  const items: Array<{ label: string, icon: string, onSelect: () => void }> = []
  if (thread.canArchive) items.push({ label: 'Archive', icon: 'i-lucide-archive', onSelect: () => void moveThread(thread, 'archive') })
  if (thread.canUnarchive) items.push({ label: 'Move to messages', icon: 'i-lucide-inbox', onSelect: () => void moveThread(thread, 'unarchive') })
  return items
}

async function moveThread(thread: ThreadListItem, transition: 'archive' | 'unarchive') {
  if (!dashboardScope.value || !organizationId.value) return
  // One key per attempt, kept until it succeeds, so a retry after a dropped
  // response is the same request rather than a second one.
  const attempt = `${thread.id}:${transition}`
  mailboxAttemptKeys.value[attempt] ||= crypto.randomUUID()
  const idempotencyKey = mailboxAttemptKeys.value[attempt]
  mailboxSaving.value = thread.id
  mailboxError.value = null
  try {
    await dashboardApi(
      `/api/dashboard/organizations/${organizationId.value}/guest-threads/${encodeURIComponent(thread.id)}/operations/${transition}`,
      { method: 'POST', body: { idempotencyKey }, validate: isThreadDetailResponse },
    )
    const { [attempt]: _completed, ...remaining } = mailboxAttemptKeys.value
    mailboxAttemptKeys.value = remaining
    const wasOpen = openThreadId.value === thread.id
    await refresh()
    if (!wasOpen) return
    // The open conversation left this list. Archiving returns to the list so
    // the index can open the next current thread; moving one back follows it
    // into the list it now belongs to.
    if (transition === 'archive') await router.push({ path: listRoute.value, query: route.query })
    else await router.push({ path: threadRoute(thread), query: withoutArchived.value })
  } catch (error) {
    mailboxError.value = getErrorMessage(error, 'The conversation could not be moved')
  } finally {
    mailboxSaving.value = null
  }
}

function refreshThreads() {
  if (!props.personalScope) realtime.connect()
  void refresh()
}


watch(realtime.event, (event) => {
  if (props.personalScope || !event || !('threadId' in event)) return
  if (organizationId.value && event.organizationId !== organizationId.value) return
  void refresh()
})

watch(realtime.connectionEpoch, (epoch) => {
  if (epoch > 0) refreshThreads()
})
</script>
