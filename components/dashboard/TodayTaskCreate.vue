<template>
  <UModal v-model:open="open" title="Add a task" data-testid="today-task-create">
    <template #body>
      <form id="today-task-create-form" class="space-y-4" @submit.prevent="save">
        <UFormField label="Task" required>
          <UInput v-model="title" :maxlength="200" required class="w-full" placeholder="Service the AC" />
        </UFormField>
        <UFormField label="Instructions">
          <UTextarea v-model="notes" :maxlength="5000" :rows="3" class="w-full" />
        </UFormField>
        <UFormField label="Due">
          <UInput v-model="due" type="date" class="w-full" />
        </UFormField>
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
        <UAlert v-if="failure" color="error" variant="soft" :description="failure" />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton type="submit" form="today-task-create-form" color="neutral" label="Add" :loading="busy" :disabled="!title.trim() || Boolean(claimRole && !listingId)" />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { BusinessToday } from '~/shared/dashboard-today'
import type { TaskPerson, TaskView } from '~/server/domain/tasks'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ organizationId: string; assignees: TaskPerson[]; claimOptions: BusinessToday['claim_options'] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [task: TaskView] }>()

const title = ref('')
const notes = ref('')
const due = ref('')
const assigneeKey = ref('none')
const claimRoleChoice = ref('none')
const claimRole = computed(() => claimRoleChoice.value === 'none' ? null : claimRoleChoice.value)
const listingId = ref('')
const busy = ref(false)
const failure = ref<string | null>(null)
// One key per request, kept across retries of the same draft.
const idempotencyKey = ref(crypto.randomUUID())
const assigneeItems = computed(() => [{ label: 'Unassigned', value: 'none' }, ...props.assignees.map(person => ({ label: person.name, value: person.id }))])
const isTaskResult = (value: unknown): value is { task: TaskView } => isRecord(value) && isRecord(value.task) && typeof value.task.id === 'string'

watch(open, (isOpen) => {
  if (!isOpen) return
  title.value = ''; notes.value = ''; due.value = ''; failure.value = null
  assigneeKey.value = props.assignees.find(person => person.you)?.id ?? 'none'
  claimRoleChoice.value = 'none'; listingId.value = ''
  idempotencyKey.value = crypto.randomUUID()
})

async function save() {
  busy.value = true
  failure.value = null
  try {
    const result = await applicationFetch(`/api/organizations/${encodeURIComponent(props.organizationId)}/tasks`, { method: 'POST', validate: isTaskResult, body: {
      title: title.value.trim(), notes: notes.value.trim() || null,
      // The end of the chosen day on this device's clock.
      due_at: due.value ? new Date(`${due.value}T23:59:00`).toISOString() : null,
      assigned_member_id: claimRole.value || assigneeKey.value === 'none' ? null : assigneeKey.value,
      ...(claimRole.value ? { claim_role: claimRole.value, product_id: listingId.value } : {}),
      idempotency_key: idempotencyKey.value,
    } })
    emit('created', result.task)
    open.value = false
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The task could not be added')
  } finally {
    busy.value = false
  }
}
</script>
