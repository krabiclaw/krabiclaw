import { HTTPError, defineHandler } from 'nitro'
import { setHeader } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { cloudflareEnv, textResponse } from '~/server/utils/api-response'
import { getCachedPlans, type EnvWithOrganizationCache, type Plan } from '~/server/utils/billing-plans'
import { TENANT_TYPES } from '~/utils/tenant-routing'
import { additionalLocationPrice, INCLUDED_LOCATIONS } from '~/shared/billing-model'

export function renderPlansMarkdown(plans: Plan[]): string {
  const lines: string[] = [
    '# KrabiClaw Pricing & Plans',
    '',
    '> Transparent pricing for the KrabiClaw conversational AI website builder.',
    '',
  ]

  for (const plan of plans) {
    const monthlyPrice = plan.prices.find(p => p.interval === 'month')
    const annualPrice = plan.prices.find(p => p.interval === 'year')
    const priceLabel = monthlyPrice
      ? `$${monthlyPrice.amount / 100}/month`
      : 'Free ($0/month)'

    lines.push(`## ${plan.name}`)
    lines.push(`- **Price**: ${priceLabel}${annualPrice ? ` ($${annualPrice.amount / 100}/year)` : ''}`)
    lines.push(`- **Locations**: ${INCLUDED_LOCATIONS} included${monthlyPrice
      ? `, then ${additionalLocationPrice('month')}${annualPrice ? ` (${additionalLocationPrice('year')})` : ''}`
      : ''}`)
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
