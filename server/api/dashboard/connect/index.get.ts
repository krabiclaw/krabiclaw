import { PAYMENT_TERMS } from '~/shared/billing-model'
import { defineHandler, HTTPError } from 'nitro'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { jsonResponse } from '~/server/utils/api-response'
import { getStripeConnectedAccount, paymentsStripe } from '~/server/utils/stripe-connect'

/** The payout method as Airbnb shows it: the bank on file and when Stripe sends, read live from the connected account. */
export interface ConnectPayoutMethod {
  bankName: string | null
  last4: string
  currency: string
  schedule: { interval: string; delayDays: number }
}

export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardContext(event, {})
  // Connecting the organization's Stripe account is an integration change:
  // owner and admin, per utils/organization-access.ts.
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { payments: ['integration'] } })
  const account = await getStripeConnectedAccount(db, organization.id)
  let payout: ConnectPayoutMethod | null = null
  if (account?.stripeAccountId && account.status === 'ready') {
    const stripe = paymentsStripe(env, account.livemode)
    const [banks, settings] = await Promise.all([
      stripe.accounts.listExternalAccounts(account.stripeAccountId, { object: 'bank_account', limit: 100 }).autoPagingToArray({ limit: 10000 }),
      stripe.accounts.retrieve(account.stripeAccountId),
    ])
    if (!settings.default_currency) throw new HTTPError({ statusCode: 502, statusMessage: 'Stripe account has no default currency', data: { code: 'PAYOUT_CURRENCY_MISSING', field: 'account.default_currency' } })
    const defaultCurrency = settings.default_currency
    const defaultBanks = banks.filter(row => row.object === 'bank_account' && row.default_for_currency && row.currency.toUpperCase() === defaultCurrency.toUpperCase())
    if (banks.length && defaultBanks.length !== 1) throw new HTTPError({ statusCode: 502, statusMessage: 'Stripe must identify one default payout bank for the Stripe account currency', data: { code: 'PAYOUT_BANK_INVALID', field: 'payout.default_for_currency' } })
    const bank = defaultBanks[0]
    const schedule = settings.settings?.payouts?.schedule
    if (bank && (bank.object !== 'bank_account' || !bank.last4 || !schedule || !['daily', 'weekly', 'monthly', 'manual'].includes(schedule.interval) || (!Number.isSafeInteger(schedule.delay_days) || schedule.delay_days < 0))) throw new HTTPError({ statusCode: 502, statusMessage: 'Stripe returned invalid payout bank or schedule data', data: { code: 'PAYOUT_METHOD_INVALID', field: 'payout.schedule' } })
    if (bank?.object === 'bank_account' && schedule) payout = { bankName: bank.bank_name ?? null, last4: bank.last4, currency: bank.currency.toUpperCase(), schedule: { interval: schedule.interval, delayDays: schedule.delay_days } }

  }
  return jsonResponse({ success: true, account, payout, surchargePolicy: PAYMENT_TERMS })
})
