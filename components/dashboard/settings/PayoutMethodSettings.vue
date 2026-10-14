<template>
  <!-- Airbnb's Payouts tab: How you get paid, the bank rows with Edit, Add payout method, and a Need help card. -->
  <div class="space-y-8">
    <UAlert
      v-if="failure"
      color="error"
      variant="soft"
      icon="i-lucide-triangle-alert"
      title="Stripe Connect is unavailable"
      :description="failure"
    />

    <section>
      <h2 class="text-2xl font-semibold text-highlighted">How you get paid</h2>
      <p class="mt-2 text-base text-muted">Your money goes to the bank account on file with Stripe. To change it, use Edit next to the account.</p>

      <UFormField v-if="needsCountry && !connectError" class="mt-6" label="Business country" description="Where your business is legally established.">
        <USelectMenu v-model="country" :items="countries" value-key="value" class="w-full sm:w-80" placeholder="Choose a country" />
      </UFormField>

      <UButton v-if="!account && !connectError" class="mt-6" size="xl" :loading="starting" :disabled="needsCountry && !country" label="Add payout method" @click="startOnboarding" />

      <template v-else-if="account">
        <div v-if="payout" class="mt-6 flex items-center gap-4 py-4">
          <UIcon name="i-lucide-landmark" class="size-8 shrink-0 text-highlighted" />
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2 text-base font-medium text-highlighted">Bank account <UBadge color="neutral" variant="subtle" size="sm" label="DEFAULT" /></p>
            <p class="mt-0.5 text-sm text-muted">{{ payout.bankName ?? 'Bank account' }}, ••••{{ payout.last4 }} ({{ payout.currency }})</p>
          </div>
          <UButton label="Edit" color="neutral" variant="outline" :loading="openingDashboard" @click="openDashboard" />
        </div>

        <UAlert
          v-if="account.requirements.length"
          class="mt-6"
          color="warning"
          variant="soft"
          icon="i-lucide-list-checks"
          title="Stripe needs more information"
          :description="statusPresentation.description"
        />
        <p v-else-if="account.status !== 'ready'" class="mt-6 text-base text-muted">{{ statusPresentation.description }}</p>

        <UButton
          v-if="canContinueOnboarding"
          class="mt-6"
          size="xl"
          :loading="starting"
          :disabled="needsCountry && !country"
          :label="account.status === 'creation_failed' ? 'Retry Stripe setup' : 'Continue Stripe setup'"
          @click="startOnboarding"
        />
        <UButton v-else-if="!payout" class="mt-6" size="xl" label="Add payout method" :loading="openingDashboard" @click="openDashboard" />
      </template>
    </section>

    <p v-if="payout" class="text-sm text-muted">{{ scheduleLabel }}.</p>

    <!-- Stripe's surcharge: the business names a rate, Stripe bounds it per card and never applies it to debit or prepaid. -->
    <section v-if="account?.status === 'ready'" data-testid="card-surcharge">
      <h2 class="text-2xl font-semibold text-highlighted">Card surcharge</h2>
      <p class="mt-2 text-base text-muted">Pass credit card fees on to the buyer. The surcharge is shown before they pay and included in the total. Stripe caps it for each card and never adds one to debit or prepaid cards.</p>
      <div class="mt-6 flex flex-wrap items-end gap-4">
        <UFormField label="Surcharge rate" description="Percent of the amount, up to Stripe’s cap for the card.">
          <UInput v-model="surchargePercent" type="number" inputmode="decimal" min="0" max="100" step="0.01" :disabled="savingSurcharge" class="w-32" :ui="{ trailing: 'pe-2' }">
            <template #trailing><span class="text-sm text-muted">%</span></template>
          </UInput>
        </UFormField>
        <UButton :label="account.surchargeBasisPoints === null ? 'Turn on surcharge' : 'Save rate'" :loading="savingSurcharge" :disabled="!surchargeDirty" @click="saveSurcharge(parsedSurcharge)" />
        <UButton v-if="account.surchargeBasisPoints !== null" label="Turn off" color="neutral" variant="outline" :loading="savingSurcharge" @click="saveSurcharge(null)" />
      </div>
      <p v-if="account.surchargeBasisPoints !== null" class="mt-3 text-sm text-muted">Surcharging is on at {{ account.surchargeBasisPoints / 100 }}%.</p>
    </section>
    <PaymentsHelp />
  </div>
</template>

<script setup lang="ts">
import PaymentsHelp from '~/components/dashboard/PaymentsHelp.vue'

