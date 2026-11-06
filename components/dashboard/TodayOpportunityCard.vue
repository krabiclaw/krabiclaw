<template>
  <div class="opportunity" data-testid="today-opportunity" :data-opportunity-id="opportunity.id">
    <NuxtLink :to="opportunity.path" class="opportunity__text">
      <span class="opportunity__eyebrow">{{ opportunity.eyebrow }}</span>
      <span class="opportunity__title">{{ opportunity.title }}</span>
      <span class="opportunity__detail">{{ opportunity.detail }}</span>
    </NuxtLink>
    <div class="opportunity__actions">
      <UButton color="neutral" class="rounded-full" size="sm" label="Accept" :loading="busy === 'accept'" :disabled="busy !== null" data-testid="today-opportunity-accept" @click="emit('accept', opportunity)" />
      <UDropdownMenu :items="laterItems" :content="{ align: 'end' }">
        <UButton color="neutral" variant="outline" class="rounded-full" size="sm" label="Not now" :loading="busy === 'later'" :disabled="busy !== null" data-testid="today-opportunity-later" />
      </UDropdownMenu>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'
import type { OpportunityView } from '~/server/domain/opportunities'

const props = defineProps<{ opportunity: OpportunityView; busy: 'accept' | 'later' | null }>()
const emit = defineEmits<{ accept: [opportunity: OpportunityView]; dismiss: [opportunity: OpportunityView]; defer: [opportunity: OpportunityView, until: string] }>()

/** The next morning, or a week from it, at 9:00 in the viewer's own clock. */
function morning(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  date.setHours(9, 0, 0, 0)
  return date.toISOString()
}
const laterItems = computed(() => [
  [{ label: 'Dismiss', icon: 'i-lucide-x', onSelect: () => emit('dismiss', props.opportunity) }],
  [
    { label: 'Remind me tomorrow', icon: 'i-lucide-alarm-clock', onSelect: () => emit('defer', props.opportunity, morning(1)) },
    { label: 'Remind me next week', icon: 'i-lucide-calendar-clock', onSelect: () => emit('defer', props.opportunity, morning(7)) },
  ],
])
</script>

<style scoped>
.opportunity { display: flex; align-items: center; gap: 16px; padding: 16px; border-radius: var(--ui-radius-xl, 16px); background: var(--ui-bg-elevated); }
.opportunity__text { display: flex; flex: 1; min-width: 0; flex-direction: column; }
.opportunity__eyebrow { font-size: 13px; font-weight: 600; color: var(--ui-primary); }
.opportunity__title { font-size: 16px; line-height: 22px; font-weight: 600; color: var(--ui-text-highlighted); }
.opportunity__detail { font-size: 14px; line-height: 20px; color: var(--ui-text-muted); }
.opportunity__actions { display: flex; flex: none; gap: 8px; }
@media (max-width: 639px) { .opportunity { flex-direction: column; align-items: stretch; } }
</style>
