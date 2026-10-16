<template>
  <!-- Which locations a level shows: one outlined pill in the filter row under its title, as Airbnb's listing filters. -->
  <USelect
    v-model="model"
    :items="items"
    icon="i-lucide-map-pin"
    class="h-10 min-w-48 rounded-full"
    aria-label="Location"
  />
</template>

<script setup lang="ts">
defineProps<{
  /** "All locations" first, then each location; a picture where the location has one. */
  items: { label: string; value: string; avatar?: { src: string } }[]
}>()

const model = defineModel<string>({ required: true })
</script>
