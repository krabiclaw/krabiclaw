<template>
  <!--
    The one way the agenda is narrowed, on Today and on Calendar: Airbnb keeps
    its filters behind a single control rather than scattering selects across
    the screen. Which rows appear depends on what the surface has to narrow by.
  -->
  <UPopover v-model:open="open" :content="{ align: 'end', side: 'bottom', sideOffset: 10 }">
    <UButton
      icon="i-lucide-sliders-horizontal"
      :color="active ? 'primary' : 'neutral'"
      :variant="active ? 'solid' : 'soft'"
      square
      class="rounded-full"
      aria-label="Filter activity"
    />

    <template #content>
      <div class="w-72 space-y-4 p-4">
        <div class="flex items-center justify-between gap-3">
          <p class="font-semibold text-highlighted">Filters</p>
          <UButton v-if="active" label="Clear" color="neutral" variant="ghost" size="xs" @click="clear" />
        </div>
        <UAlert v-if="failure" color="error" variant="soft" :description="getErrorMessage(failure, 'The filter could not be applied')" />
        <UAlert v-if="membersError" color="error" variant="soft" :description="getErrorMessage(membersError, 'Team members could not be loaded')" />
        <UFormField v-if="locations" :label="organization?.vertical === 'service' ? 'Office' : 'Location'">
          <USelect v-model="filters.locationId" :items="locationOptions" class="w-full" />
        </UFormField>
        <UFormField v-if="kinds.length > 1" label="Activity">
          <USelect v-model="filters.kind" :items="kindOptions" class="w-full" />
        </UFormField>
        <UFormField v-if="memberOptions.length > 1" :label="assigneeLabel">
          <USelect v-model="filters.assignedMemberId" :items="memberOptions" class="w-full" />
        </UFormField>
      </div>
    </template>
  </UPopover>
</template>

<script setup lang="ts">
import type { AgendaKind, AgendaLocation } from '~/server/utils/dashboard-agenda'
import { threadFilterLabel } from '~/lib/components/workspace/messages/guest-thread-client'
import { getVerticalCopy } from '~/utils/vertical-copy'

const props = defineProps<{
  /** The branches to narrow by; omitted where the header already names one, as on Calendar. */
  locations?: AgendaLocation[]
  kinds: AgendaKind[]
  /** The business whose team can be assigned; omitted for the account, which has no team. */
  organizationId?: string | null
}>()

const { filters, active, clear, failure } = useAgendaFilters()
const open = ref(false)
const { organization } = useDashboardOrganization()
const assigneeLabel = computed(() => organization.value ? getVerticalCopy(organization.value.vertical).assigneeLabel : 'Assigned team member')

const { data: members, error: membersError } = await useMemberSchedulingList(() => props.organizationId)

// A person is their face and a branch its picture, as the rows that list them draw it.
const locationOptions = computed(() => [
  { label: organization.value?.vertical === 'service' ? 'All offices' : 'All locations', value: AGENDA_FILTER_ALL },
  ...(props.locations ?? []).map(location => ({ label: location.title, value: location.id, ...(location.imageUrl ? { avatar: { src: location.imageUrl } } : { icon: 'i-lucide-map-pin' }) })),
])
const kindOptions = computed(() => [
  { label: 'All activity', value: AGENDA_FILTER_ALL },
  ...props.kinds.map(kind => ({ label: kind === 'post' ? 'Posts' : threadFilterLabel(kind, organization.value?.vertical), value: kind })),
])
const memberOptions = computed(() => [
  { label: 'Everyone', value: AGENDA_FILTER_ALL },
  ...(members.value?.members ?? []).map(member => ({ label: member.name, value: member.id, ...(member.image ? { avatar: { src: member.image } } : { icon: 'i-lucide-user' }) })),
])
</script>
