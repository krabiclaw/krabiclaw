<template>
  <USlideover v-model:open="open" :title="task?.title ?? 'Task'" :description="task?.eyebrow" side="right" data-testid="today-task-sheet">
    <template #body>
      <div v-if="task" class="space-y-5">
        <img v-if="task.imageUrl" :src="task.imageUrl" alt="" class="h-40 w-full rounded-xl object-cover">
        <dl class="divide-y divide-default text-sm">
          <div v-if="task.detail" class="flex justify-between gap-4 py-3"><dt class="text-muted">About</dt><dd class="text-right">{{ task.detail }}</dd></div>
          <div class="flex justify-between gap-4 py-3"><dt class="text-muted">Assigned</dt><dd>{{ task.assignee?.name ?? 'Unassigned' }}</dd></div>
          <div v-if="task.notes" class="py-3"><dt class="text-muted">Instructions</dt><dd class="mt-1 whitespace-pre-line">{{ task.notes }}</dd></div>
        </dl>
        <div v-if="task.outcome" class="space-y-2 rounded-xl bg-elevated p-3 text-sm" data-testid="today-task-outcome">
          <p class="text-muted">{{ task.eyebrow }}</p>
          <p v-if="task.outcome.note" class="whitespace-pre-line">{{ task.outcome.note }}</p>
          <div v-if="task.outcome.photos.length" class="flex flex-wrap gap-2">
            <a v-for="photo in task.outcome.photos" :key="photo.id" :href="photo.url" target="_blank" rel="noopener"><img :src="photo.thumbnailUrl" alt="" class="size-20 rounded-lg object-cover"></a>
          </div>
        </div>
        <form v-if="task.status === 'open' && (task.can.complete || task.can.skip)" id="today-task-close" class="space-y-3" @submit.prevent>
          <UTextarea v-model="note" :rows="3" :maxlength="5000" placeholder="Add a note" aria-label="Note" class="w-full" data-testid="today-task-note" />
          <UInput type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple aria-label="Photos" @change="choosePhotos" />
        </form>
        <UAlert v-if="failure" color="error" variant="soft" :description="failure" />
      </div>
    </template>
    <template #footer>
      <div v-if="task" class="flex w-full flex-col gap-2">
        <template v-if="task.status === 'open'">
          <UButton v-if="task.action.type === 'open'" :to="task.action.path" block color="neutral" size="lg" class="rounded-full" :label="task.action.label" />
          <UButton v-else-if="task.can.complete" block color="neutral" size="lg" class="rounded-full" label="Done" :loading="busy === 'done'" :disabled="busy !== null" data-testid="today-task-sheet-done" @click="close('done')" />
          <UButton v-if="task.can.skip" block color="neutral" variant="soft" size="lg" class="rounded-full" label="Skip" :loading="busy === 'skipped'" :disabled="busy !== null || !note.trim()" data-testid="today-task-skip" @click="close('skipped')" />
          <p v-if="task.can.skip" class="text-center text-xs text-muted">Skipping needs a note saying why.</p>
        </template>
        <UButton v-else-if="task.can.reopen" block color="neutral" variant="soft" size="lg" class="rounded-full" label="Reopen" :loading="busy === 'reopen'" :disabled="busy !== null" @click="reopen" />
      </div>
    </template>
  </USlideover>
</template>

<script setup lang="ts">
import type { TaskView } from '~/server/domain/tasks'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ task: TaskView | null; organizationId: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: [task: TaskView] }>()

const note = ref('')
const photos = ref<File[]>([])
const busy = ref<'done' | 'skipped' | 'reopen' | null>(null)
const failure = ref<string | null>(null)
const base = computed(() => `/api/organizations/${encodeURIComponent(props.organizationId)}/tasks/${encodeURIComponent(props.task?.id ?? '')}`)
const isTaskResult = (value: unknown): value is { task: TaskView } => isRecord(value) && isRecord(value.task) && typeof value.task.id === 'string'

watch(() => props.task?.id, () => { note.value = ''; photos.value = []; failure.value = null })
// Opening a task reads the alerts that sent its people here.
watch([open, () => props.task?.id], async ([isOpen, id]) => {
  if (!isOpen || !id) return
  try {
    await applicationFetch(`${base.value}/read`, { method: 'POST', validate: isTaskResult })
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'This task’s alerts could not be marked read')
  }
}, { immediate: true })

function choosePhotos(event: Event) {
  photos.value = [...((event.target as HTMLInputElement).files ?? [])]
}

async function run(state: 'done' | 'skipped' | 'reopen', request: () => Promise<{ task: TaskView }>) {
  busy.value = state
  failure.value = null
  try {
    const result = await request()
    emit('changed', result.task)
    open.value = false
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The task could not be saved')
  } finally {
    busy.value = null
  }
}

async function close(status: 'done' | 'skipped') {
  const path = `${base.value}/${status === 'done' ? 'complete' : 'skip'}`
  const text = note.value.trim()
  await run(status, () => {
    if (!photos.value.length) return applicationFetch(path, { method: 'POST', validate: isTaskResult, body: text ? { note: text } : {} })
    const form = new FormData()
    if (text) form.append('note', text)
    for (const photo of photos.value) form.append('photos', photo)
    return applicationFetch(path, { method: 'POST', validate: isTaskResult, body: form })
  })
}

async function reopen() {
  await run('reopen', () => applicationFetch(`${base.value}/reopen`, { method: 'POST', validate: isTaskResult, body: { expectedVersion: props.task!.version } }))
}
</script>
