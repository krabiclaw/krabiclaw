<template>
  <article class="tc" :class="[`is-${face}`, { 'is-closed': task && task.status !== 'open', 'is-reservation': reservation }]" :data-testid="opportunity ? 'today-opportunity' : 'today-task'" :data-task-id="task?.id" :data-task-kind="task?.kind" :data-opportunity-id="opportunity?.id">
    <button v-if="reservation" type="button" class="tc-reservation-main" @click="emit('open')">
      <span class="block text-sm font-semibold">{{ reservation.dateLabel }}</span>
      <UAvatar :src="guestAvatarSrc" alt="" icon="i-lucide-user" class="mx-auto mt-7 size-24 sm:size-28" :ui="{ icon: 'size-12' }" />
      <span class="mt-6 block text-2xl font-semibold leading-tight tracking-tight sm:text-[28px]">{{ reservation.groupHeadline }}</span>
      <span class="mt-3 block text-base font-medium">{{ reservation.homeName }}</span>
      <span class="mt-2 block text-sm text-muted">{{ reservation.statusLabel }}</span>
    </button>
    <button v-else-if="task && face === 'photo'" type="button" class="tc-media" :aria-label="`Open ${task.title}`" @click="emit('open')">
      <img v-if="mediaSrc" :src="mediaSrc" alt="" class="size-full object-cover">
      <span v-if="task.tag" class="tc-tag">{{ task.tag }}</span>
    </button>
    <div class="tc-body">
      <component v-if="!reservation" :is="task ? 'button' : 'div'" :type="task ? 'button' : undefined" class="tc-row" @click="task && emit('open')">
        <span v-if="face !== 'photo'" class="tc-av" :class="avatarClass">
          <img v-if="!task?.avatar && avatarSrc" :src="avatarSrc" alt="" class="size-full object-cover">
          <template v-else-if="task?.avatar">{{ task.avatar.initial }}</template>
          <UIcon v-else :name="opportunity?.icon ?? 'i-lucide-list-checks'" class="size-5" />
        </span>
        <span class="tc-main">
          <span v-if="statusLine" class="tc-k">{{ statusLine }}</span>
          <span v-if="task?.when" class="tc-head"><span class="tc-t">{{ title }}</span><span class="tc-when">{{ task.when }}</span></span>
          <span v-else class="tc-t">{{ title }}</span>
          <span v-if="task?.error" class="tc-d err">{{ task.error }}</span>
          <span v-if="detail" class="tc-d">{{ detail }}</span>
          <span v-if="task?.note" class="tc-note">{{ task.note }}</span>
        </span>
      </component>
      <div class="tc-foot">
        <template v-if="task">
          <UDropdownMenu v-if="task.can.assign && assignees.length" :items="assignItems" :content="{ align: 'start' }">
            <button type="button" class="tc-who" :aria-label="`Assigned to ${task.person?.name ?? 'nobody'}. Change`" data-testid="today-task-assignee">
              <UIcon v-if="reservation" name="i-lucide-ellipsis" class="size-5" />
              <template v-else><i>{{ task.person?.initial ?? '?' }}</i><span>{{ task.person?.name ?? 'Unassigned' }}</span></template>
            </button>
          </UDropdownMenu>
          <span v-else-if="task.person" class="tc-who"><i>{{ task.person.initial }}</i><span>{{ task.person.name }}</span></span>
          <NuxtLink v-if="reservation?.conversation" :to="reservation.conversation.to" class="tc-reservation-link">
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold">{{ reservation.conversation.label }}</span>
              <span v-if="reservation.conversation.description" class="mt-1 block text-sm text-muted">{{ reservation.conversation.description }}</span>
            </span>
            <UIcon name="i-lucide-messages-square" class="size-6 shrink-0" aria-hidden="true" />
          </NuxtLink>
          <NuxtLink v-else-if="task.action?.type === 'open'" :to="task.action.path" class="tc-btn soft">{{ task.action.label }}<b aria-hidden="true">›</b></NuxtLink>
          <button v-else-if="task.action?.type === 'complete'" type="button" class="tc-btn" :disabled="busy" data-testid="today-task-done" @click="emit('complete')">{{ task.action.label }}</button>
          <button v-else-if="task.action?.type === 'reopen'" type="button" class="tc-check" :aria-label="task.action.label" :title="task.action.label" :disabled="busy" data-testid="today-task-undo" @click="emit('reopen')">
            <UIcon name="i-lucide-check" class="size-5" />
          </button>
        </template>
        <template v-else-if="opportunity">
          <button type="button" class="tc-btn white" :disabled="busy" data-testid="today-opportunity-accept" @click="emit('accept')">Accept</button>
          <UDropdownMenu :items="laterItems" :content="{ align: 'start' }">
            <button type="button" class="tc-link" :disabled="busy" data-testid="today-opportunity-later">Not now</button>
          </UDropdownMenu>
        </template>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import type { TaskPerson, TaskView } from '~/server/domain/tasks'
