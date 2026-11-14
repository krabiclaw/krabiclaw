import { defineHandler } from 'nitro'
import { queryFirst } from '~/server/db'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { jsonResponse } from '~/server/utils/api-response'
import { organizationPaymentsLivemode, paymentsStripe } from '~/server/utils/stripe-connect'

/**
 * Stripe supplies the choices. The completed onboarding answer can suggest
 * a selection before a connected account exists.
 */
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { payments: ['integration'] } })
  const [specs, onboarding] = await Promise.all([
    paymentsStripe(env, organizationPaymentsLivemode(env, organization)).countrySpecs.list({ limit: 100 }).autoPagingToArray({ limit: 250 }),
    queryFirst<{ country: string | null }>(db, `
      SELECT json_extract(payload_json, '$.source.details.country') AS country
      FROM onboarding_drafts
      WHERE organization_id = ? AND status = 'committed'
      ORDER BY committed_at DESC, id DESC
      LIMIT 1
    `, [organization.id]),
  ])
  const countries = specs.map(country => country.id)
  const answer = onboarding?.country
  return jsonResponse({ success: true, countries, suggested_country: answer && countries.includes(answer) ? answer : null })
})
