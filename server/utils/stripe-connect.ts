import { HTTPError } from 'nitro'
import { paymentsBillingPricing } from '~/server/domain/payments/usage'
import type Stripe from 'stripe'
import { execute, queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { createStripeClient } from '~/server/utils/stripe-client'
import { isDemoOrganization } from '~/shared/demo'

export type StripeConnectStatus =
  | 'creating'
  | 'creation_failed'
  | 'action_required'
  | 'pending_review'
  | 'restricted'
  | 'ready'

export type StripeCapabilityStatus = 'active' | 'pending' | 'restricted' | 'unsupported'

export interface StripeConnectRequirement {
  awaitingActionFrom: 'stripe' | 'user'
  deadlineStatus: 'currently_due' | 'eventually_due' | 'past_due'
  description: string
  errors: string[]
}

export interface StripeConnectedAccount {
  id: string
  organizationId: string
  stripeAccountId: string | null
  /** The account's country as Stripe reports it; null before account creation. */
  country: string | null
  livemode: boolean
  status: StripeConnectStatus
  cardPaymentsStatus: StripeCapabilityStatus | null
  /** Pass on credit card fees: the surcharge rate in basis points, bounded by Stripe's maximum per card; null is off. */
  surchargeBasisPoints: number | null
  requirements: StripeConnectRequirement[]
  stripeRefreshedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

interface StripeConnectedAccountRow {
  id: string
  organization_id: string
  stripe_account_id: string | null
  country: string | null
  livemode: number
  status: StripeConnectStatus
  card_payments_status: StripeCapabilityStatus | null
  surcharge_basis_points: number | null
  requirements_json: string
  stripe_refreshed_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface StripeConnectProjection {
  reservationId: string
  organizationId: string
  stripeAccountId: string
  country: string | null
  livemode: boolean
  cardPaymentsStatus: StripeCapabilityStatus | null
  requirements: StripeConnectRequirement[]
  stripeRefreshedAt: string
  financialContractSupported?: boolean
}

function parseRequirements(value: string): StripeConnectRequirement[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new Error('Stored Stripe Connect requirements are invalid')
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Stored Stripe Connect requirement is invalid')
    const requirement = item as Record<string, unknown>
    if (
      (requirement.awaitingActionFrom !== 'stripe' && requirement.awaitingActionFrom !== 'user')
      || (requirement.deadlineStatus !== 'currently_due' && requirement.deadlineStatus !== 'eventually_due' && requirement.deadlineStatus !== 'past_due')
      || typeof requirement.description !== 'string'
      || !Array.isArray(requirement.errors)
      || !requirement.errors.every(error => typeof error === 'string')
    ) throw new Error('Stored Stripe Connect requirement is invalid')
  }
  return parsed as StripeConnectRequirement[]
}

function mapConnectedAccount(row: StripeConnectedAccountRow): StripeConnectedAccount {
  return {
    id: row.id,
    organizationId: row.organization_id,
    stripeAccountId: row.stripe_account_id,
    country: row.country,
    livemode: Boolean(row.livemode),
    status: row.status,
    cardPaymentsStatus: row.card_payments_status,
    surchargeBasisPoints: row.surcharge_basis_points,
    requirements: parseRequirements(row.requirements_json),
    stripeRefreshedAt: row.stripe_refreshed_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function stripeLivemodeFromKey(secretKey: string): boolean {
  if (/^(?:sk|rk)_live_/u.test(secretKey)) return true
  if (/^(?:sk|rk)_test_/u.test(secretKey)) return false
  throw new Error('Stripe key mode cannot be determined')
}

/** The platform's own mode, set by its key. Platform billing and usage only ever run in this mode. */
export function platformLivemode(env: CloudflareEnv): boolean {
  if (!env.STRIPE_SECRET_KEY) throw new HTTPError({ statusCode: 503, statusMessage: 'Stripe is not configured' })
  return stripeLivemodeFromKey(env.STRIPE_SECRET_KEY)
}

/** A demo organization takes payments in Stripe test mode; every other business in the platform's mode. */
export function organizationPaymentsLivemode(env: CloudflareEnv, organization: { subdomain?: string | null }): boolean {
  return isDemoOrganization(organization) ? false : platformLivemode(env)
}

/**
 * The tenant-payments Stripe keys for one mode, or null when that mode is not
 * configured. The platform mode uses the platform's keys; a live platform also
 * holds the same Stripe account's test-mode keys (STRIPE_TEST_*) for demo
 * organizations.
 */
export function paymentsStripeKeys(env: CloudflareEnv, livemode: boolean) {
  if (!env.STRIPE_SECRET_KEY) return null
  const keys = livemode === stripeLivemodeFromKey(env.STRIPE_SECRET_KEY)
    ? { secretKey: env.STRIPE_SECRET_KEY, publishableKey: env.NUXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, methodConfiguration: env.STRIPE_PAYMENTS_METHOD_CONFIGURATION, connectWebhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET, paymentsWebhookSecret: env.STRIPE_PAYMENTS_WEBHOOK_SECRET }
    : { secretKey: env.STRIPE_TEST_SECRET_KEY, publishableKey: env.STRIPE_TEST_PUBLISHABLE_KEY, methodConfiguration: env.STRIPE_TEST_PAYMENTS_METHOD_CONFIGURATION, connectWebhookSecret: env.STRIPE_TEST_CONNECT_WEBHOOK_SECRET, paymentsWebhookSecret: env.STRIPE_TEST_PAYMENTS_WEBHOOK_SECRET }
  if (!keys.secretKey || stripeLivemodeFromKey(keys.secretKey) !== livemode) return null
  return { ...keys, secretKey: keys.secretKey }
}

export function paymentsStripe(env: CloudflareEnv, livemode: boolean): Stripe {
  const keys = paymentsStripeKeys(env, livemode)
  if (!keys) throw new HTTPError({ statusCode: 503, statusMessage: `Stripe ${livemode ? 'live' : 'test'} mode is not configured` })
  return createStripeClient(keys.secretKey, 'payments')
}

export function buildStripeConnectOnboardingUrls(
  platformOrigin: string,
  organizationSlug: string,
): { returnUrl: string; refreshUrl: string } {
  let origin: URL
  try {
    origin = new URL(platformOrigin)
  } catch {
    throw new Error('Stripe Connect platform origin is invalid')
  }
  if (origin.protocol !== 'https:') throw new Error('Stripe Connect platform origin must use HTTPS')
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Stripe Connect platform origin must be an origin without credentials, path, query, or fragment')
  }
  if (!organizationSlug.trim() || /[\/\\]/u.test(organizationSlug) || Array.from(organizationSlug).some(character => character.codePointAt(0)! < 32)) {
    throw new Error('Stripe Connect organization slug is invalid')
  }
  const returnUrl = new URL(`/dashboard/${encodeURIComponent(organizationSlug)}/payments`, origin)
  returnUrl.searchParams.set('tab', 'payouts')
  returnUrl.searchParams.set('stripe_connect', 'returned')
  const refreshUrl = new URL('/api/dashboard/connect/refresh', origin)
  refreshUrl.searchParams.set('org', organizationSlug)
  return { returnUrl: returnUrl.toString(), refreshUrl: refreshUrl.toString() }
}

export function deriveStripeConnectStatus(input: {
  cardPaymentsStatus: StripeCapabilityStatus | null
  requirements: StripeConnectRequirement[]
}): Exclude<StripeConnectStatus, 'creating' | 'creation_failed'> {
  const userActionDue = input.requirements.some(requirement =>
    requirement.awaitingActionFrom === 'user'
    && (requirement.deadlineStatus === 'currently_due' || requirement.deadlineStatus === 'past_due'))
  if (userActionDue) return 'action_required'
  if (input.cardPaymentsStatus === 'active') return 'ready'
  if (input.cardPaymentsStatus === 'restricted' || input.cardPaymentsStatus === 'unsupported') return 'restricted'
  return 'pending_review'
}

export async function getStripeConnectedAccount(
  db: DbClient,
  organizationId: string,
): Promise<StripeConnectedAccount | null> {
  const row = await queryFirst<StripeConnectedAccountRow>(db, `
    SELECT id, organization_id, stripe_account_id, country, livemode, status,
           card_payments_status, surcharge_basis_points, requirements_json, stripe_refreshed_at,
           last_error, created_at, updated_at
    FROM stripe_connected_accounts
    WHERE organization_id = ?
    LIMIT 1
  `, [organizationId])
  return row ? mapConnectedAccount(row) : null
}

/** Known checkout setup, read once for a catalogue; final checkout still verifies native providers. */
export async function readStripeCheckoutSetup(db: DbClient, organizationId: string, env: CloudflareEnv) {
  const [connected, organization, entitled] = await Promise.all([
    getStripeConnectedAccount(db, organizationId),
    queryFirst<{ slug: string; subdomain: string | null; billing_status: string | null; billing_customer: string | null; customer: string | null; contract: string | null; currency: string | null; start: string | null; servicing: number }>(db, `
      SELECT o.slug, o.subdomain, b.status AS billing_status, b.stripe_billing_customer_id AS billing_customer,
             b.metronome_customer_id AS customer, b.metronome_contract_id AS contract, b.currency, b.contract_start_at AS start,
             EXISTS(SELECT 1 FROM payment_servicing_tenants WHERE organization_id=o.id) AS servicing
        FROM organization o LEFT JOIN payment_billing_accounts b ON b.organization_id=o.id WHERE o.id=?
    `, [organizationId]),
    hasOrganizationEntitlement(env, organizationId, 'payments'),
  ])
  if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  const missing: string[] = []
  if (!entitled) missing.push('payments.entitlement')
  const livemode = env.STRIPE_SECRET_KEY ? organizationPaymentsLivemode(env, organization) : null
  const keys = livemode === null ? null : paymentsStripeKeys(env, livemode)
  if (!keys?.methodConfiguration || !env.NUXT_PUBLIC_PLATFORM_DOMAIN || !env.METRONOME_API_KEY || !env.METRONOME_RATE_CARD_ID) missing.push('payments.configuration')
  if (organization.billing_status !== 'active' || !organization.billing_customer || !organization.customer || !organization.contract || organization.currency !== 'USD' || !organization.start || !Number.isFinite(Date.parse(organization.start)) || Date.parse(organization.start) > Date.now()) missing.push('payments.billing')
  if (organization.servicing) missing.push('payments.servicing')
  if (!connected?.stripeAccountId) missing.push('payments.account')
  else if (connected.status !== 'ready' || connected.cardPaymentsStatus !== 'active' || !connected.stripeRefreshedAt) missing.push('payments.account_ready')
  if (connected && livemode !== null && connected.livemode !== livemode) missing.push('payments.account_mode')
  return { connected, slug: organization.slug, missing, livemode }
}

export async function getStripeConnectedAccountByStripeId(
  db: DbClient,
  stripeAccountId: string,
): Promise<StripeConnectedAccount | null> {
  const row = await queryFirst<StripeConnectedAccountRow>(db, `
    SELECT id, organization_id, stripe_account_id, country, livemode, status,
           card_payments_status, surcharge_basis_points, requirements_json, stripe_refreshed_at,
           last_error, created_at, updated_at
    FROM stripe_connected_accounts
    WHERE stripe_account_id = ?
    LIMIT 1
  `, [stripeAccountId])
  return row ? mapConnectedAccount(row) : null
}

export async function reserveStripeConnectedAccount(
  db: DbClient,
  input: { organizationId: string; livemode: boolean },
): Promise<StripeConnectedAccount> {
  const now = new Date().toISOString()
  await execute(db, `
    INSERT OR IGNORE INTO stripe_connected_accounts
      (id, organization_id, livemode, status, requirements_json, created_at, updated_at)
    VALUES (?, ?, ?, 'creating', '[]', ?, ?)
  `, [crypto.randomUUID(), input.organizationId, input.livemode ? 1 : 0, now, now])
  const row = await getStripeConnectedAccount(db, input.organizationId)
  if (!row) throw new Error('Stripe Connect account reservation was not persisted')
  if (row.livemode !== input.livemode) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Stripe Connect account belongs to a different Stripe mode' })
  }
  return row
}

export async function markStripeConnectedAccountCreationFailed(
  db: DbClient,
  reservationId: string,
  message: string,
): Promise<void> {
  await execute(db, `
    UPDATE stripe_connected_accounts
    SET status = 'creation_failed', last_error = ?, updated_at = ?
    WHERE id = ? AND stripe_account_id IS NULL
  `, [message.slice(0, 1000), new Date().toISOString(), reservationId])
}

async function recordStripeConnectedAccountId(
  db: DbClient,
  reservation: StripeConnectedAccount,
  stripeAccountId: string,
): Promise<StripeConnectedAccount> {
  const updated = await execute(db, `
    UPDATE stripe_connected_accounts
    SET stripe_account_id = ?, status = 'pending_review', last_error = NULL, updated_at = ?
    WHERE id = ? AND organization_id = ?
      AND (stripe_account_id IS NULL OR stripe_account_id = ?)
  `, [stripeAccountId, new Date().toISOString(), reservation.id, reservation.organizationId, stripeAccountId])
  if (Number(updated.meta.changes) !== 1) throw new Error('Stripe Connect account ID did not match its reservation')
  const connected = await getStripeConnectedAccount(db, reservation.organizationId)
  if (!connected || connected.stripeAccountId !== stripeAccountId) {
    throw new Error('Stripe Connect account ID was not persisted')
  }
  return connected
}

export async function projectStripeConnectedAccount(
  db: DbClient,
  input: StripeConnectProjection,
): Promise<StripeConnectedAccount> {
  const status = input.financialContractSupported === false ? 'restricted' : deriveStripeConnectStatus(input)
  const updated = await execute(db, `
    UPDATE stripe_connected_accounts
    SET stripe_account_id = ?, country = ?, status = ?, card_payments_status = ?,
        requirements_json = ?, stripe_refreshed_at = ?, last_error = NULL,
        updated_at = ?
    WHERE id = ? AND organization_id = ? AND livemode = ?
      AND (stripe_account_id IS NULL OR stripe_account_id = ?)
  `, [
    input.stripeAccountId,
    input.country,
    status,
    input.cardPaymentsStatus,
    JSON.stringify(input.requirements),
    input.stripeRefreshedAt,
    new Date().toISOString(),
    input.reservationId,
    input.organizationId,
    input.livemode ? 1 : 0,
    input.stripeAccountId,
  ])
  if (Number(updated.meta.changes) !== 1) throw new Error('Stripe Connect account projection did not match its reservation')
  const row = await getStripeConnectedAccount(db, input.organizationId)
  if (!row) throw new Error('Projected Stripe Connect account is missing')
  return row
}

function normalizeAccountRequirements(account: Stripe.V2.Core.Account): StripeConnectRequirement[] {
  const entries = account.requirements?.entries
  if (!entries) return []
  return entries.map(requirement => ({
    awaitingActionFrom: requirement.awaiting_action_from,
    deadlineStatus: requirement.minimum_deadline.status,
    description: requirement.description,
    errors: requirement.errors.map(error => error.description),
  }))
}

function accountProjection(
  reservation: StripeConnectedAccount,
  account: Stripe.V2.Core.Account,
  refreshedAt = new Date().toISOString(),
): StripeConnectProjection {
  const country = account.identity?.country
  const cardPaymentsStatus = account.configuration?.merchant?.capabilities?.card_payments?.status
  return {
    reservationId: reservation.id,
    organizationId: reservation.organizationId,
    stripeAccountId: account.id,
    // Persist only the country Stripe reports for the created account.
    country: country ? country.toUpperCase() : null,
    livemode: account.livemode,
    cardPaymentsStatus: cardPaymentsStatus === undefined ? null : cardPaymentsStatus,
    financialContractSupported: account.dashboard==='express' && account.defaults?.responsibilities?.fees_collector==='application' && account.defaults.responsibilities.losses_collector==='stripe',
    requirements: normalizeAccountRequirements(account),
    stripeRefreshedAt: refreshedAt,
  }
}

const STRIPE_CONNECT_ACCOUNT_INCLUDE: Stripe.V2.Core.AccountRetrieveParams.Include[] = [
  'configuration.merchant',
  'defaults',
  'identity',
  'requirements',
]

/** The configured native Stripe account and methods must accept a paid booking before it is offered. */
export async function requireStripeCheckoutAcceptance(db: DbClient, env: CloudflareEnv, organizationId: string) {
  const setup = await readStripeCheckoutSetup(db, organizationId, env)
  const handoff = { code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(setup.slug)}/payments`, missing: setup.missing }
  // Native retrieval below can resolve a capability event not yet projected.
  if (setup.missing.some(field => field !== 'payments.account_ready')) throw new HTTPError({
    statusCode: setup.missing.includes('payments.configuration') ? 503 : setup.missing.includes('payments.entitlement') ? 403 : 409,
    statusMessage: 'Complete the business’s Payments setup before accepting online payments', data: handoff,
  })
  const billing = await paymentsBillingPricing(db, env, organizationId)
  if (!billing.contract || !billing.pricing) throw new HTTPError({ statusCode: 409, statusMessage: 'Complete Payments billing setup before accepting online payments', data: handoff })
  const saved = setup.connected!
  const keys = paymentsStripeKeys(env, setup.livemode!)!
  const stripe = createStripeClient(keys.secretKey, 'payments')
  const account = await stripe.v2.core.accounts.retrieve(saved.stripeAccountId!, { include: STRIPE_CONNECT_ACCOUNT_INCLUDE })
  const connected = await projectStripeConnectedAccount(db, accountProjection(saved, account))
  if (connected.status !== 'ready' || account.livemode !== saved.livemode) throw new HTTPError({ statusCode: 409, statusMessage: 'Complete the business’s Stripe account setup before requiring online collection', data: handoff })
  const configurations = await stripe.paymentMethodConfigurations.list({ limit: 100 }, { stripeAccount: account.id })
  if (configurations.has_more) throw new HTTPError({ statusCode: 409, statusMessage: 'Connected checkout configuration needs bounded operator review', data: handoff })
  const matching = configurations.data.filter(configuration => configuration.parent === keys.methodConfiguration || configuration.id === keys.methodConfiguration)
  if (matching.length !== 1 || !matching[0]!.active) throw new HTTPError({ statusCode: 409, statusMessage: 'One active connected payment configuration inheriting the Payments parent is required', data: handoff })
  const methods = matching[0]!
  for (const [name, value] of Object.entries(methods)) {
    if (value && typeof value === 'object' && 'available' in value && 'display_preference' in value && value.available
      && value.display_preference && typeof value.display_preference === 'object' && 'value' in value.display_preference
      && value.display_preference.value === 'on' && !['card', 'link', 'apple_pay', 'google_pay', 'us_bank_account'].includes(name)) {
      throw new HTTPError({ statusCode: 409, statusMessage: `Disable delayed or unsupported checkout method ${name} before accepting booked payments`, data: handoff })
    }
  }
  const [taxSettings, registrations] = await Promise.all([
    stripe.tax.settings.retrieve({}, { stripeAccount: account.id }),
    stripe.tax.registrations.list({ status: 'active', limit: 1 }, { stripeAccount: account.id }),
  ])
  return { connected: { ...connected, stripeAccountId: account.id }, methodConfigurationId: methods.id, automaticTax: taxSettings.status === 'active' && registrations.data.length > 0 }
}

export async function refreshStripeConnectedAccount(
  db: DbClient,
  stripe: Stripe,
  connected: StripeConnectedAccount,
  stripeContext?: Stripe.V2.Core.EventNotification['context'],
): Promise<StripeConnectedAccount> {
  if (!connected.stripeAccountId) throw new Error('Stripe Connect account has not been created')
  const account = await stripe.v2.core.accounts.retrieve(connected.stripeAccountId, {
    include: STRIPE_CONNECT_ACCOUNT_INCLUDE,
  }, stripeContext === undefined ? {} : { stripeContext })
  return await projectStripeConnectedAccount(db, accountProjection(connected, account))
}

export async function ensureStripeConnectedAccount(
  db: DbClient,
  stripe: Stripe,
  input: {
    organizationId: string
    organizationName: string
    contactEmail: string
    livemode: boolean
    country: string | null
  },
): Promise<StripeConnectedAccount> {
  if (!input.country && !(await getStripeConnectedAccount(db, input.organizationId))?.stripeAccountId) {
    throw new HTTPError({ statusCode: 400, statusMessage: 'Choose the country where your business is established before starting Stripe setup' })
  }
  const reservation = await reserveStripeConnectedAccount(db, input)
  if (reservation.stripeAccountId) return await refreshStripeConnectedAccount(db, stripe, reservation)

  let account: Stripe.V2.Core.Account
  try {
    account = await stripe.v2.core.accounts.create({
      contact_email: input.contactEmail,
      display_name: input.organizationName,
      dashboard: 'express',
      identity: { country: input.country! },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: {
        responsibilities: { fees_collector: 'application', losses_collector: 'stripe' },
      },
      metadata: { krabiclaw_organization_id: input.organizationId },
      include: STRIPE_CONNECT_ACCOUNT_INCLUDE,
    }, { idempotencyKey: `krabiclaw-connect-account:express-managed-risk:${input.organizationId}` })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Stripe account creation failed'
    await markStripeConnectedAccountCreationFailed(db, reservation.id, message)
    throw error
  }
  const connected = await recordStripeConnectedAccountId(db, reservation, account.id)
  return await projectStripeConnectedAccount(db, accountProjection(connected, account))
}

export async function createStripeConnectOnboardingLink(
  stripe: Stripe,
  input: { stripeAccountId: string; returnUrl: string; refreshUrl: string },
): Promise<string> {
  const link = await stripe.v2.core.accountLinks.create({
    account: input.stripeAccountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        collection_options: { fields: 'eventually_due', future_requirements: 'include' },
        return_url: input.returnUrl,
        refresh_url: input.refreshUrl,
      },
    },
  } as Stripe.V2.Core.AccountLinkCreateParams)
  // The pinned preview removes the stable SDK's configurations input; the
  // account's enabled configuration determines the hosted collection flow.
  const parsed = new URL(link.url)
  if (parsed.protocol !== 'https:' || !['https://connect.stripe.com', 'https://accounts.stripe.com'].includes(parsed.origin)) {
    throw new Error('Stripe returned an untrusted onboarding URL')
  }
  return parsed.toString()
}
