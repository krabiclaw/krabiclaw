import { HTTPError, defineHandler } from 'nitro'
import { setHeader } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { cloudflareEnv, textResponse } from '~/server/utils/api-response'
import { getCachedPlans, type EnvWithOrganizationCache, type Plan } from '~/server/utils/billing-plans'
import { TENANT_TYPES } from '~/utils/tenant-routing'
import { additionalHomePrice, BUSINESS_PLAN_ID, INCLUDED_HOMES, PAYMENTS_FEE, SERVICES } from '~/shared/billing-model'

export function renderPlansMarkdown(plans: Plan[]): string {
  const lines: string[] = [
    '# KrabiClaw Pricing & Plans',
    '',
    '> Transparent pricing for the KrabiClaw conversational AI website builder.',
    '',
  ]

  for (const plan of plans) {
    const monthlyPrice = plan.prices.find(p => p.interval === 'month')
    const priceLabel = monthlyPrice
      ? `$${monthlyPrice.amount / 100}/month`
      : 'Free ($0/month)'

    lines.push(`## ${plan.name}`)
    lines.push(`- **Price**: ${priceLabel}`)
    lines.push(`- **Homes**: ${INCLUDED_HOMES} included${monthlyPrice ? `, then ${additionalHomePrice()}` : ''}. A home is a place to stay.`)
    if (plan.id === BUSINESS_PLAN_ID) {
      lines.push(`- **Payments fees**: ${PAYMENTS_FEE}.`)
    }
    if (monthlyPrice) lines.push('- **Billing**: Additional homes and fees are billed on your subscription invoice at the end of each month.')
    lines.push(`- **Tagline**: ${plan.tagline}`)

    if (plan.limits) {
      lines.push('- **Limits & Entitlements**:')
      lines.push(`  - Custom Domain: ${plan.limits.customDomain ? 'Included' : 'Not included'}`)
      lines.push(`  - Google Places Integration: ${plan.limits.googlePlaces ? 'Included' : 'Not included'}`)
      lines.push(`  - Support Tier: ${plan.limits.support}`)
    }

    if (plan.features.length) {
      lines.push('- **Features**:')
      for (const feature of plan.features) {
        lines.push(`  - ${feature}`)
      }
    }

    lines.push('')
  }

  lines.push('## Add-ons')
  lines.push('Services from KrabiClaw\'s own people, added to a paid plan from Plan and billing.')
  for (const service of [SERVICES.managed_ads, SERVICES.strategy]) {
    lines.push(`- **${service.name}**: ${service.price}. ${service.description} ${service.billing}`)
  }
  lines.push('')
  lines.push('---')
  lines.push('For questions, documentation, or custom enterprise requirements, visit https://krabiclaw.com/docs or contact hello@krabiclaw.com.')
  lines.push('')

  return lines.join('\n')
}

export default defineHandler(async (event) => {
  if (event.context.tenantType === TENANT_TYPES.TENANT) {
    throw new HTTPError({
      statusCode: 404,
      statusMessage: 'Not Found',
    })
  }

  const env = cloudflareEnv(event)
  if (!env.STRIPE_SECRET_KEY) {
    throw new HTTPError({
      statusCode: 503,
      statusMessage: 'Billing provider is not configured',
    })
  }

  const plans = await getCachedPlans(env as EnvWithOrganizationCache, useRuntimeConfig().app.buildId)
  setHeader(event, 'cache-control', 'public, max-age=3600, stale-while-revalidate=86400')
  return textResponse(renderPlansMarkdown(plans), {}, 'text/markdown; charset=utf-8')
})
