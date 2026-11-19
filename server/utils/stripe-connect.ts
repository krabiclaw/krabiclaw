import { HTTPError } from 'nitro'
import type Stripe from 'stripe'
import { execute, queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { readCheckoutSeller } from '~/server/utils/billing-access'
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'
import { createStripeClient } from '~/server/utils/stripe-client'
import { planMeters } from '~/shared/billing-model'
import { isDemoOrganization } from '~/shared/demo'

export type StripeConnectStatus =
  | 'creating'
  | 'creation_failed'
  | 'action_required'
  | 'pending_review'
  | 'restricted'
  | 'ready'

export type StripeCapabilityStatus = 'active' | 'pending' | 'restricted' | 'unsupported'
export type StripeCapabilityResolution = 'contact_stripe' | 'no_resolution' | 'provide_info'

export interface StripeConnectRequirement {
  awaiting_action_from: 'stripe' | 'user'
  deadline_status: 'currently_due' | 'eventually_due' | 'past_due'
  description: string
  errors: string[]
}

export interface StripeConnectedAccount {
  id: string
  organization_id: string
  stripe_account_id: string | null
  /** The account's country as Stripe reports it; null before account creation. */
  country: string | null
  livemode: boolean
  status: StripeConnectStatus
  card_payments_status: StripeCapabilityStatus | null
  /** Pass on credit card fees: the surcharge rate in basis points, bounded by Stripe's maximum per card; null is off. */
  surcharge_basis_points: number | null
  requirements: StripeConnectRequirement[]
  stripe_refreshed_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export function validatedSurchargeBasisPoints(points: number | null): number | null {
  if (points !== null && (!Number.isSafeInteger(points) || points <= 0 || points > 10_000)) throw new Error('Surcharge rate is invalid')
  return points
}

interface StripeConnectedAccountRow {
  id: string
  organization_id: string
  stripe_account_id: string | null
  country: string | null
  livemode: number | boolean
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
  /** Stripe's resolution for each reason the card payments capability is not active. */
  cardPaymentsResolutions: StripeCapabilityResolution[]
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
      (requirement.awaiting_action_from !== 'stripe' && requirement.awaiting_action_from !== 'user')
      || (requirement.deadline_status !== 'currently_due' && requirement.deadline_status !== 'eventually_due' && requirement.deadline_status !== 'past_due')
      || typeof requirement.description !== 'string'
      || !Array.isArray(requirement.errors)
      || !requirement.errors.every(error => typeof error === 'string')
    ) throw new Error('Stored Stripe Connect requirement is invalid')
  }
  return parsed as StripeConnectRequirement[]
}

function mapConnectedAccount(row: StripeConnectedAccountRow): StripeConnectedAccount {
  const { livemode, requirements_json, ...account } = row
  return { ...account, livemode: Boolean(livemode), requirements: parseRequirements(requirements_json) }
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
  return createStripeClient(keys.secretKey, 'payments', env.DB)
}

function platformOriginUrl(platformOrigin: string, allowLocalHttp = false): URL {
  let origin: URL
  try {
    origin = new URL(platformOrigin)
  } catch {
    throw new Error('Stripe Connect platform origin is invalid')
  }
  const localHttp = allowLocalHttp && origin.protocol === 'http:' && origin.hostname === 'localhost'
  if (origin.protocol !== 'https:' && !localHttp) throw new Error('Stripe Connect platform origin must use HTTPS')
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Stripe Connect platform origin must be an origin without credentials, path, query, or fragment')
  }
  return origin
}

/** Where Stripe-hosted onboarding started in the iPhone app returns: a platform page that hands back to the app. */
export function buildAppPayoutsOnboardingUrls(platformOrigin: string): { returnUrl: string; refreshUrl: string } {
  const origin = platformOriginUrl(platformOrigin)
  const url = (outcome: 'done' | 'refresh') => {
    const target = new URL('/app/return/payouts', origin)
    target.searchParams.set('outcome', outcome)
    return target.toString()
  }
  return { returnUrl: url('done'), refreshUrl: url('refresh') }
}

