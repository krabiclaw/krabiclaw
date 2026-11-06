<template>
  <div class="relative" data-testid="today-card-container">
    <NuxtLink
      :to="item.to"
      data-testid="today-card"
      :data-card-id="item.id"
      :data-card-priority="item.priority"
      :data-card-presentation="item.presentation.type"
      class="quest-card"
      :class="`quest-card--${item.presentation.type}`"
      @click="onCardClick"
    >
      <div class="quest-card__content">
        <p v-if="item.eyebrow" class="quest-card__eyebrow">{{ item.eyebrow }}</p>
        <p class="quest-card__title">{{ item.headline }}</p>
        <p v-if="item.description" class="quest-card__description">{{ item.description }}</p>
      </div>
      <div class="quest-card__art" aria-hidden="true">
        <UAvatar :src="avatarSrc" alt="" :icon="item.imageIcon" class="quest-card__avatar" :ui="{ icon: 'size-8', image: item.imageFit === 'contain' ? 'object-contain p-2' : 'object-cover' }" />
        <div v-if="item.badgeImageUrl || item.badgeIcon" class="quest-card__badge">
          <img v-if="item.badgeImageUrl" :src="item.badgeImageUrl" alt="" class="size-full object-cover">
          <UIcon v-else-if="item.badgeIcon" :name="item.badgeIcon" class="size-6" />
        </div>
      </div>
    </NuxtLink>
    <UDropdownMenu v-if="menuItems.length" :items="menuItems" :content="{ align: 'end' }">
      <UButton class="absolute right-2 top-2 rounded-full" icon="i-lucide-ellipsis" color="neutral" variant="ghost" :aria-label="`Options for ${item.headline}`" :disabled="busy !== null" />
    </UDropdownMenu>
    <UModal v-model:open="reasonOpen" title="About this recommendation">
      <template #body><p data-testid="today-card-reason" class="text-sm leading-relaxed">{{ item.reason }}</p></template>
    </UModal>
    <UModal v-model:open="dialogOpen" :title="dialog === 'defer' ? 'Come back to this later' : 'Correct this suggestion'"
    :description="dialog === 'defer' ? 'It leaves Today and returns on the day you choose.' : 'Say what is wrong. The suggestion stays away until something about it changes.'">
    <template #body>
      <form :id="`today-decision-${item.id}`" class="space-y-4" @submit.prevent="submitDialog">
        <UFormField v-if="dialog === 'defer'" label="Come back on" required>
          <UInput v-model="deferValue" type="datetime-local" :min="minimumDefer" required class="w-full" />
        </UFormField>
        <UFormField :label="dialog === 'defer' ? 'Note (optional)' : 'What should KrabiClaw know?'" :required="dialog === 'correct'">
          <UTextarea v-model="noteValue" :required="dialog === 'correct'" :maxlength="2000" :rows="3" class="w-full" />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="dialogOpen = false" />
        <UButton type="submit" :form="`today-decision-${item.id}`" :label="dialog === 'defer' ? 'Set aside' : 'Save correction'" :loading="busy !== null" />
      </div>
    </template>
  </UModal>
  </div>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import type { TodayCard, TodayDecisionInput } from '~/shared/dashboard-today'
import { useDashboardTelemetry } from '~/composables/useDashboardTelemetry'
import { cfImageVariant } from '~/utils/cf-image'

const props = defineProps<{
  item: TodayCard
  surface?: string
  /** Saves one decision about this card and reads Today again; false when the save failed and the page shows why. */
  onDecide?: (item: TodayCard, input: TodayDecisionInput) => Promise<boolean>
}>()

const busy = ref<TodayDecisionInput['decision'] | null>(null)
const dialog = ref<'defer' | 'correct'>('defer')
const dialogOpen = ref(false)
const reasonOpen = ref(false)
const menuItems = computed(() => [
  ...(props.item.reason ? [{ label: 'Why this recommendation', onSelect: () => { reasonOpen.value = true } }] : []),
  ...(props.item.decision ? [
    ...(props.item.decision.current?.decision !== 'accept' ? [{ label: 'I’ll do this', onSelect: () => { void decide({ decision: 'accept', note: null, deferUntil: null }) } }] : []),
    { label: 'Later', onSelect: () => openDialog('defer') },
    { label: 'Dismiss', onSelect: () => { void decide({ decision: 'dismiss', note: null, deferUntil: null }) } },
    { label: 'Correct', onSelect: () => openDialog('correct') },
  ] : []),
])
const deferValue = ref('')
const noteValue = ref('')
const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const minimumDefer = computed(() => localInput(new Date(Date.now() + 60_000)))

