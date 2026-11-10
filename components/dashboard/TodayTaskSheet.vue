<template>
  <USlideover v-model:open="open" :title="task?.sheet.heading ?? 'Task'" side="right" :ui="{ body: 'space-y-5' }">
    <template #body>
      <template v-if="task">
        <div class="text-center">
          <img v-if="task.imageUrl" :src="task.imageUrl" alt="" class="mx-auto mb-4 h-28 w-42 rounded-2xl object-cover">
          <h3 class="text-[26px] font-bold leading-[30px] tracking-tight">{{ task.sheet.title }}</h3>
          <p v-if="task.sheet.date" class="mt-1.5 text-muted">{{ task.sheet.date }}</p>
        </div>

        <div class="sh-card">
          <div v-if="task.sheet.checkout" class="split">
            <div><b>{{ task.sheet.checkout.label }}</b><span>{{ task.sheet.checkout.time }}</span><span v-if="task.sheet.checkout.guest">{{ task.sheet.checkout.guest }}</span></div>
            <div v-if="task.sheet.checkin"><b>{{ task.sheet.checkin.label }}</b><span>{{ task.sheet.checkin.time }}</span><span v-if="task.sheet.checkin.guest">{{ task.sheet.checkin.guest }}</span></div>
          </div>
          <p v-else-if="task.detail" class="text-muted">{{ task.detail }}</p>
          <p v-if="task.notes && task.notes !== task.detail" class="mt-3 whitespace-pre-line">{{ task.notes }}</p>
          <div class="sh-row" :class="{ 'sh-row--first': !task.sheet.checkout && !task.detail }">
            <i>{{ task.assignee?.initial ?? '?' }}</i>
            <div><b>Assigned</b><span>{{ task.assignee?.name ?? 'Nobody yet' }}</span></div>
            <UDropdownMenu v-if="task.can.assign && assignees.length" :items="assignItems" :content="{ align: 'end' }">
              <button type="button" class="font-semibold underline underline-offset-3" :disabled="busy !== null">Change</button>
            </UDropdownMenu>
          </div>
        </div>

        <div v-if="task.outcome" class="sh-card space-y-2" data-testid="today-task-outcome">
          <h4>What {{ task.outcome.closedBy === 'You' ? 'you' : task.outcome.closedBy ?? 'they' }} found</h4>
          <p class="text-muted">{{ task.statusLine }}</p>
          <p v-if="task.outcome.note" class="whitespace-pre-line">{{ task.outcome.note }}</p>
          <div v-if="task.outcome.photos.length" class="flex flex-wrap gap-2">
            <a v-for="photo in task.outcome.photos" :key="photo.id" :href="photo.url" target="_blank" rel="noopener"><img :src="photo.thumbnailUrl" alt="" class="size-20 rounded-lg object-cover"></a>
          </div>
        </div>
        <div v-else-if="task.can.complete" class="sh-card">
          <h4>What you found</h4>
          <UTextarea v-model="note" :rows="3" :maxlength="5000" placeholder="Add a note" aria-label="What you found" class="mt-3 w-full" data-testid="today-task-note" />
          <label class="mt-3 flex cursor-pointer items-center gap-3 text-muted">
            <span class="tile"><UIcon name="i-lucide-camera" class="size-5" /></span>
            {{ photos.length ? `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'} added` : 'Add a photo' }}
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple class="sr-only" @change="choosePhotos">
          </label>
        </div>
        <UAlert v-if="failure" color="error" variant="soft" :description="failure" />
      </template>
    </template>
    <template #footer>
      <div v-if="task" class="flex w-full items-center justify-between gap-4">
        <template v-if="task.status === 'open'">
          <button v-if="task.dismiss" type="button" class="font-semibold underline underline-offset-3 disabled:opacity-50" :disabled="busy !== null" data-testid="today-task-skip" @click="close('skipped')">{{ task.dismiss.label }}</button>
          <span v-else />
          <NuxtLink v-if="task.action?.type === 'open'" :to="task.action.path" class="rounded-full bg-inverted px-8 py-3 font-semibold text-inverted">{{ task.action.label }}</NuxtLink>
          <button v-else-if="task.can.complete" type="button" class="rounded-full bg-inverted px-8 py-3 font-semibold text-inverted disabled:opacity-60" :disabled="busy !== null" data-testid="today-task-sheet-done" @click="close('done')">Done</button>
        </template>
        <button v-else-if="task.can.reopen" type="button" class="ml-auto rounded-full bg-elevated px-6 py-3 font-semibold disabled:opacity-60" :disabled="busy !== null" @click="reopen">{{ task.action?.type === 'reopen' ? task.action.label : 'Undo' }}</button>
      </div>
    </template>
  </USlideover>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import type { TaskPerson, TaskView } from '~/server/domain/tasks'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ task: TaskView | null; organizationId: string; assignees: TaskPerson[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: [task: TaskView] }>()

