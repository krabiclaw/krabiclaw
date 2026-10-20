<template>
  <!--
    What a level's rows are narrowed to, as Airbnb's listing filters: one row of
    round pills under the title, the chosen one solid. Every list and grid that
    filters its rows uses this, so a filter reads the same wherever it is.
  -->
  <div :role="role" :aria-label="label" class="flex flex-wrap items-center gap-2">
    <UButton
      v-for="item in items"
      :key="item.value"
      :label="item.label"
      color="neutral"
      :variant="model === item.value ? selectedVariant : 'outline'"
      class="h-10 rounded-full px-4 text-sm font-normal"
      :class="selectedVariant === 'outline' && model === item.value ? 'ring-2 ring-inset ring-(color:--ui-text-highlighted) bg-default text-highlighted' : undefined"
      :role="role === 'tablist' ? 'tab' : undefined"
      :aria-selected="role === 'tablist' ? model === item.value : undefined"
      :aria-pressed="role !== 'tablist' ? model === item.value : undefined"
      :data-testid="`${id}-${item.value}`"
      @click="model = item.value"
    />
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  /** Names the pills for tests and scripts: each is `<id>-<value>`. */
  id: string
  /** What is being filtered, for assistive technology. */
  label: string
  items: ReadonlyArray<{ value: string; label: string }>
  /** Semantics: 'group' for filter toggles (default), 'tablist' when selecting views/sections. */
  role?: 'group' | 'tablist'
  /** Picker categories keep the selected pill outlined, as Airbnb's amenities. */
  selectedVariant?: 'solid' | 'outline'
}>(), {
  role: 'group',
  selectedVariant: 'solid',
})

const model = defineModel<string>({ required: true })
</script>
