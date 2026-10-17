<template>
  <button
    v-if="isButton"
    v-bind="$attrs"
    :type="type"
    :disabled="disabled || loading"
    :class="classes"
    :data-blawby-critical-button="isBlawby ? '' : undefined"
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
    :data-blawby-critical-button="isBlawby ? '' : undefined"
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
    :data-blawby-critical-button="isBlawby ? '' : undefined"
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
import type { TenantContext } from '~/composables/useTenantOrganization'

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

const tenantContext = useState<TenantContext | null>('tenant-context', () => null)
const isBlawby = computed(() => {
  const org = tenantContext.value?.organization
  return org?.template?.slug === 'blawby' || org?.vertical === 'service'
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

const sayaSizeClasses = {
  sm: 'px-4 py-2 text-xs',
  md: 'px-6 py-3 text-sm min-[1920px]:px-4 min-[1920px]:py-4 min-[1920px]:text-base min-[2560px]:px-5 min-[2560px]:py-5 min-[2560px]:text-lg',
  lg: 'px-6 py-3.5 text-base min-[1920px]:px-6 min-[1920px]:py-5 min-[2560px]:px-8 min-[2560px]:py-6',
}

const blawbySizeClasses = {
  sm: 'px-4 py-2 text-xs',
  md: 'px-4 py-3 text-sm min-[1920px]:px-4 min-[1920px]:py-4 min-[1920px]:text-base min-[2560px]:px-5 min-[2560px]:py-5 min-[2560px]:text-lg',
  lg: 'px-8 py-4 text-lg min-[1920px]:px-4 min-[1920px]:py-4 min-[1920px]:text-base min-[2560px]:px-5 min-[2560px]:py-5 min-[2560px]:text-lg',
}

const sayaVariantClasses = {
  primary: {
    solid: 'bg-primary text-on-primary hover:opacity-90',
    soft: 'bg-primary/10 text-primary hover:bg-primary/15',
    outline: 'border border-primary bg-transparent text-primary hover:bg-primary/10',
    ghost: 'bg-transparent text-primary hover:bg-primary/10',
  },
  error: {
    solid: 'bg-red-600 text-white hover:opacity-90',
    soft: 'bg-red-600/10 text-red-600 hover:bg-red-600/15',
    outline: 'border border-red-600 bg-transparent text-red-600 hover:bg-red-600/10',
    ghost: 'bg-transparent text-red-600 hover:bg-red-600/10',
  },
}

const blawbyVariantClasses = {
  primary: {
    solid: 'bg-[var(--site-accent)] text-[var(--site-on-accent)] hover:bg-[var(--blawby-accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blawby-accent)] focus-visible:ring-offset-2',
    soft: 'bg-[var(--blawby-accent-100)] text-[var(--blawby-primary)] hover:bg-[var(--blawby-accent-200)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blawby-accent)] focus-visible:ring-offset-2',
    outline: 'bg-[var(--blawby-accent-100)] text-[var(--blawby-primary)] hover:bg-[var(--blawby-accent-200)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blawby-accent)] focus-visible:ring-offset-2',
    ghost: 'bg-transparent text-[var(--blawby-primary)] hover:bg-[var(--blawby-accent-100)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blawby-accent)] focus-visible:ring-offset-2',
  },
  error: {
    solid: 'bg-red-600 text-white hover:opacity-90',
    soft: 'bg-red-600/10 text-red-600 hover:bg-red-600/15',
    outline: 'border border-red-600 bg-transparent text-red-600 hover:bg-red-600/10',
    ghost: 'bg-transparent text-red-600 hover:bg-red-600/10',
  },
}

const classes = computed(() => [
  isBlawby.value
    ? 'inline-flex items-center justify-center gap-2 rounded-lg font-semibold uppercase no-underline transition disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blawby-accent)] focus-visible:ring-offset-2'
    : 'inline-flex items-center justify-center gap-2 rounded-full font-medium no-underline transition disabled:opacity-60 disabled:pointer-events-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
  isBlawby.value ? blawbySizeClasses[props.size] : sayaSizeClasses[props.size],
  isBlawby.value ? blawbyVariantClasses[props.color][props.variant] : sayaVariantClasses[props.color][props.variant],
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
