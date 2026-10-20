<template>
  <div>
    <header class="mx-auto max-w-xl px-4 pt-16 pb-4 text-center sm:px-6 lg:px-8">
      <div class="mx-auto mb-5 flex size-13 items-center justify-center rounded-full" :class="cancelled ? 'bg-muted text-muted' : 'bg-primary text-on-primary'">
        <svg class="size-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
      </div>
      <p class="tenant-kicker mb-3">{{ kicker }}</p>
      <h1 class="tenant-display-sm text-default">
        <slot name="title" />
      </h1>
      <p class="mt-5 text-sm leading-relaxed text-muted">
        <slot name="subtitle" />
      </p>
    </header>

    <div class="mx-auto grid max-w-2xl gap-6 px-4 pt-8 pb-24 sm:px-6 lg:px-8">
      <!-- Receipt -->
      <section class="border border-default bg-default p-7 sm:p-8">
        <p class="tenant-eyebrow mb-5 text-muted">{{ receiptKicker }}</p>
        <dl class="space-y-0">
          <div
            v-for="row in receiptRows"
            :key="row.label"
            class="flex items-baseline justify-between gap-4 border-b border-default py-3 last:border-b-0"
          >
            <dt class="text-[11px] uppercase tracking-[0.25em] text-muted">{{ row.label }}</dt>
            <dd class="tenant-display tenant-italic m-0 max-w-[60%] text-right text-base text-default">{{ row.value }}</dd>
          </div>
        </dl>
        <div v-if="$slots.actions" class="mt-7 flex flex-wrap gap-3">
          <slot name="actions" />
        </div>
      </section>

      <!-- What happens next: the stated terms, when the business stated any. -->
      <aside v-if="nextSteps.length || nextStepsNotesHtml" class="border border-default bg-muted p-7 sm:p-8">
        <p class="tenant-eyebrow mb-5 text-muted">{{ nextStepsKicker }}</p>
        <ol v-if="nextStepsStyle === 'numbered'" class="m-0 flex list-none flex-col gap-5 p-0">
          <li v-for="(step, i) in nextSteps" :key="i" class="flex gap-4 text-sm leading-relaxed text-muted">
            <span class="tenant-display flex size-7 shrink-0 items-center justify-center rounded-full border border-default bg-default text-sm text-default">{{ i + 1 }}</span>
            <span>{{ step }}</span>
          </li>
        </ol>
        <div v-else class="flex flex-col gap-4 text-sm leading-relaxed text-muted">
          <p v-for="(step, i) in nextSteps" :key="i" class="m-0">{{ step }}</p>
        </div>
        <div v-if="nextStepsNotesHtml" class="mt-5 border-t border-default pt-5 text-sm leading-relaxed text-muted">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-html="nextStepsNotesHtml" />
        </div>
        <TenantButton v-if="ctaLabel && ctaTo" :to="ctaTo" block class="mt-7">{{ ctaLabel }}</TenantButton>
      </aside>
      <TenantButton v-else-if="ctaLabel && ctaTo" :to="ctaTo" variant="outline" block>{{ ctaLabel }}</TenantButton>

      <GuestAccountPrompt :email="guestEmail" />
    </div>
  </div>
</template>

<script setup lang="ts">
import GuestAccountPrompt from '~/components/booking/GuestAccountPrompt.vue'

withDefaults(defineProps<{
  kicker: string
  cancelled?: boolean
  receiptKicker: string
  receiptRows: Array<{ label: string; value: string }>
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
