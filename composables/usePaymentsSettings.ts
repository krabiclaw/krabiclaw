import type { StripeConnectedAccount, StripeConnectStatus, StripeCapabilityStatus, StripeConnectRequirement } from '~/server/utils/stripe-connect'
import type { ConnectPayoutMethod } from '~/server/api/dashboard/connect/index.get'
import { isKnownBillingPlan, isNewSalePlan, type billingPlanActions } from '~/shared/billing-model'
import { isCurrencyCode } from '~/shared/currencies'
import type { PaymentMethodRow } from '~/server/utils/billing-customer'
import type { HomesQuote } from '~/server/utils/billing'

/**
 * What Payments and Plan and billing read: the plan, the services, the usage billing behind the
 * fees, the connected Stripe account and the saved cards. The index rows and
 * the leaves beside them read the same keys, so one `useAsyncData` record
 * serves both and a leaf's refresh updates the row it came from.
 */

export interface BillingStatus { can_update: boolean; actions: ReturnType<typeof billingPlanActions>; organization_id: string; plan: string; stripeCustomerId?: string; stripeSubscriptionId?: string; status?: string; periodEnd?: string; cancelAtPeriodEnd?: boolean; billingInterval?: 'month'; subscription_price?: { name: string; amount: number; currency: string; interval: 'month'; meters: string[]; trial: { end: string; missing_payment_method: 'cancel' | 'create_invoice' | 'pause' } | null }; usage: { homes: number }; scheduled_plan?: { plan: string; at: string } | null }
export const isBillingResponse = (value: unknown): value is { success: true; billing: BillingStatus } =>
  isRecord(value) && value.success === true && isRecord(value.billing) && typeof value.billing.organization_id === 'string' && isKnownBillingPlan(value.billing.plan)
  && typeof value.billing.can_update === 'boolean' && isRecord(value.billing.actions)
  && (value.billing.actions.label === null || typeof value.billing.actions.label === 'string') && typeof value.billing.actions.restore === 'boolean'
  && Array.isArray(value.billing.actions.changes) && value.billing.actions.changes.every(change => isRecord(change) && isNewSalePlan(change.plan) && (change.timing === 'immediate' || change.timing === 'period_end'))
  && isRecord(value.billing.usage) && Number.isSafeInteger(value.billing.usage.homes)
  && (value.billing.subscription_price === undefined || (isRecord(value.billing.subscription_price) && typeof value.billing.subscription_price.name === 'string' && Number.isSafeInteger(value.billing.subscription_price.amount) && isCurrencyCode(value.billing.subscription_price.currency) && value.billing.subscription_price.interval === 'month'
    && Array.isArray(value.billing.subscription_price.meters) && value.billing.subscription_price.meters.every(meter => typeof meter === 'string')
    && (value.billing.subscription_price.trial === null || (isRecord(value.billing.subscription_price.trial) && typeof value.billing.subscription_price.trial.end === 'string'
      && ['cancel', 'create_invoice', 'pause'].includes(String(value.billing.subscription_price.trial.missing_payment_method))))))
  && (value.billing.scheduled_plan === undefined || value.billing.scheduled_plan === null || (isRecord(value.billing.scheduled_plan) && isKnownBillingPlan(value.billing.scheduled_plan.plan) && typeof value.billing.scheduled_plan.at === 'string'))

export async function useOrganizationBilling() {
  const route = useRoute()
  const dashboardApi = useDashboardApi()
  const { data, error, refresh } = await useAsyncData(
    `dashboard-billing:${String(route.params.org_slug || '')}`,
    () => dashboardApi('/api/billing/status', { query: { include_price: 'true' }, validate: isBillingResponse }),
  )
  return { billing: computed(() => data.value?.billing ?? null), billingError: error, refreshBilling: refresh }
}

