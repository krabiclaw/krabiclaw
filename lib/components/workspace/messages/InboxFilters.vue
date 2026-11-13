<template>
  <!--
    Airbnb's control: two pills only. The first opens the kinds, each with its
    icon, a coral dot when it has unread and the count at its right, and reads
    the chosen kind; Unread toggles beside it. Nothing scrolls sideways.
  -->
  <div class="flex items-center gap-2">
    <UDropdownMenu
      :items="menu"
      :content="{ align: 'start' }"
      :ui="{ content: 'w-75 p-2 rounded-2xl', item: 'px-3 py-3.5 text-base gap-4', itemLeadingIcon: 'size-6' }"
    >
      <UButton
        color="neutral"
        variant="solid"
        class="h-10 rounded-full px-4 text-sm font-normal"
        trailing-icon="i-lucide-chevron-down"
        :aria-label="`${selectedLabel}, filter by conversation type`"
      >
        {{ selectedLabel }}
      </UButton>
      <template #item-leading="{ item }">
        <span class="relative">
          <UIcon :name="item.icon" class="size-6" />
          <span v-if="item.dot" class="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary" />
        </span>
      </template>
      <template #item-trailing="{ item }">
        <span v-if="item.count" class="font-medium text-highlighted">{{ item.count }}</span>
      </template>
    </UDropdownMenu>
    <UButton
      class="h-10 rounded-full px-4 text-sm font-normal"
      color="neutral"
      :variant="unreadOnly ? 'solid' : 'outline'"
      :aria-pressed="unreadOnly"
      @click="setQuery({ unread: unreadOnly ? undefined : '1' })"
    >
      Unread
    </UButton>
  </div>
</template>

<script setup lang="ts">
import { normalizeVertical } from '~/utils/vertical-copy'
import { useInboxUnread } from './inbox-unread'

const route = useRoute()
const router = useRouter()
const dashboard = useDashboardOrganization()
const unread = useInboxUnread(computed(() => dashboard.organizationId.value))
const counts = computed(() => unread.value.unread)
const listPath = computed(() => `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/messages`)
const vertical = computed(() => dashboard.organization.value?.vertical ?? null)

const selected = computed(() => route.query.kind === 'guests' || route.query.kind === 'support' || route.query.kind === 'team' ? route.query.kind : 'all')
const unreadOnly = computed(() => route.query.unread === '1')

function setQuery(patch: Record<string, string | undefined>) {
  void router.replace({ path: route.path, query: { ...route.query, ...patch } })
}

// All is every conversation this member sees, the team's included: one list, as Slack's.
const kinds = computed(() => [
  { value: 'all', label: 'All', icon: 'i-lucide-message-circle', count: counts.value?.all ?? 0 },
    { value: 'guests', label: vertical.value && normalizeVertical(vertical.value) === 'service' ? 'Clients' : 'Guests', icon: 'i-lucide-house', count: counts.value?.guests ?? 0 },
    // Airbnb Support writes to a business that hosts on Airbnb.
    ...(dashboard.hasFeature('stays') ? [{ value: 'support', label: 'Airbnb Support', icon: 'i-simple-icons-airbnb', count: counts.value?.support ?? 0 }] : []),
  { value: 'team', label: 'Team', icon: 'i-lucide-messages-square', count: counts.value?.team ?? 0 },
])
const selectedLabel = computed(() => kinds.value.find(kind => kind.value === selected.value)?.label ?? 'All')

const menu = computed(() => [kinds.value.map(kind => ({
  label: kind.label,
  icon: kind.icon,
  dot: kind.count > 0,
  count: kind.count,
  type: 'checkbox' as const,
  checked: kind.value === selected.value,
  onSelect: () => {
    const { kind: _kind, ...rest } = route.query
    void router.push({ path: listPath.value, query: kind.value === 'all' ? rest : { ...rest, kind: kind.value } })
  },
}))])
</script>
