<template>
  <div :class="centered ? 'mx-auto max-w-2xl md:text-center' : 'max-w-2xl'">
    <p v-if="eyebrow" class="mb-3 text-sm font-semibold uppercase text-primary">{{ eyebrow }}</p>
    <component :is="tag" class="tenant-display text-3xl font-bold text-highlighted sm:text-4xl">
      {{ split.before }}<span v-if="split.accent" class="text-primary">{{ split.accent }}</span>{{ split.after }}
    </component>
    <p v-if="description" class="mt-4 text-lg leading-8 text-muted">{{ description }}</p>
  </div>
</template>

<script setup lang="ts">
import { blawbySplitAccent } from '~/types/blawby'

const props = withDefaults(defineProps<{
  title: string
  accent?: string | null
  description?: string | null
  eyebrow?: string | null
  centered?: boolean
  tag?: 'h1' | 'h2' | 'h3'
}>(), {
  accent: null,
  description: null,
  eyebrow: null,
  centered: false,
  tag: 'h2',
})

const split = computed(() => blawbySplitAccent(props.title, props.accent))
</script>
