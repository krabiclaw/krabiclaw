<template>
  <!--
    What a level's rows are narrowed to, as Airbnb's listing filters: one row of
    round pills under the title, the chosen one solid. Every list and grid that
    filters its rows uses this, so a filter reads the same wherever it is.
  -->
  <div role="group" :aria-label="label" class="flex flex-wrap items-center gap-2">
    <UButton
      v-for="item in items"
      :key="item.value"
      :label="item.label"
      color="neutral"
      :variant="model === item.value ? 'solid' : 'outline'"
      class="h-10 rounded-full px-4 text-sm font-normal"
      :aria-pressed="model === item.value"
      :data-testid="`${id}-${item.value}`"
      @click="model = item.value"
    />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  /** Names the pills for tests and scripts: each is `<id>-<value>`. */
  id: string
  /** What is being filtered, for assistive technology. */
  label: string
  items: ReadonlyArray<{ value: string; label: string }>
}>()

const model = defineModel<string>({ required: true })
</script>
