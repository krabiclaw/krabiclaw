<template>
  <DashboardIndexPanel v-if="!concern" id="new-stay" :title="title" :create="loadError ? null : firstStep">
    <UAlert v-if="loadError" color="error" title="This stay could not be prepared" :description="loadError" />
    <EditorNavigationList v-else :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
  <DashboardLeafPanel v-else id="new-stay-section" :title="labels[section]" :save-label="saveLabel" :saving="saving" :disabled="Boolean(loadError) || saveDisabled" :error="actionError || loadError || ''" @cancel="reset" @save="save">
    <UForm v-if="!loadError" :state="draft" :disabled="saving || Boolean(draft.attempt)" class="space-y-6" @submit="save">
      <template v-if="section === 'home'">
        <UFormField label="Home" name="product_id" required>
          <USelect v-model="draft.product_id" :items="homeItems" placeholder="Choose a home" aria-label="Home" class="w-full" :disabled="Boolean(suppliedHome)" />
        </UFormField>
      </template>
      <template v-else-if="section === 'dates'">
        <p v-if="home" class="text-sm text-muted">{{ home.name }} · {{ home.timezone }}</p>
        <UFormField label="Check-in" name="check_in_date" required><UInput v-model="draft.check_in_date" type="date" class="w-full" /></UFormField>
        <UFormField label="Checkout" name="check_out_date" required><UInput v-model="draft.check_out_date" type="date" :min="draft.check_in_date || undefined" class="w-full" /></UFormField>
        <UFormField label="Arrival time" name="arrival_time"><UInput v-model="draft.arrival_time" type="time" class="w-full" /></UFormField>
      </template>
      <template v-else-if="section === 'guest'">
        <UFormField label="First name" name="guest_name" required><UInput v-model="draft.guest_name" :maxlength="200" autocomplete="given-name" class="w-full" /></UFormField>
        <UFormField label="Last name" name="guest_surname"><UInput v-model="draft.guest_surname" :maxlength="200" autocomplete="family-name" class="w-full" /></UFormField>
        <UFormField label="Email" name="guest_email"><UInput v-model="draft.guest_email" type="email" :maxlength="254" autocomplete="email" class="w-full" /></UFormField>
        <UFormField label="Phone" name="guest_phone"><UInput v-model="draft.guest_phone" type="tel" placeholder="+66812345678" :maxlength="40" autocomplete="tel" class="w-full" /></UFormField>
        <div class="grid gap-5 sm:grid-cols-3">
          <UFormField label="Adults" name="adults" required><UInputNumber v-model="draft.adults" :min="1" :max="home?.max_guests ?? 99" class="w-full" /></UFormField>
          <UFormField label="Children" name="children"><UInputNumber v-model="draft.children" :min="0" :max="home?.max_guests ?? 99" class="w-full" /></UFormField>
          <UFormField label="Infants" name="infants"><UInputNumber v-model="draft.infants" :min="0" :max="99" class="w-full" /></UFormField>
        </div>
        <p v-if="home" class="text-sm text-muted">Sleeps up to {{ home.max_guests }} guests, excluding infants.</p>
      </template>
      <template v-else-if="section === 'total' && home">
        <UFormField :label="`Stay total (${home.currency})`" name="total" required><UInput v-model="draft.total" inputmode="decimal" class="w-full" /></UFormField>
        <UFormField label="Notes" name="notes"><UTextarea v-model="draft.notes" :maxlength="2000" class="w-full" /></UFormField>
        <USwitch v-model="draft.record_payment" label="Record a payment already received" />
        <template v-if="draft.record_payment">
          <p class="text-sm text-muted">Record money you received outside KrabiClaw. This does not charge your guest.</p>
          <UFormField :label="`Amount received (${home.currency})`" name="payment_amount" required><UInput v-model="draft.payment_amount" inputmode="decimal" class="w-full" /></UFormField>
          <UFormField label="Method" name="payment_method" required><USelect v-model="draft.payment_method" :items="paymentMethods" placeholder="Choose a method" class="w-full" /></UFormField>
          <UFormField label="Date received" name="payment_date" required><UInput v-model="draft.payment_date" type="date" class="w-full" /></UFormField>
          <UFormField label="Reference" name="payment_reference"><UInput v-model="draft.payment_reference" :maxlength="200" class="w-full" /></UFormField>
        </template>
      </template>
      <p v-if="sectionError" role="status" class="text-sm text-error">{{ sectionError }}</p>
    </UForm>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList from './EditorNavigationList.vue'
