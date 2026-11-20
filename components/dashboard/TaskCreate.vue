<template>
  <UModal v-model:open="open" :title="report ? 'New maintenance job' : 'Add a task'" data-testid="task-create">
    <template #body>
      <form id="task-create-form" class="space-y-4" @submit.prevent="save">
        <UFormField v-if="!report" label="Type">
          <USelect v-model="kind" :items="[{ value: 'custom', label: 'Task' }, { value: 'maintenance', label: 'Maintenance' }]" class="w-full" />
        </UFormField>
        <UFormField :label="maintenance ? 'What needs fixing' : 'Task'" required>
          <UInput v-model="title" :maxlength="200" required class="w-full" :placeholder="maintenance ? undefined : 'Service the AC'" />
        </UFormField>
        <UFormField v-if="maintenance" label="Where" required>
          <USelect v-model="placeKey" :items="placeItems" :loading="!options && !failure" class="w-full" placeholder="Choose a listing or location" />
        </UFormField>
        <UFormField label="Instructions">
          <UTextarea v-model="notes" :maxlength="5000" :rows="3" class="w-full" />
        </UFormField>
        <UFormField label="Due">
          <UInput v-model="due" type="date" class="w-full" />
        </UFormField>
        <UFormField v-if="maintenance" label="Assigned" required>
          <USelect v-model="assigneeKey" :items="(options?.assignees ?? []).map(person => ({ label: person.name, value: person.id }))" class="w-full" />
        </UFormField>
        <template v-else>
          <UFormField v-if="!claimRole && assignees.length" label="Assigned">
            <USelect v-model="assigneeKey" :items="assigneeItems" class="w-full" />
          </UFormField>
          <template v-if="claimOptions?.listings.length && claimOptions.roles.length">
            <UFormField label="Available to claim">
              <USelect v-model="claimRoleChoice" :items="[{ value: 'none', label: 'No' }, ...claimOptions.roles]" class="w-full" />
            </UFormField>
            <UFormField v-if="claimRole" label="Listing" required>
              <USelect v-model="listingId" :items="claimOptions.listings.map(listing => ({ value: listing.listing_id, label: listing.label }))" class="w-full" />
            </UFormField>
          </template>
        </template>
        <p v-if="report" class="rounded-xl bg-elevated px-3 py-2 text-sm text-muted" data-testid="task-create-report">
          {{ report.guest }}’s message{{ report.photos ? ` and ${report.photos === 1 ? 'photo go' : `${report.photos} photos go`}` : ' goes' }} with the job.
        </p>
        <UAlert v-if="failure" color="error" variant="soft" :description="failure" />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton type="submit" form="task-create-form" color="neutral" :label="report ? 'Create' : 'Add'" :loading="busy" :disabled="!ready" />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { BusinessToday } from '~/shared/dashboard-today'
import type { MaintenancePlace, TaskPerson, TaskView } from '~/server/domain/tasks'
import { getErrorMessage } from '~/utils/errors'

/**
 * Adds a task or a maintenance job. From a guest's message (`report`) it is a
 * maintenance job about that message, at the place the conversation is about.
 */
const props = defineProps<{
  organizationId: string
  assignees?: TaskPerson[]
  claimOptions?: BusinessToday['claim_options'] | null
  report?: { message_id: string; product_id: string | null; location_id: string | null; guest: string; photos: number }
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [task: TaskView] }>()