const note = ref('')
const photos = ref<File[]>([])
const busy = ref<'done' | 'skipped' | 'reopen' | 'assign' | null>(null)
const failure = ref<string | null>(null)
const base = computed(() => `/api/organizations/${encodeURIComponent(props.organizationId)}/tasks/${encodeURIComponent(props.task?.id ?? '')}`)
const isTaskResult = (value: unknown): value is { task: TaskView } => isRecord(value) && isRecord(value.task) && typeof value.task.id === 'string'
const assignItems = computed(() => [
  props.assignees.map(person => ({ label: person.name, avatar: { text: person.initial }, onSelect: () => assign(person) })),
  [{ label: 'Unassigned', icon: 'i-lucide-user-x', onSelect: () => assign(null) }],
])

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

async function run(state: NonNullable<typeof busy.value>, request: () => Promise<{ task: TaskView }>, closeSheet: boolean) {
  busy.value = state
  failure.value = null
  try {
    const result = await request()
    emit('changed', result.task)
    if (closeSheet) open.value = false
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
  }, true)
}

async function reopen() {
  await run('reopen', () => applicationFetch(`${base.value}/reopen`, { method: 'POST', validate: isTaskResult, body: { expectedVersion: props.task!.version } }), true)
}

async function assign(person: TaskPerson | null) {
  await run('assign', () => applicationFetch(base.value, { method: 'PATCH', validate: isTaskResult,
    body: { expectedVersion: props.task!.version, assignedMemberId: person?.id ?? null } }), false)
}
</script>

<style scoped>
.sh-card { border-radius: 16px; padding: 18px 20px; background: var(--ui-bg-elevated); box-shadow: 0 0 0 1px rgb(0 0 0 / 4%), 0 6px 20px rgb(0 0 0 / 8%); }
.sh-card h4 { font-size: 16px; line-height: 20px; font-weight: 600; }
.split { display: flex; }
.split > div { flex: 1; min-width: 0; }
.split > div + div { margin-left: 20px; padding-left: 20px; border-left: 1px solid var(--ui-border); text-align: right; }
.split b, .sh-row b { display: block; font-size: 16px; line-height: 20px; font-weight: 600; }
.split span { display: block; margin-top: 4px; font-size: 14px; line-height: 18px; color: var(--ui-text-muted); }
.split span + span { margin-top: 0; }
.sh-row { display: flex; align-items: center; gap: 12px; margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--ui-border); }
.sh-row--first { margin-top: 0; padding-top: 0; border-top: 0; }
.sh-row > div { flex: 1; min-width: 0; }
.sh-row span { display: block; font-size: 14px; line-height: 18px; color: var(--ui-text-muted); }
.sh-row i { flex: none; width: 40px; height: 40px; border-radius: 50%; background: var(--ui-bg-accented); font-size: 15px; line-height: 40px; font-style: normal; font-weight: 600; text-align: center; }
.tile { display: flex; flex: none; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 12px; background: var(--ui-bg); }
</style>
