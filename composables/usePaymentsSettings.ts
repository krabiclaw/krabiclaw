import { isKnownBillingPlan } from '~/shared/billing-model'
import { isLocationCount } from '~/composables/useOrganizationSubscription'
import { isCurrencyCode } from '~/shared/currencies'
import type { PaymentMethodRow } from '~/server/utils/billing-customer'

/**
 * What Payments reads: the plan, the services, the usage billing behind the
 * fees, the connected Stripe account and the saved cards. The index rows and
 * the leaves beside them read the same keys, so one `useAsyncData` record
 * serves both and a leaf's refresh updates the row it came from.
 */

export interface BillingStatus { organizationId: string; plan: string; stripeCustomerId?: string; stripeSubscriptionId?: string; subscriptionStatus?: string; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean; billingInterval?: 'month' | 'year'; subscriptionPrice?: { name: string; amount: number; currency: string; interval: 'month' | 'year' }; locations: { used: number; covered: number }; scheduledPlan?: { plan: string; at: string } | null }
const isBillingResponse = (value: unknown): value is { success: true; billing: BillingStatus } =>
  isRecord(value) && value.success === true && isRecord(value.billing) && typeof value.billing.organizationId === 'string' && isKnownBillingPlan(value.billing.plan)
  && isLocationCount(value.billing.locations)
  && (value.billing.subscriptionPrice === undefined || (isRecord(value.billing.subscriptionPrice) && typeof value.billing.subscriptionPrice.name === 'string' && Number.isSafeInteger(value.billing.subscriptionPrice.amount) && isCurrencyCode(value.billing.subscriptionPrice.currency) && ['month', 'year'].includes(String(value.billing.subscriptionPrice.interval))))
  && (value.billing.scheduledPlan === undefined || value.billing.scheduledPlan === null || (isRecord(value.billing.scheduledPlan) && isKnownBillingPlan(value.billing.scheduledPlan.plan) && typeof value.billing.scheduledPlan.at === 'string'))

export async function useOrganizationBilling() {
  const route = useRoute()
  const dashboardApi = useDashboardApi()
  const { data, error, refresh } = await useAsyncData(
    `dashboard-billing:${String(route.params.orgSlug || '')}`,
    () => dashboardApi('/api/billing/status', { query: { includePrice: 'true' }, validate: isBillingResponse }),
  )
  return { billing: computed(() => data.value?.billing ?? null), billingError: error, refreshBilling: refresh }
}

export type Strategy = { item_id: string; amount: number; currency: string; interval: string; since: string }
export type Services = { managed_ads: { id: string; agreed_at: string } | null; strategy: Strategy | null }
const isStrategy = (value: unknown): value is Strategy => isRecord(value) && typeof value.item_id === 'string' && Number.isSafeInteger(value.amount) && isCurrencyCode(value.currency) && typeof value.since === 'string'
export const isServices = (value: unknown): value is { success: true; services: Services } => isRecord(value) && value.success === true && isRecord(value.services) && (value.services.managed_ads === null || (isRecord(value.services.managed_ads) && typeof value.services.managed_ads.agreed_at === 'string')) && (value.services.strategy === null || isStrategy(value.services.strategy))

export async function useOrganizationServices() {
  const route = useRoute()
  const dashboardApi = useDashboardApi()
  const { data, error, refresh } = await useAsyncData(`dashboard-services:${String(route.params.orgSlug)}`, () => dashboardApi('/api/dashboard/services', { validate: isServices }))
  // Unknown until read: a failed read shows its error and offers no service action.
  return { servicesResource: data, services: computed(() => data.value?.services), servicesError: error, refreshServices: refresh }
}

export type Pricing = { captured_volume_rate_percent: string; ad_spend_rate_percent: string | null; livemode: boolean }
export type Credit = { id: string; source_id: string; currency: string; amount: number }
export type UsageBilling = { configured: boolean; account?: { status: string }; pricing: Pricing | null; credits: Credit[] }
const isUsageBilling = (value: unknown): value is UsageBilling => isRecord(value) && typeof value.configured === 'boolean'
  && (value.pricing === null || (isRecord(value.pricing) && (value.pricing.ad_spend_rate_percent === null || typeof value.pricing.ad_spend_rate_percent === 'string') && typeof value.pricing.captured_volume_rate_percent === 'string' && typeof value.pricing.livemode === 'boolean'))
  && (!value.configured || (isRecord(value.account) && typeof value.account.status === 'string'))
  && Array.isArray(value.credits) && value.credits.every(row => isRecord(row) && typeof row.id === 'string' && typeof row.source_id === 'string' && isCurrencyCode(row.currency) && Number.isSafeInteger(row.amount))

