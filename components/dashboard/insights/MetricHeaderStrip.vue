<template>
  <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
    <div
      v-for="item in items"
      :key="item.label"
      class="group relative rounded-xl border border-default bg-default p-4 shadow-2xs transition-colors hover:border-accented"
    >
      <p class="text-xs font-medium text-muted uppercase tracking-wider">{{ item.label }}</p>
      <p
        class="mt-2 text-2xl sm:text-3xl font-semibold tabular-nums tracking-tight text-highlighted"
        :data-testid="item.testId"
      >
        {{ item.value ?? '—' }}
      </p>
      <p v-if="item.subtext" class="mt-1 text-xs text-muted">
        {{ item.subtext }}
      </p>
      <div v-if="item.badge" class="mt-2">
        <UBadge :color="item.badge.color ?? 'neutral'" variant="soft" size="xs" :label="item.badge.label" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface MetricItem {
  label: string
  value: string | number | null | undefined
  subtext?: string
  testId?: string
  badge?: {
    label: string
    color?: 'neutral' | 'primary' | 'success' | 'warning' | 'error'
  }
}

defineProps<{
  items: MetricItem[]
}>()
</script>
