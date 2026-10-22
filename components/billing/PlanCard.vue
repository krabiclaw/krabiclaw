<template>
  <div
    ref="card"
    :data-photo-state="animating ? 'flipping' : 'details'"
    @focusin="reveal"
    @pointerdown="reveal"
    @animationend.self="reveal"
    @animationcancel.self="reveal"
    class="relative rounded-[28px] flex flex-col p-8 transition-all duration-300 overflow-hidden"
    :class="[
      photo ? 'kc-photo-plan' : undefined,
      animating ? 'kc-photo-plan--flipping' : undefined,
      isHighlighted
        ? 'bg-gradient-to-b from-zinc-900 to-zinc-950 text-white shadow-2xl border border-primary/55 ring-1 ring-primary/20 scale-[1.02] md:scale-105 z-10'
        : 'bg-elevated/70 backdrop-blur-md border border-default/70 hover:border-primary/35 hover:-translate-y-1 hover:shadow-xl shadow-sm text-default',
    ]"
  >
    <div v-if="photo && (frontImage || plan.image)" class="kc-photo-plan__front" aria-hidden="true">
      <img ref="photoImage" :src="frontImage || plan.image" alt="" loading="eager" decoding="async">
    </div>
    <div class="kc-plan-details">
    <p v-if="photoError" role="alert" class="text-sm mb-3">{{ photoError }}</p>
    <!-- Highlight Gradient Light for Premium Card -->
    <div v-if="isHighlighted" class="absolute -top-24 -right-24 w-48 h-48 bg-primary/20 rounded-full blur-3xl opacity-60"></div>
    <div v-if="isHighlighted" class="absolute -bottom-24 -left-24 w-48 h-48 bg-(--kc-teal)/20 rounded-full blur-3xl opacity-40"></div>

    <!-- Plan image -->
    <div v-if="!photo && plan.image" class="mb-5 rounded-2xl overflow-hidden w-20 h-20 border border-default/50 bg-elevated/50 shadow-sm">
      <img :src="plan.image" :alt="plan.name" loading="lazy" decoding="async" class="w-full h-full object-cover" />
    </div>

    <!-- Header -->
    <div class="kc-plan-header mb-6 relative z-10">
      <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h3 class="text-2xl font-black tracking-tight mb-1.5" :class="isHighlighted ? 'text-white' : 'text-default'">
          {{ plan.name }}
        </h3>
        <span
          v-if="plan.badge"
          class="shrink-0 px-3.5 py-1 text-[11px] font-black tracking-widest uppercase rounded-full text-white bg-gradient-to-r from-primary to-(--kc-coral) shadow-md"
        >
          {{ plan.badge }}
        </span>
      </div>
      <p class="text-xs leading-relaxed" :class="isHighlighted ? 'text-white/60' : 'text-muted'">
        {{ plan.tagline }}
      </p>
    </div>

    <!-- Price -->
    <div class="mb-6 relative z-10">
      <!--
        One price, from the provider that owns it. A plan Stripe returned no
        price for at this interval says so; it used to say "$0", which read as
        a free plan to anyone looking at it.
      -->
      <template v-if="currentPrice !== null">
        <div class="flex items-baseline gap-1">
          <span class="kc-plan-price text-5xl font-black tracking-tight" :class="isHighlighted ? 'text-white' : 'text-default'">
            {{ currentPrice }}
          </span>
          <span class="text-sm font-semibold" :class="isHighlighted ? 'text-white/50' : 'text-muted'">
            {{ billingPeriodLabel }}
          </span>
        </div>
        <p data-plan-locations class="text-xs font-semibold mt-2" :class="isHighlighted ? 'text-white/70' : 'text-muted'">
          {{ locationsNote }}
        </p>
        <p data-plan-homes class="text-xs font-semibold mt-1" :class="isHighlighted ? 'text-white/70' : 'text-muted'">
          {{ homesNote }}
        </p>
        <p v-if="annual && savingsNote" class="text-xs font-semibold mt-2.5 flex items-center gap-1.5" :class="isHighlighted ? 'text-emerald-400' : 'text-emerald-600'">
          <PlatformIcon name="sparkles" class="size-3.5 shrink-0" />
          {{ savingsNote }}
        </p>
      </template>
      <p v-else data-price-unavailable class="text-sm font-semibold" :class="isHighlighted ? 'text-white/70' : 'text-muted'">
        {{ billingPeriodLabel === '/year' ? 'Annual pricing is unavailable right now.' : 'Monthly pricing is unavailable right now.' }}
      </p>
    </div>

    <!-- Divider -->
    <div class="h-px w-full my-1 border-b" :class="isHighlighted ? 'border-white/10' : 'border-default/50'"></div>

    <!-- Features -->
    <ul class="space-y-4 my-6 flex-1 relative z-10">
      <li
        v-for="feature in plan.features"
        :key="feature"
        class="flex items-start gap-3 text-[13.5px] leading-relaxed"
        :class="isHighlighted ? 'text-white/80' : 'text-muted'"
      >
        <div 
          class="w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5"
          :class="isHighlighted ? 'bg-primary/20 text-primary-300' : 'bg-primary/10 text-primary-600'"
        >
          <PlatformIcon name="check" class="size-3" />
        </div>
        <span>{{ feature }}</span>
      </li>
    </ul>

    <!-- CTA -->
    <div class="relative z-10 mt-auto pt-4">
      <slot name="cta">
        <PlatformAccountCta
          v-if="plan.cta"
          :to="plan.cta.href"
          :label="plan.cta.label"
          :variant="photo || isHighlighted ? 'solid' : 'outline'"
          size="xl"
          block
          class="font-bold shadow-sm transition-all duration-300 hover:shadow-md"
        />
      </slot>
    </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import type { Plan } from '~/composables/usePlans'
