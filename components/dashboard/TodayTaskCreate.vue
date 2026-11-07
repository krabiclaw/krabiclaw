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
        <UFormField v-if="assignees.length" label="Assigned">
          <USelect v-model="assigneeKey" :items="assigneeItems" class="w-full" />
        </UFormField>
        <UAlert v-if="failure" color="error" variant="soft" :description="failure" />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton type="submit" form="today-task-create-form" color="neutral" label="Add" :loading="busy" :disabled="!title.trim()" />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { TaskPerson, TaskView } from '~/server/domain/tasks'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ organizationId: string; assignees: TaskPerson[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [task: TaskView] }>()

const title = ref('')
const notes = ref('')
const due = ref('')
const assigneeKey = ref('none')
const busy = ref(false)
const failure = ref<string | null>(null)
// One key per request, kept across retries of the same draft.
const idempotencyKey = ref(crypto.randomUUID())
const assigneeItems = computed(() => [{ label: 'Unassigned', value: 'none' }, ...props.assignees.map(person => ({ label: person.name, value: `${person.type}:${person.id}` }))])
const isTaskResult = (value: unknown): value is { task: TaskView } => isRecord(value) && isRecord(value.task) && typeof value.task.id === 'string'

watch(open, (isOpen) => {
  if (!isOpen) return
  title.value = ''; notes.value = ''; due.value = ''; failure.value = null
  assigneeKey.value = props.assignees.find(person => person.you) ? `member:${props.assignees.find(person => person.you)!.id}` : 'none'
  idempotencyKey.value = crypto.randomUUID()
})

async function save() {
  busy.value = true
  failure.value = null
  const [type, id] = assigneeKey.value === 'none' ? [null, null] : assigneeKey.value.split(':') as [string, string]
  try {
    const result = await applicationFetch(`/api/organizations/${encodeURIComponent(props.organizationId)}/tasks`, { method: 'POST', validate: isTaskResult, body: {
      title: title.value.trim(), notes: notes.value.trim() || null,
      // The end of the chosen day on this device's clock.
      dueAt: due.value ? new Date(`${due.value}T23:59:00`).toISOString() : null,
      assignedMemberId: type === 'member' ? id : null, assignedTeamId: type === 'team' ? id : null,
      idempotencyKey: idempotencyKey.value,
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