import type { OpportunityView } from '~/server/domain/opportunities'
import { cfImageVariant } from '~/utils/cf-image'

/** The one Today card (`.tc`): a photo or compact task, or an opportunity's insight face. */
const props = defineProps<{ task?: TaskView; opportunity?: OpportunityView; assignees?: TaskPerson[]; busy?: boolean }>()
const emit = defineEmits<{ open: []; complete: []; reopen: []; assign: [person: TaskPerson | null]; accept: []; dismiss: []; defer: [until: string] }>()

const face = computed(() => props.opportunity ? 'insight' : props.task!.face)
const reservation = computed(() => props.task?.reservation)
const statusLine = computed(() => props.task?.statusLine ?? props.opportunity?.statusLine ?? null)
const title = computed(() => props.task?.title ?? props.opportunity!.title)
const detail = computed(() => props.task?.detail ?? props.opportunity?.detail ?? null)
const assignees = computed(() => props.assignees ?? [])
const mediaSrc = computed(() => cfImageVariant(props.task?.imageUrl, { width: 900, height: 600, fit: 'cover', format: 'auto' }) || props.task?.imageUrl || undefined)
const avatarSrc = computed(() => cfImageVariant(props.task?.imageUrl, { width: 96, height: 96, fit: 'cover', format: 'auto' }) || props.task?.imageUrl || undefined)
const guestAvatarSrc = computed(() => cfImageVariant(reservation.value?.guestImageUrl, { width: 224, height: 224, fit: 'cover', format: 'auto' }) || reservation.value?.guestImageUrl || undefined)
const avatarClass = computed(() => props.task?.avatar ? (props.task.avatar.tone === 'cool' ? 'cool' : '') : 'sq')
const assignItems = computed(() => [
  assignees.value.map(person => ({ label: person.name, avatar: { text: person.initial }, onSelect: () => emit('assign', person) })),
  [{ label: 'Unassigned', icon: 'i-lucide-user-x', onSelect: () => emit('assign', null) }],
])
/** The next morning, or a week from it, at 9:00 in the viewer's own clock. */
function morning(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  date.setHours(9, 0, 0, 0)
  return date.toISOString()
}
const laterItems = [
  [{ label: 'Dismiss', icon: 'i-lucide-x', onSelect: () => emit('dismiss') }],
  [{ label: 'Remind me tomorrow', icon: 'i-lucide-alarm-clock', onSelect: () => emit('defer', morning(1)) },
    { label: 'Remind me next week', icon: 'i-lucide-calendar-clock', onSelect: () => emit('defer', morning(7)) }],
]
</script>

