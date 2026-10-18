import { HTTPError } from 'nitro'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { linkedAccountAccessToken, type CloudflareEnv } from '~/server/utils/auth'
import { getStripe } from '~/server/utils/billing'
import { paymentsBillingPricing } from '~/server/domain/payments/usage'
import { readIntegration } from '~/server/utils/organization-integrations'
import { getGoogleAdsCustomer } from '~/server/utils/google-ads'

/**
 * The services a business asked KrabiClaw's people for. Managed ads: Chris and
 * Julia run the Google Ads campaigns, billed at the ad-spend rate on the
 * Payments rate card. Agreeing writes the consent; ending it closes the row.
 */
export const SERVICES = ['managed_ads'] as const
export type Service = typeof SERVICES[number]
/** Bump when the terms a business agrees to change; the row keeps the version it agreed to. */
export const SERVICE_TERMS_VERSION: Record<Service, string> = { managed_ads: '2026-10-18.1' }

export interface ServiceAgreement { id: string; service: Service; terms_version: string; agreed_by_user_id: string | null; agreed_at: string; ended_at: string | null }

export function isService(value: unknown): value is Service {
  return typeof value === 'string' && (SERVICES as readonly string[]).includes(value)
}

/** The current agreement per service, when there is one. */
export async function listServices(db: DbClient, organizationId: string): Promise<Record<Service, ServiceAgreement | null>> {
  const rows = await queryAll<ServiceAgreement>(db, 'SELECT id,service,terms_version,agreed_by_user_id,agreed_at,ended_at FROM organization_services WHERE organization_id=? AND ended_at IS NULL', [organizationId])
  return Object.fromEntries(SERVICES.map(service => [service, rows.find(row => row.service === service) ?? null])) as Record<Service, ServiceAgreement | null>
}

/**
 * The organizations on a service at an instant — for billing a day, its end:
 * a day's spend is billed when the service was on as that day closed, whether
 * it was agreed to during the day or ended after it.
 */
export async function organizationsOnServiceAt(db: DbClient, service: Service, at: string): Promise<string[]> {
  return (await queryAll<{ organization_id: string }>(db, 'SELECT DISTINCT organization_id FROM organization_services WHERE service=? AND agreed_at<=? AND (ended_at IS NULL OR ended_at>?) ORDER BY organization_id', [service, at, at])).map(row => row.organization_id)
}

export async function agreeToService(db: DbClient, env: CloudflareEnv, organizationId: string, service: Service, userId: string): Promise<ServiceAgreement> {
  const current = await queryFirst<{ id: string }>(db, 'SELECT id FROM organization_services WHERE organization_id=? AND service=? AND ended_at IS NULL', [organizationId, service])
  if (current) throw new HTTPError({ statusCode: 409, statusMessage: 'This service is already on' })
  // Consent starts billable work. A copied mapping alone cannot establish that
  // the native contract, its current rate and its collection customer work.
  const { account, contract, pricing } = await paymentsBillingPricing(db, env, organizationId)
  if (!account || account.status !== 'active' || !contract || contract.ending_before || !pricing) {
    throw new HTTPError({ statusCode: 409, message: 'Set up active Payments billing in Plan before turning on managed ads. Choose a plan with Payments if your business does not have billing set up.' })
  }
  if (pricing.ad_spend_rate !== 0.1) throw new HTTPError({ statusCode: 409, message: 'Your Payments contract does not have the managed ads rate. Contact support to complete billing setup.' })
  const customer = await getStripe(env).customers.retrieve(account.stripe_billing_customer_id)
  if (customer.deleted || !customer.invoice_settings.default_payment_method) {
    throw new HTTPError({ statusCode: 409, message: 'Add a payment method and set it as default in Payments before turning on managed ads.' })
  }
  const ads = await readIntegration(db, organizationId, 'google_ads')
  if (!ads) throw new HTTPError({ statusCode: 409, message: 'Connect a Google Ads account billed in USD in Integrations → Google Ads before turning on managed ads.' })
  const { accessToken } = await linkedAccountAccessToken(env, ads.account_id)
  const adsCustomer = await getGoogleAdsCustomer(accessToken, env.GOOGLE_ADS_DEVELOPER_TOKEN, ads.target_id)
  if (adsCustomer.currencyCode !== 'USD') throw new HTTPError({ statusCode: 409, message: 'Managed ads currently requires a Google Ads account billed in USD. You can keep this account connected for free reporting in Insights.' })
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const result = await execute(db, `INSERT INTO organization_services(id,organization_id,service,terms_version,agreed_by_user_id,agreed_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM payment_billing_accounts WHERE organization_id=? AND status='active' AND metronome_contract_id=?)
    AND EXISTS(SELECT 1 FROM organization_integrations WHERE organization_id=? AND provider='google_ads' AND revision=?)`, [id, organizationId, service, SERVICE_TERMS_VERSION[service], userId, now, organizationId, account.metronome_contract_id, organizationId, ads.revision])
  if (result.meta.changes !== 1) throw new HTTPError({ statusCode: 409, message: 'Payments billing or Google Ads changed. Reload before turning on managed ads.' })
  const written = (await listServices(db, organizationId))[service]
  if (!written || written.id !== id) throw new Error('Service agreement was not recorded')
  return written
}

export async function endService(db: DbClient, organizationId: string, service: Service, userId: string): Promise<void> {
  const now = new Date().toISOString()
  const result = await execute(db, 'UPDATE organization_services SET ended_at=?,ended_by_user_id=? WHERE organization_id=? AND service=? AND ended_at IS NULL', [now, userId, organizationId, service])
  if (!result.meta.changes) throw new HTTPError({ statusCode: 409, statusMessage: 'This service is not on' })
}