const isUpgradeQuote = (value: unknown): value is NonNullable<HomesQuote['upgrade']> => isRecord(value) && ['billable_homes', 'unit_amount_minor', 'amount_minor'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
const isHomesQuote = (value: unknown): value is HomesQuote =>
  isRecord(value) && isKnownBillingPlan(value.plan) && value.currency === 'USD'
  && (value.upgrade === null || isUpgradeQuote(value.upgrade))
  && isRecord(value.homes) && Number.isSafeInteger(value.homes.used) && Number.isSafeInteger(value.homes.drafts) && Number.isSafeInteger(value.homes.included) && Number.isSafeInteger(value.homes.additional_price_minor) && Number.isSafeInteger(value.homes.amount_minor)
  && (value.homes.limit === null || (Number.isSafeInteger(value.homes.limit) && Number(value.homes.limit) >= 0))
  && isRecord(value.adding) && Number.isSafeInteger(value.adding.count) && Number.isSafeInteger(value.adding.additional_homes) && Number.isSafeInteger(value.adding.amount_minor) && typeof value.adding.allowed === 'boolean'
  && isRecord(value.billing) && (value.billing.period_end === null || typeof value.billing.period_end === 'string') && (value.billing.trial_end === null || typeof value.billing.trial_end === 'string') && value.billing.prorated === false

/**
 * What making homes live costs on the plan, from the one quote the capacity
 * check also answers by: `adding` is how many are about to go live, 0 for the
 * cost of the live homes now. Read only while `enabled`.
 */
export function useHomesQuote(organizationId: string, adding: MaybeRefOrGetter<number>, enabled: MaybeRefOrGetter<boolean> = true) {
  const dashboardApi = useDashboardApi()
  const { data, error, status, refresh } = useAsyncData(
    () => `homes-quote:${organizationId}:${toValue(adding)}:${toValue(enabled)}`,
    () => dashboardApi(`/api/organizations/${encodeURIComponent(organizationId)}/billing/homes`, { query: { adding: String(toValue(adding)) }, validate: isHomesQuote }),
    { server: false, lazy: true, enabled },
  )
  const pending = computed(() => toValue(enabled) && (status.value === 'idle' || status.value === 'pending'))
  return { quote: data, quoteError: error, quotePending: pending, refreshQuote: refresh }
}

export type Strategy = { item_id: string; amount: number; currency: string; interval: string; since: string }
export type Services = { managed_ads: { id: string; agreed_at: string } | null; strategy: Strategy | null }
const isStrategy = (value: unknown): value is Strategy => isRecord(value) && typeof value.item_id === 'string' && Number.isSafeInteger(value.amount) && isCurrencyCode(value.currency) && typeof value.since === 'string'
type ServicesContract = { success: true; services: Services; requirements?: { strategy?: { paid_plan: boolean } } }
export const isServices = (value: unknown): value is ServicesContract => isRecord(value) && value.success === true && isRecord(value.services) && (value.services.managed_ads === null || (isRecord(value.services.managed_ads) && typeof value.services.managed_ads.agreed_at === 'string')) && (value.services.strategy === null || isStrategy(value.services.strategy))

export async function useOrganizationServices(requirements?: 'strategy') {
  const route = useRoute()
  const dashboardApi = useDashboardApi()
  const { data, error, refresh } = await useAsyncData(`dashboard-services:${String(route.params.org_slug)}:${requirements ?? 'state'}`, () => dashboardApi('/api/dashboard/services', { query: requirements ? { requirements } : undefined, validate: (value): value is ServicesContract => isServices(value) && (requirements === undefined || (isRecord(value) && isRecord(value.requirements) && isRecord(value.requirements.strategy) && typeof value.requirements.strategy.paid_plan === 'boolean')) }))
  // Unknown until read: a failed read shows its error and offers no service action.
  return { servicesResource: data, services: computed(() => data.value?.services), servicesError: error, refreshServices: refresh }
}

export type ConnectedAccount = StripeConnectedAccount
export type PayoutMethod = ConnectPayoutMethod

const CONNECT_STATUSES = new Set<StripeConnectStatus>(['creating', 'creation_failed', 'action_required', 'pending_review', 'restricted', 'ready'])
const CAPABILITY_STATUSES = new Set<StripeCapabilityStatus>(['active', 'pending', 'restricted', 'unsupported'])
const isRequirement = (value: unknown): value is StripeConnectRequirement => isRecord(value)
  && (value.awaiting_action_from === 'stripe' || value.awaiting_action_from === 'user')
  && (value.deadline_status === 'currently_due' || value.deadline_status === 'eventually_due' || value.deadline_status === 'past_due')
  && typeof value.description === 'string' && Array.isArray(value.errors) && value.errors.every(error => typeof error === 'string')
export const isConnectedAccount = (value: unknown): value is ConnectedAccount => isRecord(value)
  && typeof value.id === 'string' && typeof value.organization_id === 'string'
  && (value.stripe_account_id === null || typeof value.stripe_account_id === 'string')
  && (value.country === null || typeof value.country === 'string')
  && typeof value.livemode === 'boolean'
  && typeof value.status === 'string' && CONNECT_STATUSES.has(value.status as StripeConnectStatus)
  && (value.card_payments_status === null || (typeof value.card_payments_status === 'string' && CAPABILITY_STATUSES.has(value.card_payments_status as StripeCapabilityStatus)))
  && (value.surcharge_basis_points === null || Number.isSafeInteger(value.surcharge_basis_points))
  && Array.isArray(value.requirements) && value.requirements.every(isRequirement)
  && (value.stripe_refreshed_at === null || typeof value.stripe_refreshed_at === 'string')
  && (value.last_error === null || typeof value.last_error === 'string')
  && typeof value.created_at === 'string' && typeof value.updated_at === 'string'
const isPayoutMethod = (value: unknown): value is PayoutMethod | null => value === null || (isRecord(value) && (value.bank_name === null || typeof value.bank_name === 'string') && typeof value.last4 === 'string' && typeof value.currency === 'string' && isRecord(value.schedule) && typeof value.schedule.interval === 'string' && Number.isSafeInteger(value.schedule.delay_days))
export interface AccountResponse { success: true; account: ConnectedAccount | null; payout: PayoutMethod | null }
const isAccountResponse = (value: unknown): value is AccountResponse =>
  isRecord(value) && value.success === true && (value.account === null || isConnectedAccount(value.account)) && isPayoutMethod(value.payout)

export function useConnectAccount() {
  const route = useRoute()
  const dashboardApi = useDashboardApi()
  const { data, error, status, refresh } = useAsyncData(`dashboard-connect:${String(route.params.org_slug)}`, () => dashboardApi<AccountResponse>('/api/dashboard/connect', { validate: isAccountResponse }), { server: false, lazy: true })
  const pending = computed(() => status.value === 'idle' || status.value === 'pending')
  const account = computed(() => data.value?.account ?? null)
  const payout = computed(() => data.value?.payout ?? null)
  /** Keeps the payout row and replaces the account Stripe just reported. */
  const setAccount = (next: ConnectedAccount) => {
    if (!data.value) throw new Error('Load payment settings before updating the account.')
    data.value = { ...data.value, account: next }
  }
  return { connect: data, connectError: error, connectPending: pending, refreshConnect: refresh, account, payout, setAccount }
}

/** Stripe's status, in the words the payout rows use. */
export function connectStatusPresentation(status: StripeConnectStatus | undefined): { label: string; description: string } {
  switch (status) {
    case 'ready': return { label: 'Ready', description: 'Stripe has enabled card payments for this business.' }
    case 'action_required': return { label: 'Action required', description: 'Stripe needs more information from the business before card payments can be enabled.' }
    case 'restricted': return { label: 'Restricted', description: 'Stripe has restricted card payments. Open Stripe onboarding to review the required action.' }
    case 'pending_review': return { label: 'Pending review', description: 'Stripe is reviewing the submitted business information.' }
    case 'creation_failed': return { label: 'Setup failed', description: 'Stripe account setup did not finish. Retry to continue.' }
    case 'creating': return { label: 'Setup started', description: 'The Stripe account is being created.' }
    default: return { label: 'Not started', description: 'Stripe onboarding has not started.' }
  }
}

type Methods = { payment_methods: PaymentMethodRow[] }
const isMethods = (value: unknown): value is Methods => isRecord(value) && Array.isArray(value.payment_methods)
  && value.payment_methods.every(row => isRecord(row) && typeof row.id === 'string' && typeof row.brand === 'string' && typeof row.last4 === 'string' && Number.isSafeInteger(row.exp_month) && Number.isSafeInteger(row.exp_year) && typeof row.default === 'boolean')
const BRANDS: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', discover: 'Discover', jcb: 'JCB', unionpay: 'UnionPay', diners: 'Diners' }
export const cardBrandLabel = (brand: string) => BRANDS[brand] ?? brand

/** The business's own cards on the Stripe customer Better Auth keeps for it. */
export async function usePaymentMethods() {
  const route = useRoute()
  const dashboard = useDashboardOrganization()
  const { data, error, refresh } = await useAsyncData(
    `payment-methods:${String(route.params.org_slug)}`,
    () => {
      const organizationId = dashboard.organization.value?.id
      if (!organizationId) throw new Error('Organization context is unavailable')
      return applicationFetch<Methods>('/api/billing/payment-methods', { query: { organization_id: organizationId }, validate: isMethods })
    },
  )
  return { methods: data, methodsError: error, refreshMethods: refresh }
}
