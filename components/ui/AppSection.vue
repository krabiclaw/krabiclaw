<template>
  <section :class="['w-full', bgClass, paddings[padding]]">
    <div class="tenant-container">
      <slot />
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({
  bg: {
    type: String,
    default: 'white',
    validator: v => ['white', 'default', 'black', 'dark', 'alt', 'gray', 'stone'].includes(v)
  },
  padding: {
    type: String,
    default: 'default',
    validator: v => ['none', 'sm', 'default', 'lg', 'xl'].includes(v)
  }
})

const backgrounds = {
  white: 'bg-default text-default',
  default: 'bg-default text-default',
  alt: 'bg-elevated text-default',
  black: 'bg-inverted text-inverted',
  dark: 'bg-inverted text-inverted',
  gray: 'bg-elevated text-default',
  stone: 'bg-elevated text-default'
}

const bgClass = computed(() => backgrounds[props.bg])

const paddings = {
  none: 'py-0',
  sm: 'py-8',
  default: 'py-16',
  lg: 'py-20',
  xl: 'py-24'
}
</script>
