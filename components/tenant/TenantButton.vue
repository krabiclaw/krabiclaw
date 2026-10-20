<template>
  <button
    v-if="isButton"
    v-bind="$attrs"
    :type="type"
    :disabled="disabled || loading"
    :class="classes"
    data-tenant-button
    @click="handleClick"
  >
    <TenantIcon v-if="loading" name="arrow-path" class="size-4 animate-spin" />
    <slot v-else name="leading" />
    <slot />
  </button>
  <label
    v-else-if="controlId"
    :for="controlId"
    v-bind="$attrs"
    role="button"
    :tabindex="disabled || loading ? -1 : 0"
    :class="classes"
    data-tenant-button
    @keydown.enter.prevent="activateControl"
    @keydown.space.prevent="activateControl"
    @click="handleClick"
  >
    <TenantIcon v-if="loading" name="arrow-path" class="size-4 animate-spin" />
    <slot v-else name="leading" />
    <slot />
  </label>
  <component
    :is="linkTag"
    v-else
    v-bind="$attrs"
    :href="isExternal ? targetUrl : undefined"
    :to="isExternal ? undefined : targetUrl"
    :target="computedTarget"
    :rel="computedRel"
    :class="classes"
    :aria-disabled="disabled || loading || undefined"
    :tabindex="disabled || loading ? -1 : undefined"
    data-tenant-button
    @click="handleClick"
  >
    <TenantIcon v-if="loading" name="arrow-path" class="size-4 animate-spin" />
    <slot v-else name="leading" />
    <slot />
  </component>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  to?: string
  href?: string
  as?: 'button' | 'link'
  type?: 'button' | 'submit' | 'reset'
  variant?: 'solid' | 'soft' | 'outline' | 'ghost'
  color?: 'primary' | 'error'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  disabled?: boolean
  block?: boolean
  target?: '_blank' | '_self' | '_parent' | '_top'
  rel?: string
  controlId?: string
}>(), {
  to: '',
  href: '',
  as: undefined,
  type: 'button',
  variant: 'solid',
  color: 'primary',
  size: 'md',
  loading: false,
  disabled: false,
  block: false,
})

const emit = defineEmits<{
  click: [event: Event]
}>()

const targetUrl = computed(() => props.to || props.href || '')
const isButton = computed(() => props.as === 'button' || (!targetUrl.value && !props.controlId))
const isHttp = computed(() => /^https?:\/\//i.test(targetUrl.value))
const isExternal = computed(() => !isButton.value && (isHttp.value || targetUrl.value.startsWith('mailto:') || targetUrl.value.startsWith('tel:')))
const computedTarget = computed(() => props.target || (isHttp.value ? '_blank' : undefined))
const computedRel = computed(() => props.rel || (isHttp.value ? 'noopener noreferrer' : undefined))
const linkTag = computed(() => (isExternal.value ? 'a' : NuxtLink))

function activateControl(event: KeyboardEvent) {
  if (!props.disabled && !props.loading) {
    (event.currentTarget as HTMLElement).click()
  }
}

const sizeClasses = {
  sm: 'px-4 py-2 text-xs',
  md: 'px-5 py-3 text-sm min-[1920px]:px-4 min-[1920px]:py-4 min-[1920px]:text-base min-[2560px]:px-5 min-[2560px]:py-5 min-[2560px]:text-lg',
  lg: 'px-7 py-3.5 text-base min-[1920px]:px-6 min-[1920px]:py-5 min-[2560px]:px-8 min-[2560px]:py-6',
}

const variantClasses = {
  primary: {
    solid: 'bg-[var(--site-button-bg,var(--site-action))] text-[var(--site-button-text,var(--site-on-action,#fff))] hover:bg-[var(--site-button-hover-bg,var(--site-action))] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--site-button-ring,var(--site-action))] focus-visible:ring-offset-2',
    soft: 'bg-[var(--tenant-primary-100,rgba(37,53,108,0.1))] text-[var(--tenant-primary,var(--site-action))] hover:bg-[var(--tenant-primary-200,rgba(37,53,108,0.15))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--site-button-ring,var(--site-action))] focus-visible:ring-offset-2',
    outline: 'border border-[var(--site-button-ring,var(--site-action))] bg-transparent text-[var(--tenant-primary,var(--site-action))] hover:bg-[var(--tenant-primary-100,rgba(37,53,108,0.1))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--site-button-ring,var(--site-action))] focus-visible:ring-offset-2',
    ghost: 'bg-transparent text-[var(--tenant-primary,var(--site-action))] hover:bg-[var(--tenant-primary-100,rgba(37,53,108,0.1))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--site-button-ring,var(--site-action))] focus-visible:ring-offset-2',
  },
  error: {
    solid: 'bg-red-600 text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2',
    soft: 'bg-red-600/10 text-red-600 hover:bg-red-600/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2',
    outline: 'border border-red-600 bg-transparent text-red-600 hover:bg-red-600/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2',
    ghost: 'bg-transparent text-red-600 hover:bg-red-600/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2',
  },
}

const classes = computed(() => [
  'inline-flex items-center justify-center gap-2 no-underline transition disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
  'rounded-[var(--site-button-radius,9999px)] [text-transform:var(--site-button-transform,none)] [letter-spacing:var(--site-button-tracking,normal)] font-[var(--site-button-weight,500)]',
  sizeClasses[props.size],
  variantClasses[props.color][props.variant],
  props.block && 'w-full',
])

function handleClick(e: Event) {
  if (props.disabled || props.loading) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  emit('click', e)
}
</script>