function openDialog(kind: 'defer' | 'correct') {
  dialog.value = kind
  noteValue.value = ''
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  deferValue.value = localInput(tomorrow)
  dialogOpen.value = true
}

async function decide(input: TodayDecisionInput) {
  if (!props.onDecide) return
  busy.value = input.decision
  try {
    if (await props.onDecide(props.item, input)) dialogOpen.value = false
  } finally {
    busy.value = null
  }
}

async function submitDialog() {
  const note = noteValue.value.trim() || null
  await decide(dialog.value === 'defer'
    ? { decision: 'defer', note, deferUntil: new Date(deferValue.value).toISOString() }
    : { decision: 'correct', note, deferUntil: null })
}

const telemetry = useDashboardTelemetry()
const isOffer = computed(() => props.item.id.startsWith('offer:'))
const avatarSrc = computed(() => cfImageVariant(props.item.imageUrl, {
  width: 160,
  height: 160,
  fit: props.item.imageFit === 'contain' || isOffer.value ? 'scale-down' : 'cover',
  format: 'auto',
}) || props.item.imageUrl || undefined)

function onCardClick() {
  telemetry.track({
    action: 'today_card_click',
    surface: props.surface ?? 'today',
    cardId: props.item.id,
    cardPriority: props.item.priority,
    cardKind: props.item.bookingKind ?? undefined,
    locationId: props.item.locationId ?? undefined,
    targetPath: props.item.to,
  })
}
</script>

<style scoped>
.quest-card { display: flex; align-items: center; justify-content: space-between; gap: 24px; width: 100%; padding: 24px; border-radius: 16px; background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); box-shadow: 0 0 0 1px rgb(0 0 0 / 2%), 0 8px 24px rgb(0 0 0 / 10%); transition: box-shadow .2s ease; }
.quest-card:focus-visible { outline: 2px solid var(--ui-text-highlighted); outline-offset: 4px; }
.quest-card:hover { box-shadow: 0 0 0 1px rgb(0 0 0 / 4%), 0 8px 24px rgb(0 0 0 / 14%); }
.quest-card__content { min-width: 0; flex: 1; }
.quest-card__eyebrow { margin-bottom: 8px; font-size: 12px; line-height: 16px; color: var(--ui-text-muted); }
.quest-card__title { font-size: 16px; line-height: 20px; font-weight: 500; }
.quest-card__description { margin-top: 8px; font-size: 14px; line-height: 18px; color: var(--ui-text-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.quest-card__art { position: relative; flex: 0 0 auto; }
.quest-card__avatar { width: 60px; height: 60px; }
.quest-card__badge { position: absolute; right: -8px; bottom: -4px; width: 32px; height: 32px; border: 3px solid var(--ui-bg-elevated); border-radius: 12px; overflow: hidden; background: var(--ui-bg-elevated); display: grid; place-items: center; }
.quest-card--minimal { padding: 24px 24px 24px 32px; }
.quest-card--minimal .quest-card__title { font-size: 18px; line-height: 24px; }
.quest-card--minimal .quest-card__description { margin-top: 4px; -webkit-line-clamp: 1; }
.quest-card--detailed, .quest-card--opportunity { flex-direction: column; gap: 0; text-align: center; border-radius: 24px; padding: 40px 20px 44px; }
.quest-card--detailed .quest-card__art, .quest-card--opportunity .quest-card__art { order: -1; margin-bottom: 36px; }
.quest-card--detailed .quest-card__avatar, .quest-card--opportunity .quest-card__avatar { width: 96px; height: 96px; }
.quest-card--detailed .quest-card__title, .quest-card--opportunity .quest-card__title { font-size: 26px; line-height: 30px; font-weight: 600; }
.quest-card--detailed .quest-card__description, .quest-card--opportunity .quest-card__description { margin-top: 12px; }
.quest-card--detailed .quest-card__eyebrow, .quest-card--opportunity .quest-card__eyebrow { font-size: 14px; line-height: 18px; }
.quest-card--opportunity .quest-card__badge { width: 48px; height: 48px; right: -28px; border-radius: 12px; }
.quest-card--detailed .quest-card__content, .quest-card--opportunity .quest-card__content { display: contents; }
.quest-card--detailed .quest-card__eyebrow, .quest-card--opportunity .quest-card__eyebrow { order: -2; margin-bottom: 24px; }
@media (max-width: 639px) { .quest-card--minimal { padding: 24px; } .quest-card--minimal .quest-card__title { font-size: 16px; line-height: 20px; } .quest-card--minimal .quest-card__description { -webkit-line-clamp: 2; } }
@media (prefers-reduced-motion: reduce) { .quest-card { transition: none; } }
</style>
