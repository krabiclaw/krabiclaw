<template>
  <article class="tc" :class="[`is-${face}`, { 'is-closed': task && task.status !== 'open', 'is-reservation': reservation }]" :data-testid="booking ? 'today-reservation' : opportunity ? 'today-opportunity' : 'today-task'" :data-task-id="task?.id" :data-task-kind="task?.kind" :data-opportunity-id="opportunity?.id" :data-reservation-kind="booking?.kind">
    <NuxtLink v-if="destination" :to="destination" class="tc-target" :aria-label="title" />
    <button v-else type="button" class="tc-target" :aria-label="title" @click="emit('open')" />
    <button v-if="opportunity || task?.dismiss?.card" type="button" class="tc-dismiss" :aria-label="opportunity ? 'Dismiss suggestion' : `${task!.dismiss!.label} task`" :disabled="busy" :data-testid="opportunity ? 'today-opportunity-dismiss' : 'today-task-dismiss'" @click="opportunity ? emit('dismiss') : emit('skip')">
      <UIcon name="i-lucide-x" class="size-4" />
    </button>
    <div v-if="reservation" class="tc-reservation-main">
      <span class="block text-sm font-semibold">{{ reservation.dateLabel }}</span>
      <UAvatar :src="guestAvatarSrc" alt="" icon="i-lucide-user" class="mx-auto mt-7 size-24 sm:size-28" :ui="{ icon: 'size-12' }" />
      <span class="mt-6 block text-2xl font-semibold leading-tight tracking-tight sm:text-[28px]">{{ reservation.groupHeadline }}</span>
      <span v-if="reservation.homeName" class="mt-3 block text-base font-medium">{{ reservation.homeName }}</span>
      <span v-if="reservation.statusLabel" class="mt-2 block text-sm text-muted">{{ reservation.statusLabel }}</span>
      <span v-if="reservation.noteLabel" class="mt-2 inline-flex items-center gap-1.5 text-sm text-muted"><UIcon name="i-lucide-square-pen" class="size-4" />{{ reservation.noteLabel }}</span>
      <span v-if="reservation.conversation?.description" class="mt-5 block text-sm text-muted">{{ reservation.conversation.description }}</span>
    </div>
    <!-- The suggestion for this booking: it opens the conversation with its message written for the owner to review and send. -->
    <div v-if="booking?.suggestion" class="tc-suggest">
      <NuxtLink :to="{ path: booking.suggestion.path, state: { draft: booking.suggestion.message } }" class="tc-suggest-link" data-testid="today-reservation-suggestion" :data-opportunity-id="booking.suggestion.id">
        <span class="min-w-0 flex-1"><span class="block font-semibold">{{ booking.suggestion.title }}</span><span class="block text-sm text-muted">{{ booking.suggestion.detail }}</span></span>
        <UIcon :name="booking.suggestion.icon" class="size-6 shrink-0" />
      </NuxtLink>
      <button type="button" class="tc-suggest-dismiss" aria-label="Dismiss suggestion" :disabled="busy" data-testid="today-reservation-suggestion-dismiss" @click="emit('dismiss')">
        <UIcon name="i-lucide-x" class="size-4" />
      </button>
    </div>
    <div v-else-if="task && face === 'photo' && mediaSrc" type="button" class="tc-media">
      <img :src="mediaSrc" alt="" class="size-full object-cover">
      <span v-if="task.tag" class="tc-tag">{{ task.tag }}</span>
    </div>
    <div class="tc-body">
      <div v-if="!reservation" class="tc-row">
        <span v-if="face !== 'photo'" class="tc-av" :class="avatarClass">
          <img v-if="!task?.avatar && avatarSrc" :src="avatarSrc" alt="" class="size-full object-cover">
          <template v-else-if="task?.avatar">{{ task.avatar.initial }}</template>
          <UIcon v-else :name="opportunity?.icon ?? 'i-lucide-list-checks'" class="size-5" />
        </span>
        <span class="tc-main">
          <span v-if="face === 'photo' && !mediaSrc && task?.tag" class="mb-2 text-sm font-semibold">{{ task.tag }}</span>
          <span v-if="statusLine" class="tc-k">{{ statusLine }}</span>
          <span v-if="task?.when" class="tc-head"><span class="tc-t">{{ title }}</span><span class="tc-when">{{ task.when }}</span></span>
          <span v-else class="tc-t">{{ title }}</span>
          <span v-if="task?.error" class="tc-d err">{{ task.error }}</span>
          <span v-if="detail" class="tc-d">{{ detail }}</span>
          <span v-if="task?.note" class="tc-note">{{ task.note }}</span>
        </span>
      </div>
      <div v-if="task?.person" class="tc-foot">
        <span class="tc-who"><i>{{ task.person.initial }}</i><span>{{ task.person.name }}</span></span>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import type { TaskView } from '~/server/domain/tasks'
import type { OpportunityView } from '~/server/domain/opportunities'
import type { TodayReservation } from '~/shared/dashboard-today'
import { cfImageVariant } from '~/utils/cf-image'

