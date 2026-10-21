import type { Plan } from '~/server/api/billing/plans.get'

export type { Plan, PlanPrice, PlanLimits } from '~/server/api/billing/plans.get'

export const usePlans = async () => {
  const nuxtApp = useNuxtApp()
  const requestEvent = useRequestEvent()
  // Taken before the read: after an await the Nuxt instance is gone.
  const buildId = useRuntimeConfig().app.buildId
  const { data, status, error } = await useAsyncData<Plan[]>('billing-plans', async () => {
    if (import.meta.server) {
      if (!requestEvent) throw createError({ statusCode: 500, statusMessage: 'Request event not available' })
      const [{ cloudflareEnv }, { getCachedPlans }] = await Promise.all([
        import('~/server/utils/api-response'),
        import('~/server/utils/billing-plans'),
      ])
      return await getCachedPlans(cloudflareEnv(requestEvent), buildId)
    }
    return await applicationFetch<Plan[]>('/api/billing/plans', {
      validate: validateApiArrayItems<Plan>({
        id: 'string',
        name: 'string',
        tagline: 'string',
        highlighted: 'boolean',
        prices: 'array',
        features: 'array',
        limits: 'object',
        cta: {
          label: 'string',
          href: 'string',
        },
      }),
    })
  }, {
    server: true,
    getCachedData(key) {
      return nuxtApp.payload.data[key] as Plan[] | undefined
    },
  })

  if (error.value) throw error.value
  if (!data.value) throw createError({ statusCode: 500, statusMessage: 'Billing plans were not loaded' })

  const plans = computed(() => data.value!)

  function monthlyPrice(plan: Plan): number | null {
    return plan.prices.find(p => p.interval === 'month')?.amount ?? null
  }

  function annualPrice(plan: Plan): number | null {
    return plan.prices.find(p => p.interval === 'year')?.amount ?? null
  }

  function formatPrice(cents: number): string {
    return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
  }

  /** A recurring charge in Stripe's pricing phrasing: "$49/mo", "$2,000/mo". The catalog sells in USD only. */
  function formatRecurring(cents: number, currency: string, interval: 'month' | 'year' | string = 'month'): string {
    if (currency.toUpperCase() !== 'USD') throw new Error(`Plan prices are sold in USD, not ${currency}`)
    return `${formatPrice(cents)}/${interval === 'year' ? 'yr' : 'mo'}`
  }

  /**
   * What this plan charges for the requested interval, as Stripe returned it —
   * or null when Stripe returned no such price.
   *
   * A plan with no subscription prices at all is the canonical no-subscription
   * plan and costs nothing; that is a fact about the plan, not a stand-in. A
   * paid plan whose requested interval the provider did not return has no
   * price to show, and answering that with '$0' offered a paid plan for free
   * every time the Stripe catalog was incomplete. Annual is never inferred
   * from monthly, nor monthly from annual: the caller renders the unavailable
   * state instead.
   */
  function displayPrice(plan: Plan, annual: boolean): string | null {
    if (plan.prices.length === 0) return formatPrice(0)
    const cents = annual ? annualPrice(plan) : monthlyPrice(plan)
    return cents === null ? null : formatPrice(cents)
  }

  return { plans, monthlyPrice, annualPrice, formatPrice, formatRecurring, displayPrice, status, error }
}