import type { StayHome } from '~/server/domain/stays'
import { MAX_STAY_NIGHTS, STAY_PAYMENT_METHODS, STAY_PAYMENT_METHOD_LABELS, type StayPaymentMethod } from '~/shared/bookings'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, majorAmountToMinor } from '~/shared/prices'
import { isSuccessfulChannelPush } from '~/shared/channel-push'
import { isValidCalendarDate, isValidTimezone, localDateAt } from '~/utils/timezone'
import { toE164 } from '~/utils/phone'
import { ApiClientError } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ concern?: string }>()
const labels = { home: 'Home', dates: 'Dates', guest: 'Guest', total: 'Total' }
type Section = keyof typeof labels
type Home = Pick<StayHome, 'product_id' | 'name' | 'currency' | 'timezone' | 'max_guests'>
const order: Section[] = ['home', 'dates', 'guest', 'total']
const section = computed<Section>(() => props.concern && order.includes(props.concern as Section) ? props.concern as Section : 'home')
if (props.concern && !order.includes(props.concern as Section)) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
const route = useRoute()
const router = useRouter()
const nuxtApp = useNuxtApp()
const level = useRouteLevel()
const orgSlug = String(route.params.orgSlug)
const api = useDashboardApi(computed(() => ({ orgSlug })))
const mutation = new AbortController()
onScopeDispose(() => mutation.abort())
const recordPath = computed(() => `/dashboard/${encodeURIComponent(orgSlug)}/bookings/stay/new`)
const suppliedHome = typeof route.query.product_id === 'string' ? route.query.product_id : ''
const queryError = computed(() => {
  for (const [key, label] of [['product_id', 'home'], ['check_in_date', 'check-in date'], ['check_out_date', 'checkout date']] as const) {
    const value = route.query[key]
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) return `Choose one ${label}.`
    if (key !== 'product_id' && typeof value === 'string' && !isValidCalendarDate(value)) return `Choose a valid ${label}.`
  }
  return null
})
const { data, error } = await useAsyncData(`stay-create-homes:${orgSlug}`, () => api('/api/dashboard/stay-homes', {
  validate: (value): value is { homes: Home[]; manage: boolean } => isRecord(value) && typeof value.manage === 'boolean' && Array.isArray(value.homes)
    && value.homes.every(home => isRecord(home) && typeof home.product_id === 'string' && Boolean(home.product_id) && typeof home.name === 'string' && isCurrencyCode(home.currency) && typeof home.timezone === 'string' && isValidTimezone(home.timezone) && Number.isInteger(home.max_guests) && Number(home.max_guests) > 0),
}))
const loadError = computed(() => queryError.value || (error.value ? getErrorMessage(error.value, 'Homes could not be loaded') : !data.value ? 'Homes could not be loaded.' : !data.value.manage ? 'Only owners and admins can add stays.' : suppliedHome && !data.value.homes.some(home => home.product_id === suppliedHome) ? 'That home is not available in this organization.' : !data.value.homes.length ? 'Add a home in Catalog before recording a stay.' : null))
const draftKey = `stay-create:${orgSlug}:${suppliedHome}:${String(route.query.check_in_date ?? '')}:${String(route.query.check_out_date ?? '')}`
function initialDraft() {
  return {
    product_id: suppliedHome, check_in_date: typeof route.query.check_in_date === 'string' ? route.query.check_in_date : '', check_out_date: typeof route.query.check_out_date === 'string' ? route.query.check_out_date : '', arrival_time: '',
    guest_name: '', guest_surname: '', guest_email: '', guest_phone: '', adults: 1 as number | undefined, children: 0 as number | undefined, infants: 0 as number | undefined,
    total: '', notes: '', record_payment: false, payment_amount: '', payment_method: undefined as StayPaymentMethod | undefined, payment_date: '', payment_reference: '',
    key: crypto.randomUUID(), attempt: null as Record<string, unknown> | null,
  }
}
const draft = useState(draftKey, initialDraft)
const home = computed(() => data.value?.homes.find(home => home.product_id === draft.value.product_id))
const homeItems = computed(() => data.value?.homes.map(home => ({ label: home.name, value: home.product_id })) ?? [])
watch(home, value => { if (value && (!draft.value.record_payment || !draft.value.payment_date)) draft.value.payment_date = localDateAt(new Date(), value.timezone) }, { immediate: true })
const paymentMethods = STAY_PAYMENT_METHODS.map(value => ({ value, label: STAY_PAYMENT_METHOD_LABELS[value] }))
function amount(value: string): number {
  if (!home.value) throw new Error('Choose a home.')
  return majorAmountToMinor(value.trim(), home.value.currency)
}
const validation = computed<Record<Section, string | null>>(() => {
  const value = draft.value
  const dates = !isValidCalendarDate(value.check_in_date) || !isValidCalendarDate(value.check_out_date) ? 'Choose check-in and checkout dates.'
    : value.check_out_date <= value.check_in_date ? 'Checkout must be after check-in.'
    : (Date.parse(`${value.check_out_date}T00:00:00Z`) - Date.parse(`${value.check_in_date}T00:00:00Z`)) / 86_400_000 > MAX_STAY_NIGHTS ? `A stay is at most ${MAX_STAY_NIGHTS} nights.`
    : value.arrival_time && !/^\d{2}:\d{2}$/.test(value.arrival_time) ? 'Choose a valid arrival time.' : null
  const validCount = (count: number | undefined, minimum: number) => typeof count === 'number' && Number.isInteger(count) && count >= minimum && count <= 99
  const guest = !value.guest_name.trim() ? 'Enter the guest’s first name.'
    : !validCount(value.adults, 1) || !validCount(value.children, 0) || !validCount(value.infants, 0) ? 'Enter whole guest counts with at least one adult.'
    : home.value && value.adults! + value.children! > home.value.max_guests ? `This home sleeps at most ${home.value.max_guests} guests.`
    : value.guest_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.guest_email.trim()) ? 'Enter a valid email address.'
    : value.guest_phone.trim() && !toE164(value.guest_phone.trim()) ? 'Use an international phone number with its country calling code.' : null
  let total: string | null = null
  try {
    if (!value.total.trim()) total = 'Enter the stay total.'
    else amount(value.total)
    if (value.record_payment) {
      if (amount(value.payment_amount) <= 0) total = 'Enter an amount received greater than zero.'
      else if (!STAY_PAYMENT_METHODS.includes(value.payment_method as typeof STAY_PAYMENT_METHODS[number])) total = 'Choose how the payment was received.'
      else if (!isValidCalendarDate(value.payment_date)) total = 'Choose when the payment was received.'
    }
  } catch (cause) { total = getErrorMessage(cause, 'Enter a valid stay total.') }
  return { home: home.value ? null : 'Choose a home.', dates, guest, total }
})
const sectionError = computed(() => validation.value[section.value])
const saving = ref(false)
const actionError = ref('')
const { title, firstStep, saveLabel, saveDisabled, save } = useCreateWalk({ recordPath, isNew: computed(() => true), openKey: section, labels, order, missing: key => Boolean(validation.value[key]), noun: 'stay', saving, commit })
const groups = computed(() => [{ id: 'stay', items: order.map(key => ({ id: key, label: labels[key], to: router.resolve({ path: `${recordPath.value}/${key}`, query: route.query }).fullPath, summary: key === 'home' ? home.value?.name ?? 'Choose a home' : key === 'dates' ? draft.value.check_in_date && draft.value.check_out_date ? `${draft.value.check_in_date} – ${draft.value.check_out_date}` : 'Choose dates' : key === 'guest' ? [draft.value.guest_name, draft.value.guest_surname].filter(Boolean).join(' ') || 'Add guest details' : validation.value.total ? 'Enter a total' : home.value ? formatMinorAmount(amount(draft.value.total), home.value.currency) : 'Enter a total', placeholder: Boolean(validation.value[key]) })) }])
function reset() { draft.value = initialDraft(); actionError.value = '' }
async function commit() {
  if (saving.value || loadError.value || order.some(key => validation.value[key])) return
  saving.value = true
  actionError.value = ''
  try {
    draft.value.attempt ??= {
      product_id: draft.value.product_id, check_in_date: draft.value.check_in_date, check_out_date: draft.value.check_out_date, arrival_time: draft.value.arrival_time || null,
      adults: draft.value.adults, children: draft.value.children, infants: draft.value.infants, guest_name: draft.value.guest_name.trim(), guest_surname: draft.value.guest_surname.trim() || null,
      guest_email: draft.value.guest_email.trim() || null, guest_phone: draft.value.guest_phone.trim() || null, total_minor: amount(draft.value.total), notes: draft.value.notes.trim() || null, idempotency_key: draft.value.key,
      ...(draft.value.record_payment ? { payment: { amount_minor: amount(draft.value.payment_amount), method: draft.value.payment_method, paid_on: draft.value.payment_date, reference: draft.value.payment_reference.trim() || null } } : {}),
    }
    const result = await api('/api/dashboard/stays', { method: 'POST', body: draft.value.attempt, signal: mutation.signal, validate: (value): value is { stay: { id: string } } => isRecord(value) && isRecord(value.stay) && typeof value.stay.id === 'string' && Boolean(value.stay.id) && Object.hasOwn(value.stay, 'channel_push') && isSuccessfulChannelPush(value.stay.channel_push) })
    if (mutation.signal.aborted) return
    const { payment, idempotency_key: _key, ...fields } = draft.value.attempt
    const expected = { ...fields, guest_phone: draft.value.guest_phone.trim() ? toE164(draft.value.guest_phone.trim()) : null }
    await api(`/api/dashboard/stays/${encodeURIComponent(result.stay.id)}`, { signal: mutation.signal, validate: (value): value is { stay: { id: string } } => isRecord(value) && isRecord(value.stay) && value.stay.id === result.stay.id && value.stay.status === 'confirmed'
      && Object.entries(expected).every(([field, wanted]) => (value.stay as Record<string, unknown>)[field] === wanted)
      && value.stay.currency === home.value?.currency && Array.isArray(value.stay.payments)
      && (!isRecord(payment) || value.stay.payments.some(saved => isRecord(saved) && saved.amount_minor === payment.amount_minor && saved.method === payment.method && saved.paid_on === payment.paid_on && saved.reference === payment.reference)) })
    if (mutation.signal.aborted) return
    await refreshNuxtData(Object.keys(nuxtApp.payload.data).filter(key => key.startsWith(`dashboard-today-${orgSlug}-`) || key.startsWith(`stay-night-calendar:${orgSlug}:`)))
    if (mutation.signal.aborted) return
    await navigateTo(`/dashboard/${encodeURIComponent(orgSlug)}/bookings/stay/${encodeURIComponent(result.stay.id)}`, { replace: true })
    clearNuxtState(draftKey, { reset: true })
  } catch (cause) {
    actionError.value = getErrorMessage(cause, 'The stay could not be created.')
    if (cause instanceof ApiClientError && cause.statusCode >= 400 && cause.statusCode < 500 && cause.code !== 'IDEMPOTENCY_CONFLICT') draft.value.attempt = null
  } finally { saving.value = false }
}
onBeforeRouteLeave(to => {
  if (to.path !== recordPath.value && !to.path.startsWith(`${recordPath.value}/`)) clearNuxtState(draftKey, { reset: true })
})
</script>