type ConnectStatus = 'creating' | 'creation_failed' | 'action_required' | 'pending_review' | 'restricted' | 'ready'
type CapabilityStatus = 'active' | 'pending' | 'restricted' | 'unsupported'

interface ConnectRequirement {
  awaitingActionFrom: 'stripe' | 'user'
  deadlineStatus: 'currently_due' | 'eventually_due' | 'past_due'
  description: string
  errors: string[]
}

interface PayoutMethod { bankName: string | null; last4: string; currency: string; schedule: { interval: string; delayDays: number } }
interface ConnectedAccount {
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

function isRequirement(value: unknown): value is ConnectRequirement {
  return isRecord(value)
    && (value.awaitingActionFrom === 'stripe' || value.awaitingActionFrom === 'user')
    && (value.deadlineStatus === 'currently_due' || value.deadlineStatus === 'eventually_due' || value.deadlineStatus === 'past_due')
    && typeof value.description === 'string'
    && Array.isArray(value.errors)
    && value.errors.every(error => typeof error === 'string')
}

function isConnectedAccount(value: unknown): value is ConnectedAccount {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.organizationId === 'string'
    && (value.stripeAccountId === null || typeof value.stripeAccountId === 'string')
    && (value.country === null || typeof value.country === 'string')
    && typeof value.livemode === 'boolean'
    && typeof value.status === 'string'
    && CONNECT_STATUSES.has(value.status as ConnectStatus)
    && (value.cardPaymentsStatus === null || (typeof value.cardPaymentsStatus === 'string' && CAPABILITY_STATUSES.has(value.cardPaymentsStatus as CapabilityStatus)))
    && (value.surchargeBasisPoints === null || Number.isSafeInteger(value.surchargeBasisPoints))
    && Array.isArray(value.requirements)
    && value.requirements.every(isRequirement)
    && (value.stripeRefreshedAt === null || typeof value.stripeRefreshedAt === 'string')
    && (value.lastError === null || typeof value.lastError === 'string')
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
}

const isPayoutMethod = (value: unknown): value is PayoutMethod | null => value === null || (isRecord(value) && (value.bankName === null || typeof value.bankName === 'string') && typeof value.last4 === 'string' && typeof value.currency === 'string' && isRecord(value.schedule) && typeof value.schedule.interval === 'string' && Number.isSafeInteger(value.schedule.delayDays))
interface AccountResponse { success: true; account: ConnectedAccount | null; payout: PayoutMethod | null; countries: string[] }
const isAccountResponse = (value: unknown): value is AccountResponse =>
  isRecord(value) && value.success === true && (value.account === null || isConnectedAccount(value.account)) && isPayoutMethod(value.payout) && Array.isArray(value.countries) && value.countries.every(country => typeof country === 'string')
const isOnboardingResponse = (value: unknown): value is { success: true; account: ConnectedAccount; onboardingUrl: string } =>
  isRecord(value) && value.success === true && isConnectedAccount(value.account) && typeof value.onboardingUrl === 'string'

const dashboardApi = useDashboardApi()
const route = useRoute()
const router = useRouter()
const { data: connect, error: connectError } = await useAsyncData(
  `dashboard-connect:${String(route.params.orgSlug)}`,
  () => dashboardApi<AccountResponse>('/api/dashboard/connect', { validate: isAccountResponse }),
)
const account = computed(() => connect.value?.account ?? null)
const payout = computed(() => connect.value?.payout ?? null)
const country = ref<string>()
const needsCountry = computed(() => !account.value?.stripeAccountId)
const countries = computed(() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' })
  return (connect.value?.countries ?? []).map(value => ({ value, label: names.of(value) ?? value })).sort((a, b) => a.label.localeCompare(b.label))
})
/** Keeps the payout row and replaces the account Stripe just reported. */
function setAccount(next: ConnectedAccount) {
  connect.value = { success: true, account: next, payout: payout.value, countries: connect.value?.countries ?? [] }
}
const scheduleLabel = computed(() => {
  const schedule = payout.value?.schedule
  if (!schedule) return ''
  return schedule.interval === 'daily' ? 'Available funds sent daily' : schedule.interval === 'weekly' ? 'Available funds sent weekly' : schedule.interval === 'monthly' ? 'Available funds sent monthly' : 'Available funds sent when you ask'
})
const starting = ref(false)
const openingDashboard = ref(false)
const errorMessage = ref<string | null>(null)
const failure = computed(() => (connectError.value ? getErrorMessage(connectError.value, 'Stripe Connect status could not be loaded') : errorMessage.value))

