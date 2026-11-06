<template>
  <div>
  <UCard
    :as="NuxtLink"
    :to="item.to"
    variant="subtle"
    data-testid="today-card"
    :data-card-id="item.id"
    :data-card-priority="item.priority"
    class="group block transition hover:bg-elevated active:scale-[0.98] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    :ui="{ body: 'flex min-h-36 items-center justify-between gap-4 sm:min-h-40 sm:gap-6' }"
    @click="onCardClick"
  >
    <div class="min-w-0 flex-1">
      <div v-if="item.eyebrow" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-highlighted">
        <span>{{ item.eyebrow }}</span>
      </div>
      <p class="mt-1 text-base font-semibold leading-snug text-highlighted">
        {{ item.headline }}
      </p>
      <p v-if="item.description" class="mt-5 line-clamp-2 text-base leading-normal text-muted">
        {{ item.description }}
      </p>
      <p v-if="item.reason" class="mt-3 text-sm leading-normal text-muted" data-testid="today-card-reason">
        {{ item.reason }}
      </p>
    </div>

    <div class="relative h-14 w-18 shrink-0 self-start sm:h-20 sm:w-26" aria-hidden="true">
      <UAvatar
        :src="avatarSrc"
        alt=""
        :icon="item.imageIcon"
        class="size-14 sm:size-20"
        :ui="{ root: isOffer ? 'rounded-none bg-transparent' : undefined, icon: 'size-7 sm:size-10', image: isOffer ? 'object-contain' : item.imageFit === 'contain' ? 'object-contain p-1.5 sm:p-2' : undefined }"
      />

      <div v-if="item.badgeImageUrl || item.badgeIcon" class="absolute bottom-0 right-0 flex size-8 items-center justify-center overflow-hidden rounded-xl border-2 border-default bg-default shadow-sm sm:size-11">
        <img v-if="item.badgeImageUrl" :src="item.badgeImageUrl" alt="" class="size-full object-cover">
        <UIcon v-else-if="item.badgeIcon" :name="item.badgeIcon" class="size-4 text-muted sm:size-5" />
      </div>
    </div>
  </UCard>

  <div v-if="item.decision" class="mt-2 flex flex-wrap gap-1" data-testid="today-card-decisions">
    <UButton v-if="item.decision.current?.decision !== 'accept'" size="sm" color="neutral" variant="ghost" icon="i-lucide-check" label="I’ll do this" :loading="busy === 'accept'" :disabled="busy !== null" @click="decide({ decision: 'accept', note: null, deferUntil: null })" />
    <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-clock" label="Later" :disabled="busy !== null" @click="openDialog('defer')" />
    <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-x" label="Dismiss" :loading="busy === 'dismiss'" :disabled="busy !== null" @click="decide({ decision: 'dismiss', note: null, deferUntil: null })" />
    <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-message-square-warning" label="Correct" :disabled="busy !== null" @click="openDialog('correct')" />
  </div>

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
