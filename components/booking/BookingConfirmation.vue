<template>
  <div>
    <header class="mx-auto max-w-xl px-4 pt-16 pb-4 text-center sm:px-6 lg:px-8">
      <div class="mx-auto mb-5 flex size-13 items-center justify-center rounded-full" :class="cancelled ? 'bg-muted text-muted' : 'bg-primary text-on-primary'">
        <svg class="size-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
      </div>
      <p class="saya-kicker mb-3">{{ kicker }}</p>
      <h1 class="saya-display-sm text-default">
        <slot name="title" />
      </h1>
      <p class="mt-5 text-sm leading-relaxed text-muted">
        <slot name="subtitle" />
      </p>
    </header>

    <!-- The booking as its record screen shows it: what was booked, pictured, then its facts in a grid. No boxes inside boxes. -->
    <div class="mx-auto max-w-2xl px-4 pt-8 pb-24 sm:px-6 lg:px-8">
      <section :aria-label="itemTitle">
        <img v-if="imageUrl" :src="imageUrl" alt="" class="aspect-[16/9] w-full rounded-2xl object-cover" :class="cancelled ? 'opacity-60 grayscale' : undefined">
        <div :class="imageUrl ? 'mt-6' : undefined">
          <h2 class="saya-display text-2xl text-default sm:text-3xl">{{ itemTitle }}</h2>
          <p v-if="itemSubtitle" class="mt-1 text-muted">{{ itemSubtitle }}</p>
        </div>
        <dl class="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-default pt-6">
          <div v-for="row in receiptRows" :key="row.label" :class="row.wide ? 'col-span-2' : undefined">
            <dt class="text-sm font-semibold text-default">{{ row.label }}</dt>
            <dd class="m-0 mt-1 whitespace-pre-line break-words text-muted">{{ row.value }}</dd>
          </div>
        </dl>
        <div v-if="$slots.actions" class="mt-8 flex flex-wrap gap-3">
          <slot name="actions" />
        </div>
      </section>

      <!-- What happens next: the stated terms, when the business stated any. -->
      <section v-if="nextSteps.length || nextStepsNotesHtml" class="mt-10 border-t border-default pt-8">
        <h3 class="text-lg font-semibold text-default">{{ nextStepsKicker }}</h3>
        <ol v-if="nextStepsStyle === 'numbered'" class="m-0 mt-5 flex list-none flex-col gap-4 p-0">
          <li v-for="(step, i) in nextSteps" :key="i" class="flex gap-4 text-sm leading-relaxed text-muted">
            <span class="flex size-7 shrink-0 items-center justify-center rounded-full border border-default text-sm text-default">{{ i + 1 }}</span>
            <span>{{ step }}</span>
          </li>
        </ol>
        <div v-else class="mt-4 flex flex-col gap-3 text-sm leading-relaxed text-muted">
          <p v-for="(step, i) in nextSteps" :key="i" class="m-0">{{ step }}</p>
        </div>
        <div v-if="nextStepsNotesHtml" class="mt-5 text-sm leading-relaxed text-muted">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-html="nextStepsNotesHtml" />
        </div>
      </section>

      <TenantButton v-if="ctaLabel && ctaTo" :to="ctaTo" variant="outline" block class="mt-10">{{ ctaLabel }}</TenantButton>

      <GuestAccountPrompt class="mt-10" :email="guestEmail" />
    </div>
  </div>
</template>

<script setup lang="ts">
import GuestAccountPrompt from '~/components/booking/GuestAccountPrompt.vue'

withDefaults(defineProps<{
  kicker: string
  cancelled?: boolean
  /** What was booked, as its page names it, and where. */
  itemTitle: string
  itemSubtitle?: string
  /** Its photo, when it has one. */
  imageUrl?: string | null
  /** The booking's facts; a wide one spans the grid. */
  receiptRows: Array<{ label: string; value: string; wide?: boolean }>
  nextStepsKicker: string
  nextSteps: string[]
  nextStepsStyle?: 'numbered' | 'plain'
  nextStepsNotesHtml?: string
  ctaLabel?: string
  ctaTo?: string
  /** The email the guest booked with; the account prompt offers it. */
  guestEmail?: string | null
}>(), {
  nextStepsStyle: 'numbered',
  cancelled: false,
  itemSubtitle: '',
  imageUrl: null,
  nextStepsNotesHtml: '',
  ctaLabel: '',
  ctaTo: '',
  guestEmail: null,
})

defineSlots<{
  title(): unknown
  subtitle(): unknown
  actions?(): unknown
}>()
</script>