/** A task, an opportunity, or a booking with the suggestion at its foot. */
const props = defineProps<{ task?: TaskView; opportunity?: OpportunityView; booking?: TodayReservation; busy?: boolean }>()
const emit = defineEmits<{ open: []; skip: []; dismiss: [] }>()

const face = computed(() => props.task?.face ?? 'compact')
const destination = computed(() => props.booking?.to ?? props.opportunity?.path ?? (props.task?.action?.type === 'open' ? props.task.action.path : null))
// A booking and a guest's reply about a stay draw the same reservation face.
const reservation = computed(() => props.booking
  ? { dateLabel: props.booking.date_label, groupHeadline: props.booking.headline, homeName: props.booking.name, statusLabel: props.booking.status_label, guestImageUrl: props.booking.guest_image_url, noteLabel: props.booking.note_label, conversation: null }
  : props.task?.reservation ? { ...props.task.reservation, noteLabel: null } : null)
const statusLine = computed(() => props.task?.statusLine ?? (props.opportunity ? `Suggested · ${props.opportunity.statusLine}` : null))
const title = computed(() => props.booking?.headline ?? props.task?.title ?? props.opportunity!.title)
const detail = computed(() => props.task?.detail ?? props.opportunity?.detail ?? null)
const mediaSrc = computed(() => cfImageVariant(props.task?.imageUrl, { width: 900, height: 600, fit: 'cover', format: 'auto' }) || props.task?.imageUrl || undefined)
const avatarSrc = computed(() => cfImageVariant(props.task?.imageUrl, { width: 96, height: 96, fit: 'cover', format: 'auto' }) || props.task?.imageUrl || undefined)
const guestAvatarSrc = computed(() => cfImageVariant(reservation.value?.guestImageUrl, { width: 224, height: 224, fit: 'cover', format: 'auto' }) || reservation.value?.guestImageUrl || undefined)
const avatarClass = computed(() => props.task?.avatar ? '' : 'sq')
</script>

<style scoped>
.tc { position: relative; display: flex; flex-direction: column; overflow: hidden; border-radius: 16px; background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); text-align: left; box-shadow: 0 0 0 1px rgb(0 0 0 / 4%), 0 6px 20px rgb(0 0 0 / 8%); font-size: 15px; line-height: 20px; }
.tc.is-reservation { border: 1px solid var(--ui-border); border-radius: 24px; background: var(--ui-bg-elevated); box-shadow: none; }
.tc-reservation-main { display: block; width: 100%; padding: 28px 24px; text-align: center; }
.tc.is-reservation .tc-body { padding: 0; }
.tc.is-reservation .tc-foot { border-top: 1px solid var(--ui-border); padding: 0 24px; }
.tc-media { position: relative; display: block; flex: none; aspect-ratio: 3 / 2; max-height: 220px; background: var(--ui-bg-accented); }
.tc-tag { position: absolute; left: 12px; top: 12px; padding: 6px 12px; border-radius: 999px; background: var(--ui-bg); font-size: 13px; line-height: 16px; font-weight: 600; box-shadow: 0 1px 4px rgb(0 0 0 / 16%); }
.tc-body { display: flex; flex: 1 0 auto; flex-direction: column; padding: 16px 20px; }
.tc-target { position: absolute; inset: 0; z-index: 1; border-radius: inherit; cursor: pointer; }
.tc-target:focus-visible { outline: 2px solid var(--ui-text-highlighted); outline-offset: -3px; }
.tc-dismiss { position: absolute; top: 8px; right: 8px; z-index: 2; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: var(--ui-bg); }
.tc:has(.tc-dismiss) .tc-main { padding-inline-end: 26px; }
.tc-row { display: flex; gap: 14px; align-items: flex-start; width: 100%; text-align: left; }
.tc-main { display: flex; flex: 1; min-width: 0; flex-direction: column; }
.tc-av { display: flex; flex: none; align-items: center; justify-content: center; width: 48px; height: 48px; overflow: hidden; border-radius: 50%; background: var(--ui-bg); color: var(--ui-text-highlighted); font-size: 18px; font-weight: 600; }
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
.tc-who { display: flex; flex: 1; min-width: 0; align-items: center; gap: 8px; font-weight: 500; text-align: left; }
.tc-who i { flex: none; width: 28px; height: 28px; border-radius: 50%; background: var(--ui-bg-accented); font-size: 12px; line-height: 28px; font-style: normal; font-weight: 600; text-align: center; }
.tc button:disabled { opacity: .6; }
.tc-suggest { position: relative; z-index: 2; display: flex; align-items: center; border-top: 1px solid var(--ui-border); background: var(--ui-bg-elevated); }
.tc-suggest-link { display: flex; flex: 1; min-width: 0; align-items: center; gap: 16px; padding: 18px 8px 18px 24px; text-align: left; }
.tc-suggest-link:focus-visible { outline: 2px solid var(--ui-text-highlighted); outline-offset: -3px; }
.tc-suggest-dismiss { display: grid; flex: none; place-items: center; width: 40px; height: 40px; margin-right: 12px; border-radius: 50%; }
</style>
