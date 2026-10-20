import { HTTPError } from 'nitro'
import { AD_SPEND_RATE } from '~/shared/billing-model'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import { linkedAccountAccessToken, type CloudflareEnv } from '~/server/utils/auth'
import { getOrganizationBillingStatus, getStripe } from '~/server/utils/billing'
import { paymentsUsage } from '~/server/domain/payments/usage'
import { readIntegration } from '~/server/utils/organization-integrations'
import { getGoogleAdsCustomer } from '~/server/utils/google-ads'

/**
 * The services a business asked KrabiClaw's people for. Managed ads: Chris and
 * Julia run the Google Ads campaigns, billed at the ad-spend price on the
 * Business subscription. Agreeing writes the consent; ending it closes the row.
 */
export const SERVICES = ['managed_ads'] as const
export type Service = typeof SERVICES[number]
/** Bump when the terms a business agrees to change; the row keeps the version it agreed to. */
export const SERVICE_TERMS_VERSION: Record<Service, string> = { managed_ads: '2026-10-18.2' }

export interface ServiceAgreement { id: string; service: Service; terms_version: string; agreed_by_user_id: string | null; agreed_at: string; ended_at: string | null }

export function isService(value: unknown): value is Service {
  return typeof value === 'string' && (SERVICES as readonly string[]).includes(value)
}

/** The current agreement per service, when there is one. */
export async function listServices(db: DbClient, organizationId: string): Promise<Record<Service, ServiceAgreement | null>> {
  const rows = await queryAll<ServiceAgreement>(db, 'SELECT id,service,terms_version,agreed_by_user_id,agreed_at,ended_at FROM organization_services WHERE organization_id=? AND ended_at IS NULL', [organizationId])
  return Object.fromEntries(SERVICES.map(service => [service, rows.find(row => row.service === service) ?? null])) as Record<Service, ServiceAgreement | null>
}

export async function agreeToService(db: DbClient, env: CloudflareEnv, organizationId: string, service: Service, userId: string): Promise<ServiceAgreement> {
  const current = await queryFirst<{ id: string }>(db, 'SELECT id FROM organization_services WHERE organization_id=? AND service=? AND ended_at IS NULL', [organizationId, service])
  if (current) throw new HTTPError({ statusCode: 409, statusMessage: 'This service is already on' })
  // Consent starts billable work: the fee is the ad-spend price on the Business
  // subscription, charged to the card it is paid with.
  const { configured, pricing } = await paymentsUsage(db, env, organizationId)
  if (!configured || pricing?.ad_spend_rate !== AD_SPEND_RATE) {
    throw new HTTPError({ statusCode: 409, message: 'Managed ads is billed on the Business plan. Choose Business in Plan before turning on managed ads.' })
  }
  const billing = await getOrganizationBillingStatus(env, db, organizationId)
  const subscription = await getStripe(env).subscriptions.retrieve(billing.stripeSubscriptionId!)
  const customer = await getStripe(env).customers.retrieve(billing.stripeCustomerId!)
  if (customer.deleted || (!subscription.default_payment_method && !customer.invoice_settings.default_payment_method)) {
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
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM organization_integrations WHERE organization_id=? AND provider='google_ads' AND revision=?)`, [id, organizationId, service, SERVICE_TERMS_VERSION[service], userId, now, organizationId, ads.revision])
  if (result.meta.changes !== 1) throw new HTTPError({ statusCode: 409, message: 'Google Ads changed. Reload before turning on managed ads.' })
  const written = (await listServices(db, organizationId))[service]
  if (!written || written.id !== id) throw new Error('Service agreement was not recorded')
  return written
}

export async function endService(db: DbClient, organizationId: string, service: Service, userId: string): Promise<void> {
  const now = new Date().toISOString()
  const result = await execute(db, 'UPDATE organization_services SET ended_at=?,ended_by_user_id=? WHERE organization_id=? AND service=? AND ended_at IS NULL', [now, userId, organizationId, service])
  if (!result.meta.changes) throw new HTTPError({ statusCode: 409, statusMessage: 'This service is not on' })
}