export async function usePaymentsUsage() {
  const route = useRoute()
  const dashboardApi = useDashboardApi()
  // Lazy on purpose: this reads Metronome's invoices and each one's Stripe collection
  // invoice, and the plan rows do not wait on that provider round trip.
  const { data, error, refresh } = await useAsyncData(`payments-billing:${String(route.params.orgSlug)}`, () => dashboardApi<UsageBilling>('/api/dashboard/payments/billing', { validate: isUsageBilling }), { lazy: true })
  return { usage: data, usageError: error, refreshUsage: refresh }
}

export type ConnectStatus = 'creating' | 'creation_failed' | 'action_required' | 'pending_review' | 'restricted' | 'ready'
type CapabilityStatus = 'active' | 'pending' | 'restricted' | 'unsupported'
export interface ConnectRequirement { awaitingActionFrom: 'stripe' | 'user'; deadlineStatus: 'currently_due' | 'eventually_due' | 'past_due'; description: string; errors: string[] }
export interface PayoutMethod { bankName: string | null; last4: string; currency: string; schedule: { interval: string; delayDays: number } }
export interface ConnectedAccount {
  id: string
  organizationId: string
  stripeAccountId: string | null
  country: string | null
  livemode: boolean
  status: ConnectStatus
  cardPaymentsStatus: CapabilityStatus | null
  surchargeBasisPoints: number | null
  requirements: ConnectRequirement[]
  stripeRefreshedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}
const CONNECT_STATUSES = new Set<ConnectStatus>(['creating', 'creation_failed', 'action_required', 'pending_review', 'restricted', 'ready'])
const CAPABILITY_STATUSES = new Set<CapabilityStatus>(['active', 'pending', 'restricted', 'unsupported'])
const isRequirement = (value: unknown): value is ConnectRequirement => isRecord(value)
  && (value.awaitingActionFrom === 'stripe' || value.awaitingActionFrom === 'user')
  && (value.deadlineStatus === 'currently_due' || value.deadlineStatus === 'eventually_due' || value.deadlineStatus === 'past_due')
  && typeof value.description === 'string' && Array.isArray(value.errors) && value.errors.every(error => typeof error === 'string')
export const isConnectedAccount = (value: unknown): value is ConnectedAccount => isRecord(value)
  && typeof value.id === 'string' && typeof value.organizationId === 'string'
  && (value.stripeAccountId === null || typeof value.stripeAccountId === 'string')
  && (value.country === null || typeof value.country === 'string')
  && typeof value.livemode === 'boolean'
  && typeof value.status === 'string' && CONNECT_STATUSES.has(value.status as ConnectStatus)
  && (value.cardPaymentsStatus === null || (typeof value.cardPaymentsStatus === 'string' && CAPABILITY_STATUSES.has(value.cardPaymentsStatus as CapabilityStatus)))
  && (value.surchargeBasisPoints === null || Number.isSafeInteger(value.surchargeBasisPoints))
  && Array.isArray(value.requirements) && value.requirements.every(isRequirement)
  && (value.stripeRefreshedAt === null || typeof value.stripeRefreshedAt === 'string')
  && (value.lastError === null || typeof value.lastError === 'string')
  && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
const isPayoutMethod = (value: unknown): value is PayoutMethod | null => value === null || (isRecord(value) && (value.bankName === null || typeof value.bankName === 'string') && typeof value.last4 === 'string' && typeof value.currency === 'string' && isRecord(value.schedule) && typeof value.schedule.interval === 'string' && Number.isSafeInteger(value.schedule.delayDays))
export interface AccountResponse { success: true; account: ConnectedAccount | null; payout: PayoutMethod | null; countries: string[] }
const isAccountResponse = (value: unknown): value is AccountResponse =>
  isRecord(value) && value.success === true && (value.account === null || isConnectedAccount(value.account)) && isPayoutMethod(value.payout) && Array.isArray(value.countries) && value.countries.every(country => typeof country === 'string')

export async function useConnectAccount() {
  const route = useRoute()
  const dashboardApi = useDashboardApi()
  const { data, error } = await useAsyncData(`dashboard-connect:${String(route.params.orgSlug)}`, () => dashboardApi<AccountResponse>('/api/dashboard/connect', { validate: isAccountResponse }))
  const account = computed(() => data.value?.account ?? null)
  const payout = computed(() => data.value?.payout ?? null)
  /** Keeps the payout row and replaces the account Stripe just reported. */
  const setAccount = (next: ConnectedAccount) => { data.value = { success: true, account: next, payout: payout.value, countries: data.value?.countries ?? [] } }
  return { connect: data, connectError: error, account, payout, setAccount }
}

/** Stripe's status, in the words the payout rows use. */
export function connectStatusPresentation(status: ConnectStatus | undefined): { label: string; description: string } {
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
    `payment-methods:${String(route.params.orgSlug)}`,
    () => {
      const organizationId = dashboard.organization.value?.id
      if (!organizationId) throw new Error('Organization context is unavailable')
      return applicationFetch<Methods>('/api/billing/payment-methods', { query: { organizationId }, validate: isMethods })
    },
  )
  return { methods: data, methodsError: error, refreshMethods: refresh }
}
