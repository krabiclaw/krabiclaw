<template>
  <component
    :is="component"
    :to="to"
    :external="external"
    :type="to ? undefined : type"
    :disabled="!to && (disabled || loading)"
    :aria-disabled="disabled || loading ? 'true' : undefined"
    :tabindex="to && (disabled || loading) ? -1 : undefined"
    :class="[
      'inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold no-underline transition disabled:pointer-events-none disabled:opacity-60',
      { 'pointer-events-none opacity-60': disabled || loading },
      sizeClass,
      variantClass,
      block ? 'w-full' : ''
    ]"
    @click="handleClick"
  >
    <svg v-if="loading" viewBox="0 0 24 24" fill="none" class="size-4 animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
    </svg>
    <slot v-else />
  </component>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  external?: boolean
  to?: string
  variant?: 'solid' | 'outline' | 'ghost'
  size?: 'sm' | 'md' | 'lg' | 'xl'
  block?: boolean
  loading?: boolean
  disabled?: boolean
  type?: 'button' | 'submit'
}>(), {
  external: false,
  to: undefined,
  variant: 'solid',
  size: 'md',
  block: false,
  loading: false,
  disabled: false,
  type: 'button',
})

const NuxtLink = resolveComponent('NuxtLink')
const component = computed(() => props.to ? NuxtLink : 'button')

const handleClick = (e: Event) => {
  if (props.to && (props.disabled || props.loading)) {
    e.preventDefault()
  }
}

const sizeClass = computed(() => ({
  sm: 'text-[13px] px-3 py-1.5',
  md: 'text-[13.5px] px-4 py-2.5',
  lg: 'text-sm px-5 py-3',
  xl: 'text-base px-6 py-3.5',
}[props.size]))

const variantClass = computed(() => ({
  // Monochrome, as Nuxt UI's neutral solid button: navy in light, white in
  // dark. Coral marks status and selection, not actions.
  solid: 'bg-inverted text-inverted hover:bg-inverted/90',
  outline: 'border border-default text-default hover:bg-muted',
  ghost: 'text-default hover:bg-muted',
}[props.variant]))
</script>