import { additionalHomePrice, additionalLocationPrice, INCLUDED_HOMES, INCLUDED_LOCATIONS } from '~/shared/billing-model'

const props = defineProps<{
  plan: Plan
  annual?: boolean
  highlighted?: boolean
  photo?: boolean
  frontImage?: string
  sequence?: number
}>()

const card = useTemplateRef<HTMLElement>('card')
const photoImage = useTemplateRef<HTMLImageElement>('photoImage')
const animating = ref(false)
const photoError = ref<string | null>(null)
let revealed = false
function reveal() { revealed = true; animating.value = false }
onMounted(async () => {
  if (!props.photo || !photoImage.value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const image = photoImage.value
  const start = performance.now()
  try {
    await image.decode()
  } catch (error) {
    photoError.value = 'Plan image could not be displayed: ' + (error instanceof Error ? error.message : String(error))
    reveal()
    return
  }
  if (revealed || performance.now() - start > 800 || !image.naturalWidth || document.hidden || card.value?.contains(document.activeElement)) return
  card.value?.style.setProperty('--flip-delay', `${(props.sequence ?? 0) * 1100}ms`)
  animating.value = true
})
useEventListener(computed(() => import.meta.client ? document : undefined), 'visibilitychange', () => { if (document.hidden) reveal() })

const { displayPrice, annualPrice, monthlyPrice } = await usePlans()

const isHighlighted = computed(() => props.highlighted ?? props.plan.highlighted)

const currentPrice = computed(() => displayPrice(props.plan, props.annual ?? false))

const billingPeriodLabel = computed(() => props.photo && props.plan.id === 'free' ? 'No subscription' : (props.annual ?? false) ? '/year' : '/mo')

// Stripe's own phrasing: the included allowance, then the charge per additional unit.
const locationsNote = computed(() => {
  const price = props.plan.prices.find(p => p.interval === ((props.annual ?? false) ? 'year' : 'month'))
  if (!price) return `${INCLUDED_LOCATIONS} locations included`
  return `${INCLUDED_LOCATIONS} locations included, then ${additionalLocationPrice()}`
})
// Homes are counted apart from locations: a home is a place to stay, not a location.
const homesNote = computed(() => {
  const price = props.plan.prices.find(p => p.interval === ((props.annual ?? false) ? 'year' : 'month'))
  if (!price) return `${INCLUDED_HOMES} homes included`
  return `${INCLUDED_HOMES} homes included, then ${additionalHomePrice()}`
})

const savingsNote = computed(() => {
  if (!props.annual) return null
  const monthly = monthlyPrice(props.plan)
  const annual = annualPrice(props.plan)
  if (!monthly || !annual) return null
  const savedPerYear = monthly * 12 - annual
  if (savedPerYear > 0) {
    return `Save $${(savedPerYear / 100).toFixed(0)}/year`
  }
  return null
})
</script>

<style scoped>
.kc-photo-plan { min-width: 0; border-radius: 14px; padding: clamp(1.5rem, 3vw, 2.5rem); transform: none; scale: 1; background: #fff; color: #222840; box-shadow: none; border: 0; perspective: 1600px; transform-style: preserve-3d; overflow: visible; backdrop-filter: none; }
.kc-photo-plan :deep(h3), .kc-photo-plan :deep(.text-default), .kc-photo-plan :deep(.text-white) { color: #222840; }
.kc-photo-plan :deep(.text-white\/60), .kc-photo-plan :deep(.text-white\/50), .kc-photo-plan :deep(.text-white\/80), .kc-photo-plan :deep(.text-muted) { color: #5a6072; }
.kc-photo-plan__front { display: none; position: absolute; inset: 0; z-index: 20; border-radius: inherit; overflow: hidden; pointer-events: none; backface-visibility: hidden; }
.kc-photo-plan__front img { width: 100%; height: 100%; object-fit: cover; }
.kc-photo-plan .kc-plan-details { min-height: 0; }
.kc-photo-plan .kc-plan-header { display: block; margin-bottom: 1.25rem; }
.kc-photo-plan h3 { font-size: 1.9rem; }
.kc-photo-plan .kc-plan-price { font-size: 3rem; line-height: 1.1; font-weight: 600; }
.kc-photo-plan ul { margin: 1rem 0; }
.kc-photo-plan ul > li + li { margin-top: .7rem; }

.kc-photo-plan--flipping { animation: kc-plan-right 1050ms ease-in-out both; animation-delay: var(--flip-delay); }
.kc-plan-details { display: flex; flex-direction: column; flex: 1; }
.kc-photo-plan--flipping .kc-photo-plan__front { display: block; }
.kc-photo-plan--flipping .kc-plan-details { transform: rotateY(180deg); backface-visibility: hidden; }
@keyframes kc-plan-right { 0%, 40% { transform: rotateY(0deg); } 100% { transform: rotateY(180deg); } }
@media (prefers-reduced-motion: reduce) {
  .kc-photo-plan--flipping { animation: none; transform: none; }
  .kc-photo-plan--flipping .kc-plan-details { transform: none; }
  .kc-photo-plan--flipping .kc-photo-plan__front { display: none; }
}
</style>