<style scoped>
.tc { display: flex; flex-direction: column; overflow: hidden; border-radius: 20px; background: var(--ui-bg); color: var(--ui-text-highlighted); text-align: left; box-shadow: 0 0 0 1px rgb(0 0 0 / 4%), 0 6px 20px rgb(0 0 0 / 8%); font-size: 15px; line-height: 20px; }
.tc.is-insight { background: var(--ui-bg-elevated); box-shadow: none; }
.tc.is-reservation { position: relative; border: 1px solid var(--ui-border); border-radius: 24px; background: var(--ui-bg-elevated); box-shadow: none; }
.tc-reservation-main { display: block; width: 100%; padding: 28px 24px; text-align: center; }
.tc.is-reservation .tc-body, .tc.is-reservation .tc-foot { padding: 0; }
.tc.is-reservation .tc-foot { flex-wrap: wrap; gap: 0; }
.tc.is-reservation .tc-who { position: absolute; top: 8px; right: 8px; display: flex; min-width: 36px; min-height: 36px; justify-content: center; padding: 4px; border-radius: 999px; }
.tc-reservation-link { display: flex; width: 100%; align-items: center; gap: 12px; border-top: 1px solid var(--ui-border); padding: 20px 24px; }
.tc-reservation-link:hover, .tc-reservation-main:hover, .tc.is-reservation button.tc-who:hover { background: var(--ui-bg-accented); }
.tc-reservation-main:focus-visible, .tc-reservation-link:focus-visible { outline: 2px solid var(--ui-text-highlighted); outline-offset: -2px; }
.tc-media { position: relative; display: block; flex: none; aspect-ratio: 3 / 2; max-height: 220px; background: var(--ui-bg-accented); }
.tc-tag { position: absolute; left: 12px; top: 12px; padding: 6px 12px; border-radius: 999px; background: var(--ui-bg); font-size: 13px; line-height: 16px; font-weight: 600; box-shadow: 0 1px 4px rgb(0 0 0 / 16%); }
.tc-body { display: flex; flex: 1 0 auto; flex-direction: column; padding: 16px 20px; }
.tc-row { display: flex; gap: 14px; align-items: flex-start; width: 100%; text-align: left; }
.tc-row:focus-visible, .tc-media:focus-visible, .tc-who:focus-visible { outline: 2px solid var(--ui-text-highlighted); outline-offset: 2px; border-radius: 12px; }
.tc-main { display: flex; flex: 1; min-width: 0; flex-direction: column; }
.tc-av { display: flex; flex: none; align-items: center; justify-content: center; width: 48px; height: 48px; overflow: hidden; border-radius: 50%; background: #fbe3d0; color: #7a4a25; font-size: 18px; font-weight: 600; }
.tc-av.cool { background: #e3ebf3; color: #2e4a66; }
.tc-av.sq { border-radius: 12px; background: var(--ui-bg-accented); color: var(--ui-text-muted); }
.tc-k { font-size: 14px; line-height: 18px; color: var(--ui-text-muted); }
.tc-t { font-size: 18px; line-height: 24px; font-weight: 600; letter-spacing: -.01em; }
.tc-k + .tc-t, .tc-k + .tc-head { margin-top: 2px; }
.tc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.tc-head .tc-t { min-width: 0; }
.tc-when { flex: none; font-weight: 500; white-space: nowrap; }
.tc-d { margin-top: 2px; color: var(--ui-text-muted); }
.tc-d.err { color: var(--ui-error); }
.tc-note { margin-top: 4px; }
.tc-foot { display: flex; align-items: center; gap: 12px; margin-top: auto; padding-top: 12px; }
.tc-foot > :only-child { margin-left: auto; }
.is-insight .tc-foot { gap: 20px; }
.tc-who { display: flex; flex: 1; min-width: 0; align-items: center; gap: 8px; font-weight: 500; text-align: left; }
.tc-who i { flex: none; width: 28px; height: 28px; border-radius: 50%; background: var(--ui-bg-accented); font-size: 12px; line-height: 28px; font-style: normal; font-weight: 600; text-align: center; }
.tc-btn { flex: none; height: 40px; padding: 0 20px; border-radius: 999px; background: var(--ui-bg-inverted); color: var(--ui-text-inverted); font-weight: 600; line-height: 40px; white-space: nowrap; }
.tc-btn.soft { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.tc-btn.white { background: var(--ui-bg); color: var(--ui-text-highlighted); box-shadow: 0 0 0 1px rgb(0 0 0 / 6%), 0 1px 3px rgb(0 0 0 / 8%); }
.tc-btn b { margin-left: 6px; }
.tc-link { flex: none; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
.tc-check { display: flex; flex: none; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 50%; background: var(--ui-bg-inverted); color: var(--ui-text-inverted); }
.tc button:disabled { opacity: .6; }
</style>
