<template>
  <div class="task-row" :class="{ 'task-row--closed': task.status !== 'open' }" data-testid="today-task" :data-task-id="task.id" :data-task-kind="task.kind">
    <button type="button" class="task-row__main" :aria-label="`Open ${task.title}`" @click="emit('open', task)">
      <UAvatar :src="imageSrc" alt="" :icon="task.icon" class="task-row__art" :class="{ 'rounded-xl': task.imageUrl }" :ui="{ icon: 'size-6', image: 'object-cover rounded-xl' }" aria-hidden="true" />
      <span class="task-row__text">
        <span class="task-row__eyebrow">{{ task.eyebrow }}</span>
        <span class="task-row__title">{{ task.title }}</span>
        <span v-if="task.detail" class="task-row__detail">{{ task.detail }}</span>
      </span>
    </button>
    <UDropdownMenu v-if="task.can.assign && assignees.length" :items="assignItems" :content="{ align: 'end' }">
      <UButton color="neutral" variant="outline" class="rounded-full" size="sm" :loading="busy === 'assign'" :aria-label="`Assignee: ${assigneeLabel}`" data-testid="today-task-assignee">
        <UAvatar v-if="task.assignee" :text="task.assignee.initial" size="2xs" />
        {{ assigneeLabel }}
        <UIcon name="i-lucide-chevron-down" class="size-3.5" />
      </UButton>
    </UDropdownMenu>
    <span v-else-if="task.assignee" class="task-row__who"><UAvatar :text="task.assignee.initial" size="2xs" />{{ task.assignee.name }}</span>
    <template v-if="task.status === 'open'">
      <UButton v-if="task.action.type === 'open'" :to="task.action.path" color="neutral" variant="outline" class="rounded-full" size="sm" :label="task.action.label" />
      <UButton v-else-if="task.can.complete" color="neutral" class="rounded-full" size="sm" label="Done" :loading="busy === 'complete'" data-testid="today-task-done" @click="emit('complete', task)" />
    </template>
  </div>
</template>

<script setup lang="ts">
import type { TaskPerson, TaskView } from '~/server/domain/tasks'
import { cfImageVariant } from '~/utils/cf-image'

const props = defineProps<{ task: TaskView; assignees: TaskPerson[]; busy: 'assign' | 'complete' | null }>()
const emit = defineEmits<{ open: [task: TaskView]; complete: [task: TaskView]; assign: [task: TaskView, person: TaskPerson | null] }>()

const imageSrc = computed(() => cfImageVariant(props.task.imageUrl, { width: 128, height: 128, fit: 'cover', format: 'auto' }) || props.task.imageUrl || undefined)
const assigneeLabel = computed(() => props.task.assignee?.name ?? 'Unassigned')
const assignItems = computed(() => [
  props.assignees.map(person => ({ label: person.name, avatar: { text: person.initial }, onSelect: () => emit('assign', props.task, person) })),
  [{ label: 'Unassigned', icon: 'i-lucide-user-x', onSelect: () => emit('assign', props.task, null) }],
])
</script>

<style scoped>
.task-row { display: flex; align-items: center; gap: 12px; padding: 16px; border-radius: var(--ui-radius-xl, 16px); box-shadow: inset 0 0 0 1px var(--ui-border); }
.task-row--closed { opacity: .55; }
.task-row__main { display: flex; flex: 1; min-width: 0; align-items: center; gap: 16px; text-align: left; }
.task-row__main:focus-visible { outline: 2px solid var(--ui-text-highlighted); outline-offset: 4px; border-radius: 12px; }
.task-row__art { width: 64px; height: 64px; flex: none; }
.task-row__text { display: flex; min-width: 0; flex-direction: column; }
.task-row__eyebrow { font-size: 13px; line-height: 18px; color: var(--ui-text-muted); }
.task-row__title { font-size: 16px; line-height: 22px; font-weight: 600; color: var(--ui-text-highlighted); }
.task-row__detail { font-size: 14px; line-height: 20px; color: var(--ui-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-row__who { display: inline-flex; flex: none; align-items: center; gap: 6px; font-size: 13px; color: var(--ui-text-muted); }
@media (max-width: 639px) { .task-row { flex-wrap: wrap; } .task-row__main { flex-basis: 100%; } .task-row__art { width: 52px; height: 52px; } }
</style>
