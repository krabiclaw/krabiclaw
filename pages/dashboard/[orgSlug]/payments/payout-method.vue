<template>
  <!-- Airbnb's Payouts: How you get paid — the bank row with Edit, Add payout method, and a Need help card. Every control acts at once at Stripe, so there is nothing to Save. -->
  <DashboardLeafPanel id="organization-payout-method" title="How you get paid" :lead="connectPending || connectError ? undefined : payout ? 'Your money goes to the bank account on file with Stripe.' : 'Add a payout method with Stripe to receive your earnings.'" :footer="false">
    <UAlert v-if="failure" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Stripe Connect is unavailable" :description="failure" />

    <p v-if="connectPending" role="status" class="text-muted">Loading payout settings…</p>

    <UFormField v-if="needsCountry && !connectError && !connectPending" label="Business country" description="Where your business is legally established.">
      <USelectMenu v-model="country" :items="countries" value-key="value" class="w-full" placeholder="Choose a country" />
    </UFormField>

    <UButton v-if="!account && !connectError && !connectPending" class="mt-6" size="xl" :loading="starting" :disabled="needsCountry && !country" label="Add payout method" @click="startOnboarding" />

    <template v-else-if="account && !connectError && !connectPending">
      <div v-if="payout" class="flex items-center gap-4 py-4">
        <UIcon name="i-lucide-landmark" class="size-8 shrink-0 text-highlighted" />
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2 text-base font-medium text-highlighted">Bank account <UBadge color="neutral" variant="subtle" size="sm" label="DEFAULT" /></p>
          <p class="mt-0.5 text-sm text-muted">{{ payout.bankName ?? 'Bank account' }}, ••••{{ payout.last4 }} ({{ payout.currency }})</p>
        </div>
        <UButton label="Edit" color="neutral" variant="outline" :loading="openingDashboard" @click="openDashboard" />
      </div>
      <p v-if="payout" class="text-sm text-muted">{{ scheduleLabel }}.</p>

      <UAlert v-if="account.requirements.length" class="mt-6" color="warning" variant="soft" icon="i-lucide-list-checks" title="Stripe needs more information" :description="status.description" />
      <p v-else-if="account.status !== 'ready'" class="mt-6 text-base text-muted">{{ status.description }}</p>

      <UButton v-if="canContinueOnboarding" class="mt-6" size="xl" :loading="starting" :disabled="needsCountry && !country" :label="account.status === 'creation_failed' ? 'Retry Stripe setup' : 'Continue Stripe setup'" @click="startOnboarding" />
      <UButton v-else-if="!payout" class="mt-6" size="xl" label="Add payout method" :loading="openingDashboard" @click="openDashboard" />
    </template>

    <PaymentsHelp class="mt-10" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import PaymentsHelp from '~/components/dashboard/PaymentsHelp.vue'
import { connectStatusPresentation, isConnectedAccount, useConnectAccount, type ConnectedAccount } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'How you get paid | KrabiClaw', robots: 'noindex, nofollow' })

const dashboardApi = useDashboardApi()
const route = useRoute()
const router = useRouter()
const { connect, connectError, connectPending, refreshConnect, account, payout, setAccount } = useConnectAccount()
const country = ref<string>()
const needsCountry = computed(() => !account.value?.stripeAccountId)
const countries = computed(() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' })
  return (connect.value?.countries ?? []).map(value => ({ value, label: names.of(value) ?? value })).sort((a, b) => a.label.localeCompare(b.label))
})
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
const status = computed(() => connectStatusPresentation(account.value?.status))
const isAccountReply = (value: unknown): value is { success: true; account: ConnectedAccount } => isRecord(value) && value.success === true && isConnectedAccount(value.account)

async function openDashboard() {
  openingDashboard.value = true
  try {
    if (connectPending.value || connectError.value || !connect.value) throw new Error('Load payment settings before opening Stripe.')
    const result = await dashboardApi<{ url: string }>('/api/dashboard/connect/dashboard', { method: 'POST', validate: (value): value is { url: string } => isRecord(value) && typeof value.url === 'string' })
    await navigateTo(result.url, { external: true })
  } catch (error) {
    errorMessage.value = getErrorMessage(error, 'Stripe Dashboard could not be opened')
  } finally {
    openingDashboard.value = false
  }
}

async function startOnboarding() {
  starting.value = true
  errorMessage.value = null
  try {
    if (connectPending.value || connectError.value || !connect.value) throw new Error('Load payment settings before starting Stripe setup.')
    const response = await dashboardApi<{ success: true; account: ConnectedAccount; onboardingUrl: string }>('/api/dashboard/connect', {
      method: 'POST', body: { country: country.value },
      validate: (value): value is { success: true; account: ConnectedAccount; onboardingUrl: string } => isAccountReply(value) && typeof (value as { onboardingUrl?: unknown }).onboardingUrl === 'string',
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
    const response = await dashboardApi<{ success: true; account: ConnectedAccount }>('/api/dashboard/connect/status', { method: 'POST', validate: isAccountReply })
    setAccount(response.account)
    await refreshConnect()
    if (connectError.value) throw connectError.value
    return true
  } catch (error) {
    errorMessage.value = getErrorMessage(error, 'Stripe Connect status could not be refreshed')
    return false
  }
}

onMounted(() => {
  let checkedStatus = false
  watch(connectPending, async (pending) => {
    if (pending || connectError.value || checkedStatus) return
    checkedStatus = true
    // Stripe's own state is asked for whenever setup is still open, not on a button: the status is read, not managed.
    if (account.value?.stripeAccountId && (route.query.stripe_connect === 'returned' || account.value.status !== 'ready')) {
      if (!await refreshStatus()) return
      if (route.query.stripe_connect === 'returned') {
        const query = { ...route.query }
        delete query.stripe_connect
        await router.replace({ query })
      }
    }
  }, { immediate: true })
})
</script>