export function buildStripeConnectOnboardingUrls(
  platformOrigin: string,
  organizationSlug: string,
  livemode: boolean,
): { returnUrl: string; refreshUrl: string } {
  // Stripe accepts localhost return and refresh URLs in test mode.
  const origin = platformOriginUrl(platformOrigin, !livemode)
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

/**
 * The account's state from Stripe's own reasons. A restricted capability whose
 * every reason Stripe resolves itself (`no_resolution`: verification pending,
 * status being determined) is under review, not waiting on the business; only
 * `provide_info` asks the business to act, and `contact_stripe` restricts it.
 */
export function deriveStripeConnectStatus(input: {
  cardPaymentsStatus: StripeCapabilityStatus | null
  cardPaymentsResolutions: StripeCapabilityResolution[]
  requirements: StripeConnectRequirement[]
}): Exclude<StripeConnectStatus, 'creating' | 'creation_failed'> {
  const userActionDue = input.requirements.some(requirement =>
    requirement.awaiting_action_from === 'user'
    && (requirement.deadline_status === 'currently_due' || requirement.deadline_status === 'past_due'))
  if (userActionDue || input.cardPaymentsResolutions.includes('provide_info')) return 'action_required'
  if (input.cardPaymentsStatus === 'active') return 'ready'
  if (input.cardPaymentsStatus === 'unsupported' || input.cardPaymentsResolutions.includes('contact_stripe')) return 'restricted'
  if (input.cardPaymentsStatus === 'restricted' && input.cardPaymentsResolutions.length === 0) return 'restricted'
  return 'pending_review'
}

const CONNECTED_ACCOUNT_COLUMNS = `id, organization_id, stripe_account_id, country, livemode, status,
  card_payments_status, surcharge_basis_points, requirements_json, stripe_refreshed_at,
  last_error, created_at, updated_at`

export function stripeConnectedAccountQuery(organizationId: string | { sql: string }) {
  const bound = typeof organizationId === 'string'
  return { query: `SELECT ${CONNECTED_ACCOUNT_COLUMNS} FROM stripe_connected_accounts
    WHERE organization_id = ${bound ? '?' : organizationId.sql} LIMIT 1`, params: bound ? [organizationId] : [] }
}

export function stripeConnectedAccountFromRow(row: unknown): StripeConnectedAccount | null {
  return row ? mapConnectedAccount(row as StripeConnectedAccountRow) : null
}

export async function getStripeConnectedAccount(
  db: DbClient,
  organizationId: string,
): Promise<StripeConnectedAccount | null> {
  const { query, params } = stripeConnectedAccountQuery(organizationId)
  return stripeConnectedAccountFromRow(await queryFirst(db, query, params))
}

/** The same account projection for the catalogue and checkout, maintained by Stripe Connect events. */
export async function readStripeCheckoutSetup(db: DbClient, organizationId: string, env: CloudflareEnv, prepared?: Awaited<ReturnType<typeof readCheckoutSeller>>) {
  const seller = prepared === undefined ? await readCheckoutSeller(db, organizationId) : prepared
  if (!seller) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  if (seller.organizationId !== organizationId) throw new Error('Checkout seller belongs to another organization')
  const { slug, subdomain, servicing, stripeCustomerId, account, plan, subscription } = seller
  const connected = account ? mapConnectedAccount(account as StripeConnectedAccountRow) : null
  const missing: string[] = []
  if (getPlanEntitlements(plan).payments !== true) missing.push('payments.entitlement')
  const livemode = env.STRIPE_SECRET_KEY ? organizationPaymentsLivemode(env, { subdomain }) : null
  const keys = livemode === null ? null : paymentsStripeKeys(env, livemode)
  if (!keys?.methodConfiguration || !keys.publishableKey || !env.NUXT_PUBLIC_PLATFORM_DOMAIN) missing.push('payments.configuration')
  if (servicing) missing.push('payments.servicing')
  if (!connected?.stripe_account_id) missing.push('payments.account')
  else if (connected.status !== 'ready' || connected.card_payments_status !== 'active' || !connected.stripe_refreshed_at) missing.push('payments.account_ready')
  if (connected && livemode !== null && connected.livemode !== livemode) missing.push('payments.account_mode')
  return { connected, slug, missing, livemode, subscription, plan, stripeCustomerId }
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

/** How long one start holds the account creation before another may take it over. */
const CONNECT_CREATION_CLAIM_MS = 60_000

/**
 * The business's one connected account, claimed for creation until Stripe has
 * made it. Stripe creates it once, under one idempotency key, so a second
 * start while the first is still creating it is refused rather than sent to
 * Stripe. A failed creation, or one unfinished after a minute, is claimed again.
 */
export async function reserveStripeConnectedAccount(
  db: DbClient,
  input: { organizationId: string; livemode: boolean },
): Promise<StripeConnectedAccount> {
  const now = new Date()
  const claim = await execute(db, `
    INSERT INTO stripe_connected_accounts
      (id, organization_id, livemode, status, requirements_json, created_at, updated_at)
    VALUES (?, ?, ?, 'creating', '[]', ?, ?)
    ON CONFLICT(organization_id) DO UPDATE SET status = 'creating', last_error = NULL, updated_at = excluded.updated_at
    WHERE stripe_account_id IS NULL AND livemode = excluded.livemode AND (status = 'creation_failed' OR updated_at < ?)
  `, [crypto.randomUUID(), input.organizationId, input.livemode ? 1 : 0, now.toISOString(), now.toISOString(), new Date(now.getTime() - CONNECT_CREATION_CLAIM_MS).toISOString()])
  const row = await getStripeConnectedAccount(db, input.organizationId)
  if (!row) throw new Error('Stripe Connect account reservation was not persisted')
  if (row.livemode !== input.livemode) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Stripe Connect account belongs to a different Stripe mode' })
  }
  if (!row.stripe_account_id && Number(claim.meta.changes) !== 1) {
    throw new HTTPError({ statusCode: 409, statusMessage: 'Payout setup is already starting for this business. Finish it in the window where it opened, or try again in a minute.', data: { code: 'CONNECT_SETUP_IN_PROGRESS' } })
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
  `, [stripeAccountId, new Date().toISOString(), reservation.id, reservation.organization_id, stripeAccountId])
  if (Number(updated.meta.changes) !== 1) throw new Error('Stripe Connect account ID did not match its reservation')
  const connected = await getStripeConnectedAccount(db, reservation.organization_id)
  if (!connected || connected.stripe_account_id !== stripeAccountId) {
    throw new Error('Stripe Connect account ID was not persisted')
  }
  return connected
}

export async function projectStripeConnectedAccount(
  db: DbClient,
  input: StripeConnectProjection,
): Promise<StripeConnectedAccount> {
  const status = input.financialContractSupported === false ? 'restricted' : deriveStripeConnectStatus(input)
  const updated = await queryFirst<StripeConnectedAccountRow>(db, `
    UPDATE stripe_connected_accounts
    SET stripe_account_id = ?, country = ?, status = ?, card_payments_status = ?,
        requirements_json = ?, stripe_refreshed_at = ?, last_error = NULL,
        updated_at = ?
    WHERE id = ? AND organization_id = ? AND livemode = ?
      AND (stripe_account_id IS NULL OR stripe_account_id = ?)
    RETURNING ${CONNECTED_ACCOUNT_COLUMNS}
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
  if (!updated) throw new Error('Stripe Connect account projection did not match its reservation')
  return mapConnectedAccount(updated)
}

function normalizeAccountRequirements(account: Stripe.V2.Core.Account): StripeConnectRequirement[] {
  const entries = account.requirements?.entries
  if (!entries) return []
  return entries.map(requirement => ({
    awaiting_action_from: requirement.awaiting_action_from,
    deadline_status: requirement.minimum_deadline.status,
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
  const cardPayments = account.configuration?.merchant?.capabilities?.card_payments
  const cardPaymentsStatus = cardPayments?.status
  return {
    reservationId: reservation.id,
    organizationId: reservation.organization_id,
    stripeAccountId: account.id,
    // Persist only the country Stripe reports for the created account.
    country: country ? country.toUpperCase() : null,
    livemode: account.livemode,
    cardPaymentsStatus: cardPaymentsStatus === undefined ? null : cardPaymentsStatus,
    cardPaymentsResolutions: (cardPayments?.status_details ?? []).map(detail => detail.resolution),
    financialContractSupported: !account.closed && account.dashboard==='express' && account.defaults?.responsibilities?.fees_collector==='application' && account.defaults.responsibilities.losses_collector==='stripe',
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

// "Your business location: Supported" in https://docs.stripe.com/tax/supported-countries
const STRIPE_TAX_BUSINESS_COUNTRIES: ReadonlySet<string> = new Set([
  'AE', 'AT', 'AU', 'BE', 'BG', 'CA', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HK', 'HR', 'HU', 'IE',
  'IT', 'JP', 'LI', 'LT', 'LU', 'LV', 'MT', 'MX', 'NL', 'NO', 'NZ', 'PL', 'PR', 'PT', 'RO', 'SE', 'SG', 'SI', 'SK', 'US',
])

/** The business's one active Stripe payment method configuration, inheriting the platform's Payments parent. */
// Stripe's own failures propagate; only a configuration the business must fix is returned as a problem.
async function connectedMethodConfiguration(stripe: Stripe, stripeAccountId: string, parent: string): Promise<{ configuration: Stripe.PaymentMethodConfiguration } | { problem: string }> {
  const configurations = await stripe.paymentMethodConfigurations.list({ limit: 100 }, { stripeAccount: stripeAccountId })
  if (configurations.has_more) return { problem: 'Connected checkout configuration needs bounded operator review' }
  const matching = configurations.data.filter(configuration => configuration.parent === parent || configuration.id === parent)
  if (matching.length !== 1 || !matching[0]!.active) return { problem: 'One active connected payment configuration inheriting the Payments parent is required' }
  return { configuration: matching[0]! }
}

/**
 * Whether a business takes payment online now, and if not, why, for whoever
 * asks: checkout refuses with the reason, the footer shows no methods.
 */
async function checkoutReadiness(db: DbClient, env: CloudflareEnv, organizationId: string, seller?: Awaited<ReturnType<typeof readCheckoutSeller>>) {
  const setup = await readStripeCheckoutSetup(db, organizationId, env, seller)
  const handoff = { code: 'financial_action_required', dashboard_url: `/dashboard/${encodeURIComponent(setup.slug)}/payments`, missing: setup.missing }
  if (setup.missing.length) {
    return { ready: false as const, statusCode: setup.missing.includes('payments.configuration') ? 503 : setup.missing.includes('payments.entitlement') ? 403 : 409, statusMessage: 'Complete the business’s Payments setup before accepting online payments', handoff }
  }
  // Payments fees are billed only in the platform's mode, on the business's
  // subscription; a demo's test-mode payments carry none.
  if (setup.livemode === platformLivemode(env)) {
    const { subscription, plan, stripeCustomerId } = setup
    if (subscription?.stripeCustomerId && subscription.stripeCustomerId !== stripeCustomerId) throw new Error('Subscription customer does not match its organization')
    const meters = planMeters(plan)
    if (!subscription?.stripeSubscriptionId || !meters.includes('captured_volume') || !meters.includes('stripe_cost')) {
      return { ready: false as const, statusCode: 409, statusMessage: 'Your plan subscription does not bill Payments fees yet.', handoff: { ...handoff, missing: [...handoff.missing, 'payments.billing'] } }
    }
  }
  const { connected, livemode } = setup
  const keys = livemode === null ? null : paymentsStripeKeys(env, livemode)
  if (!connected?.stripe_account_id || !keys?.methodConfiguration) throw new Error('Ready checkout is missing its Stripe account or payment method configuration')
  return { ready: true as const, stripe: createStripeClient(keys.secretKey, 'payments', env.DB), connected: { ...connected, stripe_account_id: connected.stripe_account_id }, parent: keys.methodConfiguration, handoff }
}

/**
 * The ways a business takes payment on its site, as its Stripe configuration
 * turns them on: what its footer shows, as a shop's footer shows its cards and
 * wallets. A business not ready to take payment online takes none here.
 */
export async function acceptedPaymentMethods(db: DbClient, env: CloudflareEnv, organizationId: string): Promise<{ types: string[]; country: string | null }> {
  const readiness = await checkoutReadiness(db, env, organizationId)
  if (!readiness.ready) return { types: [], country: null }
  const methods = await connectedMethodConfiguration(readiness.stripe, readiness.connected.stripe_account_id, readiness.parent)
  // A configuration the business must still fix takes no payment, as checkout refuses it.
  if ('problem' in methods) return { types: [], country: null }
  const types = Object.entries(methods.configuration as unknown as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'object' && value !== null && (value as { available?: unknown }).available === true
      && (value as { display_preference?: { value?: unknown } }).display_preference?.value === 'on')
    .map(([type]) => type)
  return { types, country: readiness.connected.country }
}

/** The configured native Stripe account and methods must accept a paid booking before it is offered. */
export async function requireStripeCheckoutAcceptance(db: DbClient, env: CloudflareEnv, organizationId: string, seller?: Awaited<ReturnType<typeof readCheckoutSeller>>) {
  const readiness = await checkoutReadiness(db, env, organizationId, seller)
  if (!readiness.ready) throw new HTTPError({ statusCode: readiness.statusCode, statusMessage: readiness.statusMessage, data: readiness.handoff })
  const { stripe, connected, handoff } = readiness
  const stripeAccount = connected.stripe_account_id
  // Which methods the business offers is its Stripe payment method configuration's to decide.
  const methods = await connectedMethodConfiguration(stripe, stripeAccount, readiness.parent)
  if ('problem' in methods) throw new HTTPError({ statusCode: 409, statusMessage: methods.problem, data: handoff })
  // Stripe Tax rejects sellers outside its business locations. For supported
  // sellers, only an active registration enables it; provider failures surface.
  let automaticTax = false
  if (connected.country && STRIPE_TAX_BUSINESS_COUNTRIES.has(connected.country)) {
    const [taxSettings, registrations] = await Promise.all([
      stripe.tax.settings.retrieve({}, { stripeAccount }),
      stripe.tax.registrations.list({ status: 'active', limit: 1 }, { stripeAccount }),
    ])
    automaticTax = taxSettings.status === 'active' && registrations.data.length > 0
  }
  return { connected, stripe, methodConfigurationId: methods.configuration.id, automaticTax, surchargeBasisPoints: validatedSurchargeBasisPoints(connected.surcharge_basis_points) }
}

export async function refreshStripeConnectedAccount(
  db: DbClient,
  stripe: Stripe,
  connected: StripeConnectedAccount,
  stripeContext?: Stripe.V2.Core.EventNotification['context'],
): Promise<StripeConnectedAccount> {
  if (!connected.stripe_account_id) throw new Error('Stripe Connect account has not been created')
  const account = await stripe.v2.core.accounts.retrieve(connected.stripe_account_id, {
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
  const reservation = await reserveStripeConnectedAccount(db, input)
  if (reservation.stripe_account_id) return await refreshStripeConnectedAccount(db, stripe, reservation)

  let account: Stripe.V2.Core.Account
  try {
    account = await stripe.v2.core.accounts.create({
      contact_email: input.contactEmail,
      display_name: input.organizationName,
      dashboard: 'express',
      // Stripe requires the country for a merchant account and says so when it is missing or unsupported.
      ...(input.country ? { identity: { country: input.country } } : {}),
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

/**
 * Stripe-hosted onboarding for the organization's connected account: the
 * account is created on first use, and the link returns to `urls`. Stripe's own
 * refusal is what the owner sees.
 */
export async function startStripeConnectOnboarding(
  db: DbClient,
  env: CloudflareEnv,
  input: { organization: { id: string; name: string; subdomain?: string | null }; contactEmail: string; country: string | null; urls: { returnUrl: string; refreshUrl: string } },
): Promise<{ account: StripeConnectedAccount; url: string }> {
  const livemode = organizationPaymentsLivemode(env, input.organization)
  const stripe = paymentsStripe(env, livemode)
  try {
    const account = await ensureStripeConnectedAccount(db, stripe, {
      organizationId: input.organization.id,
      organizationName: input.organization.name,
      contactEmail: input.contactEmail,
      livemode,
      country: input.country,
    })
    if (!account.stripe_account_id) throw new Error('Stripe connected account ID is missing after creation')
    const url = await createStripeConnectOnboardingLink(stripe, { stripeAccountId: account.stripe_account_id, ...input.urls })
    return { account, url }
  } catch (error) {
    if (error instanceof HTTPError) throw error
    if (error instanceof stripe.errors.StripeError) throw new HTTPError({ statusCode: 502, statusMessage: error.message, data: { code: 'STRIPE_ONBOARDING_FAILED' }, cause: error })
    throw error
  }
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