type Options = { places: MaintenancePlace[]; assignees: TaskPerson[] }
const kind = ref<'custom' | 'maintenance'>('custom')
const maintenance = computed(() => Boolean(props.report) || kind.value === 'maintenance')
const title = ref('')
const notes = ref('')
const due = ref('')
const assigneeKey = ref('none')
const claimRoleChoice = ref('none')
const claimRole = computed(() => maintenance.value || claimRoleChoice.value === 'none' ? null : claimRoleChoice.value)
const listingId = ref('')
const placeKey = ref<string | undefined>(undefined)
const options = ref<Options | null>(null)
const busy = ref(false)
const failure = ref<string | null>(null)
// One key per request, kept across retries of the same draft.
const idempotencyKey = ref(crypto.randomUUID())
const assignees = computed(() => props.assignees ?? [])
const assigneeItems = computed(() => [{ label: 'Unassigned', value: 'none' }, ...assignees.value.map(person => ({ label: person.name, value: person.id }))])
const keyOf = (place: Pick<MaintenancePlace, 'product_id' | 'location_id'>) => `${place.product_id ?? ''}|${place.location_id ?? ''}`
const placeItems = computed(() => (options.value?.places ?? []).map(place => ({ value: keyOf(place), label: place.label })))
const place = computed(() => options.value?.places.find(candidate => keyOf(candidate) === placeKey.value) ?? null)
const ready = computed(() => Boolean(title.value.trim()) && (maintenance.value
  ? Boolean(place.value && assigneeKey.value !== 'none')
  : !claimRole.value || Boolean(listingId.value)))
const isTaskResult = (value: unknown): value is { task: TaskView } => isRecord(value) && isRecord(value.task) && typeof value.task.id === 'string'
const isOptions = (value: unknown): value is Options => isRecord(value) && Array.isArray(value.places) && Array.isArray(value.assignees)

watch(open, (isOpen) => {
  if (!isOpen) return
  title.value = ''; notes.value = ''; due.value = ''; failure.value = null
  kind.value = props.report ? 'maintenance' : 'custom'
  assigneeKey.value = assignees.value.find(person => person.you)?.id ?? 'none'
  claimRoleChoice.value = 'none'; listingId.value = ''; placeKey.value = undefined
  idempotencyKey.value = crypto.randomUUID()
}, { immediate: true })

// Options belong to one organization.
watch(() => props.organizationId, () => { options.value = null })

// Where a repair can be sent and who can do it, read when the sheet becomes a maintenance job.
watch([open, maintenance], async ([isOpen, isMaintenance]) => {
  if (!isOpen || !isMaintenance) return
  try {
    options.value ??= await applicationFetch(`/api/organizations/${encodeURIComponent(props.organizationId)}/tasks/maintenance-options`, { validate: isOptions })
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'Places and people for maintenance could not be loaded')
    return
  }
  const loaded = options.value
  // From a conversation: the place it is about; the person creating it when they can do it.
  const report = props.report
  const about = report && (loaded.places.find(candidate => candidate.product_id === report.product_id && candidate.location_id === report.location_id)
    ?? (report.product_id ? loaded.places.find(candidate => candidate.product_id === report.product_id) : loaded.places.find(candidate => !candidate.product_id && candidate.location_id === report.location_id)))
  placeKey.value ??= about ? keyOf(about) : undefined
  if (!loaded.assignees.some(person => person.id === assigneeKey.value)) assigneeKey.value = loaded.assignees.find(person => person.you)?.id ?? loaded.assignees[0]?.id ?? 'none'
}, { immediate: true })

async function save() {
  const draft = idempotencyKey.value
  busy.value = true
  failure.value = null
  try {
    const result = await applicationFetch(`/api/organizations/${encodeURIComponent(props.organizationId)}/tasks`, { method: 'POST', validate: isTaskResult, body: {
      title: title.value.trim(), notes: notes.value.trim() || null,
      // The end of the chosen day on this device's clock.
      due_at: due.value ? new Date(`${due.value}T23:59:00`).toISOString() : null,
      ...(maintenance.value
        ? { kind: 'maintenance', product_id: place.value!.product_id, location_id: place.value!.location_id, assigned_member_id: assigneeKey.value,
            ...(props.report ? { source_message_id: props.report.message_id } : {}) }
        : { assigned_member_id: claimRole.value || assigneeKey.value === 'none' ? null : assigneeKey.value,
            ...(claimRole.value ? { claim_role: claimRole.value, product_id: listingId.value } : {}) }),
      idempotency_key: idempotencyKey.value,
    } })
    // A draft opened since this request was sent stays open.
    if (draft !== idempotencyKey.value) return
    emit('created', result.task)
    open.value = false
  } catch (cause) {
    if (draft !== idempotencyKey.value) return
    failure.value = getErrorMessage(cause, maintenance.value ? 'The maintenance job could not be created' : 'The task could not be added')
  } finally {
    busy.value = false
  }
}
</script>
