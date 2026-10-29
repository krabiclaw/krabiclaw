<template>
  <!-- The homepage's pricing band: a gradient wash behind a header and the table. -->
  <section v-if="variant === 'home'" id="pricing" class="relative py-24 overflow-hidden" data-parity-section="plans">
    <div class="absolute inset-0 -z-10" style="background: linear-gradient(180deg, var(--ui-bg) 0%, var(--ui-bg-elevated) 100%);"></div>
    <div class="tenant-container">
      <div class="text-center max-w-2xl mx-auto mb-14 flex flex-col items-center gap-4">
        <span v-if="eyebrow" class="kc-eyebrow text-muted">{{ eyebrow }}</span>
        <h2 class="text-[clamp(32px,4vw,48px)] font-extrabold tracking-tight leading-[1.05] m-0 text-default">{{ title }}</h2>
        <p v-if="description" class="text-lg leading-relaxed text-muted m-0">{{ description }}</p>
      </div>
      <BillingPricingTable :plans="plans" />
    </div>
  </section>

  <section v-else class="kc-pricing-plans" aria-label="Plans" data-parity-section="plans">
    <div class="kc-pricing-plans__rail">
      <BillingPlanCard v-for="(plan, index) in plans" :key="plan.id" :plan="plan" photo :front-image="frontImage(plan.id)" :sequence="index" />
    </div>
    <p class="kc-pricing-plans__hint">Prices in USD. Paid subscription billed monthly.</p>
    <!-- The services, offered under the plans they are added to; each starts only in Plan and billing. -->
    <div class="kc-pricing-addons" data-parity-section="add-ons">
      <h3 class="kc-pricing-addons__title">Add-ons</h3>
      <p class="kc-pricing-addons__lede">Services from KrabiClaw's own people, added to a paid plan from Plan and billing.</p>
      <ul class="kc-pricing-addons__list">
        <li v-for="service in services" :key="service.name" class="kc-pricing-addon">
          <h4>{{ service.name }}</h4>
          <p class="kc-pricing-addon__price">{{ service.price }}</p>
          <p>{{ service.description }}</p>
          <p class="kc-pricing-addon__billing">{{ service.billing }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockTextOrNull, blockMedia } from '~/utils/tenant-page-block-data'
import { useSchemaOrg } from '#imports'
import type { Plan } from '~/composables/usePlans'
import { STARTER_PLAN_ID, NEW_SALE_PAID_PLAN_IDS, SERVICES, SERVICE_PRICES } from '~/shared/billing-model'

/**
 * KrabiClaw's plans, published on KrabiClaw's own pages.
 *
 * The block that places this section stores a heading and `source:
 * billing_plans`, nothing else. Every amount, interval, price id and
 * entitlement comes from the Stripe-backed billing response through the same
 * `usePlans()` / `BillingPricingTable` path the dashboard reads, so the
 * published prices have exactly one source and a document cannot drift from
 * it. The OfferCatalog it publishes follows the same rule: a plan with no
 * subscription price is offered at zero because that is what it costs; a paid
 * plan whose monthly price Stripe did not return has no offer.
 */
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

// Decorative photo fronts belong to this CMS page, not the Stripe Product.
// Stable plan identity selects the existing indexed image placement; provider
// wording, price identities and Product image remain untouched.
function frontImage(planId: string): string | undefined {
  const index = [STARTER_PLAN_ID, ...NEW_SALE_PAID_PLAN_IDS].findIndex(id => id === planId)
  return index >= 0 ? blockMedia(props.block, `items.${index}.image`)[0]?.public_url ?? undefined : undefined
}

const services = [SERVICES.managed_ads, SERVICES.strategy]
const eyebrow = computed(() => blockTextOrNull(props.block.data.eyebrow))
const title = computed(() => blockTextOrNull(props.block.data.title))
const description = computed(() => blockTextOrNull(props.block.data.description))
/** The Pricing page leads with plans; the home page mentions them. */
const variant = computed<'home' | 'pricing'>(() => (props.page.path === '/pricing' ? 'pricing' : 'home'))

const { plans, monthlyPrice } = await usePlans()
const config = useRuntimeConfig()
const pageUrl = resolveSeoUrl('/pricing', config.public.siteUrl)

function offerFor(plan: Plan) {
  const description = plan.tagline
  if (plan.prices.length === 0) {
    return { '@type': 'Offer', name: plan.name, priceCurrency: 'USD', price: '0', description }
  }
  const monthly = monthlyPrice(plan)
  if (monthly === null) return null
  return {
    '@type': 'Offer',
    name: plan.name,
    priceCurrency: 'USD',
    priceSpecification: [{ '@type': 'UnitPriceSpecification', price: String(monthly / 100), priceCurrency: 'USD', billingDuration: 'P1M' }],
    description,
  }
}

// The catalog is stated once, from the pricing page; the homepage repeats the
// table but not the structured data.
useSchemaOrg(computed(() => {
  if (variant.value !== 'pricing') return []
  const offers = plans.value.map(offerFor).filter((offer): offer is NonNullable<ReturnType<typeof offerFor>> => offer !== null)
  if (!offers.length) return []
  // The strategy service has a fixed monthly price; managed ads is a share of spend, which an Offer cannot state.
  offers.push({ '@type': 'Offer', name: SERVICES.strategy.name, priceCurrency: 'USD', description: SERVICES.strategy.description,
    priceSpecification: [{ '@type': 'UnitPriceSpecification', price: String(SERVICE_PRICES.strategy.monthly / 100), priceCurrency: 'USD', billingDuration: 'P1M' }] })
  return {
    '@type': 'OfferCatalog',
    '@id': `${pageUrl}#offers`,
    name: 'KrabiClaw Pricing Plans',
    itemListElement: offers,
  }
}))
</script>

<style scoped>
.kc-pricing-plans { background: #171b31; padding: 0 0 5rem; }
.kc-pricing-plans__rail { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.5rem; max-width: 88rem; margin: 0 auto; padding: 0 2rem; }
.kc-pricing-plans__hint { text-align: center; color: #bbc0cf; font-size: .8rem; margin: 2rem 1.5rem 0; }
.kc-pricing-addons { max-width: 88rem; margin: 4rem auto 0; padding: 0 2rem; }
.kc-pricing-addons__title { color: #fff; font-size: 1.5rem; font-weight: 700; letter-spacing: -.01em; margin: 0; }
.kc-pricing-addons__lede { color: #bbc0cf; margin: .5rem 0 1.5rem; }
.kc-pricing-addons__list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; }
.kc-pricing-addon { background: #fff; color: #222840; border-radius: 14px; padding: clamp(1.5rem, 3vw, 2.5rem); }
.kc-pricing-addon h4 { font-size: 1.35rem; font-weight: 700; margin: 0; }
.kc-pricing-addon__price { font-size: 1.9rem; font-weight: 600; line-height: 1.1; margin: .75rem 0 1rem; }
.kc-pricing-addon p { margin: 0; }
.kc-pricing-addon p + p { margin-top: .6rem; }
.kc-pricing-addon__billing { color: #5a6072; font-size: .9rem; }
@media (max-width: 1100px) { .kc-pricing-addons { max-width: 42rem; padding-inline: 1.25rem; } .kc-pricing-addons__list { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 1100px) { .kc-pricing-plans__rail { grid-template-columns: minmax(0, 1fr); max-width: 42rem; padding-inline: 1.25rem; } }
</style>