const canContinueOnboarding = computed(() => account.value !== null && account.value.status !== 'ready')
const statusPresentation = computed<{ label: string; description: string; color: 'success' | 'warning' | 'error' | 'neutral' }>(() => {
  switch (account.value?.status) {
    case 'ready': return { label: 'Ready', description: 'Stripe has enabled card payments for this business.', color: 'success' }
    case 'action_required': return { label: 'Action required', description: 'Stripe needs more information from the business before card payments can be enabled.', color: 'warning' }
    case 'restricted': return { label: 'Restricted', description: 'Stripe has restricted card payments. Open Stripe onboarding to review the required action.', color: 'error' }
    case 'pending_review': return { label: 'Pending review', description: 'Stripe is reviewing the submitted business information.', color: 'neutral' }
    case 'creation_failed': return { label: 'Setup failed', description: 'Stripe account setup did not finish. Retry to continue.', color: 'error' }
    case 'creating': return { label: 'Setup started', description: 'The Stripe account is being created.', color: 'neutral' }
    default: return { label: 'Not started', description: 'Stripe onboarding has not started.', color: 'neutral' }
  }
})

/** The rate as a percent in the field; basis points are what the account stores. */
const surchargePercent = ref('')
watch(account, (value) => { surchargePercent.value = value?.surchargeBasisPoints === null || value === null ? '3' : String(value.surchargeBasisPoints / 100) }, { immediate: true })
const parsedSurcharge = computed(() => {
  const points = Math.round(Number(surchargePercent.value) * 100)
  return Number.isSafeInteger(points) && points >= 1 && points <= 10_000 ? points : null
})
const surchargeDirty = computed(() => parsedSurcharge.value !== null && parsedSurcharge.value !== account.value?.surchargeBasisPoints)
const savingSurcharge = ref(false)
async function saveSurcharge(points: number | null) {
  savingSurcharge.value = true
  errorMessage.value = null
  try {
    const response = await dashboardApi<{ success: true; account: ConnectedAccount }>('/api/dashboard/connect/surcharge', {
      method: 'POST', body: { basis_points: points },
      validate: (value): value is { success: true; account: ConnectedAccount } => isRecord(value) && value.success === true && isConnectedAccount(value.account),
    })
    setAccount(response.account)
  } catch (error) {
    errorMessage.value = getErrorMessage(error, 'The surcharge could not be saved')
  } finally {
    savingSurcharge.value = false
  }
}

async function openDashboard() {
  openingDashboard.value = true
  try {
    const result = await dashboardApi<{url:string}>('/api/dashboard/connect/dashboard',{method:'POST',validate:(value):value is {url:string}=>isRecord(value)&&typeof value.url==='string'})
    await navigateTo(result.url,{external:true})
  } catch(error) {errorMessage.value=getErrorMessage(error,'Stripe Dashboard could not be opened')}
  finally {openingDashboard.value=false}
}

async function startOnboarding() {
  starting.value = true
  errorMessage.value = null
  try {
    const response = await dashboardApi<{ success: true; account: ConnectedAccount; onboardingUrl: string }>('/api/dashboard/connect', {
      method: 'POST',
      body: { country: country.value },
      validate: isOnboardingResponse,
    })
    setAccount(response.account)
    await navigateTo(response.onboardingUrl, { external: true })
  } catch (error) {
    errorMessage.value = getErrorMessage(error, 'Stripe onboarding could not be started')
  } finally {
    starting.value = false
  }
}

async function refreshStatus() {
  if (account.value === null || account.value.stripeAccountId === null) return
  errorMessage.value = null
  try {
    const response = await dashboardApi<{ success: true; account: ConnectedAccount }>('/api/dashboard/connect/status', {
      method: 'POST',
      validate: (value): value is { success: true; account: ConnectedAccount } => isRecord(value) && value.success === true && isConnectedAccount(value.account),
    })
    setAccount(response.account)
  } catch (error) {
    errorMessage.value = getErrorMessage(error, 'Stripe Connect status could not be refreshed')
  }
}

onMounted(async () => {
  // Stripe's own state is asked for whenever setup is still open, not on a button: the status is read, not managed.
  if (account.value?.stripeAccountId && (route.query.stripe_connect === 'returned' || account.value.status !== 'ready')) {
    await refreshStatus()
    if (route.query.stripe_connect === 'returned') {
      const query = { ...route.query }
      delete query.stripe_connect
      await router.replace({ query })
    }
  }
})
</script>
