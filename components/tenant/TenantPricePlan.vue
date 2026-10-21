<template>
  <article class="relative mb-10 rounded-3xl border-2 bg-elevated p-6 shadow-md sm:p-8 lg:p-10" :class="isBusiness ? 'border-[var(--tenant-primary,var(--ui-border-default))]' : 'border-[var(--tenant-accent,var(--ui-primary))]'">
    <div v-if="plan.discount" class="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-[var(--site-accent,var(--ui-primary))] px-4 py-1 text-xs font-semibold uppercase text-[var(--site-on-accent,var(--ui-bg-elevated))]">{{ discountLabel }}</div>
    <p class="mb-6 text-center text-6xl font-bold text-[var(--tenant-primary,var(--ui-text-highlighted))]">{{ price }}</p>
    <hr class="border-default">
    <p class="mb-6 mt-4 text-base leading-7 text-[var(--tenant-primary,var(--ui-text-highlighted))]">{{ plan.description }}</p>
    <ul class="mt-8 space-y-3 text-sm text-[var(--tenant-primary,var(--ui-text-highlighted))]">
      <li v-for="feature in features" :key="feature" class="flex items-start gap-3">
        <svg class="mt-1 size-4 shrink-0 text-[var(--tenant-accent,var(--ui-primary))]" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" clip-rule="evenodd" /></svg>
        {{ feature }}
      </li>
    </ul>
  </article>
</template>

<script setup lang="ts">
const props = defineProps<{ plan: ApiRecord }>()
const price = computed(() => String(props.plan.price || '').replace(/\*\*/g, '').trim())
const features = computed(() => Array.isArray(props.plan.features) ? props.plan.features.map(String) : [])
const isBusiness = computed(() => /business|nonprofit/i.test(String(props.plan.description || '')))
const discountLabel = computed(() => {
  const discount = String(props.plan.discount || '').trim()
  return /market rate/i.test(discount) ? 'Market Rate' : `${discount} Discount`
})
</script>
