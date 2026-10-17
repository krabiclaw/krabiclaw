<template>
  <!--
    Airbnb's transaction list: pills for dates, listings (our locations) and
    earnings type, then one line per payment — the picture, "Paid Oct 4", who
    and what, the amount — a total and Export CSV at the foot. A line opens the
    record it paid for.
  -->
  <DashboardIndexPanel id="earnings-transactions" title="Transactions" column="reading">
    <div>
      <div class="mb-8 flex flex-wrap items-center gap-2">
        <UDropdownMenu :items="monthItems" :content="{ align: 'start' }" :ui="{ content: 'w-56' }">
          <UButton :label="periodLabel" trailing-icon="i-lucide-chevron-down" color="neutral" :variant="from ? 'solid' : 'outline'" class="h-10 rounded-full px-4 text-sm font-normal" />
        </UDropdownMenu>
        <UDropdownMenu v-if="locations.length > 1" :items="locationItems" :content="{ align: 'start' }" :ui="{ content: 'w-64' }">
          <UButton :label="locationLabel" trailing-icon="i-lucide-chevron-down" color="neutral" :variant="locationId ? 'solid' : 'outline'" class="h-10 rounded-full px-4 text-sm font-normal" />
        </UDropdownMenu>
        <UDropdownMenu :items="typeItems" :content="{ align: 'start' }" :ui="{ content: 'w-56' }">
          <UButton :label="typeLabel" trailing-icon="i-lucide-chevron-down" color="neutral" :variant="earningsType ? 'solid' : 'outline'" class="h-10 rounded-full px-4 text-sm font-normal" />
        </UDropdownMenu>
      </div>

      <UAlert v-if="error" class="mt-6" color="error" :description="error.message" />
      <template v-else-if="data">
        <p v-if="!rows.length" class="mt-6 text-base text-muted">No transactions in this period.</p>
        <div v-else class="mt-6 space-y-6">
          <NuxtLink v-for="row in rows" :key="row.id" :to="row.to" class="flex items-center gap-4" :data-testid="`transaction-${row.id}`">
            <span class="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-elevated">
              <img v-if="row.image_url" :src="row.image_url" alt="" class="size-full object-cover" loading="lazy">
              <UIcon v-else name="i-lucide-receipt" class="size-6 text-dimmed" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-base font-medium text-highlighted">{{ paymentStateLabel(row) }} {{ formatTimestamp(row.created_at, 'en', 'UTC', { month: 'short', day: 'numeric' }) }}</span>
              <span v-if="row.buyer_name" class="block truncate text-sm text-muted">{{ row.buyer_name }}</span>
              <span class="block truncate text-sm text-muted">{{ whenLabel(row) }}</span>
            </span>
            <span class="shrink-0 text-right">
              <span class="block text-base font-medium tabular-nums text-highlighted">{{ paymentMoney(row.captured_amount - row.refunded_amount, row.currency) }}</span>
              <span class="block text-sm text-muted">{{ row.currency }}</span>
            </span>
            <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
          </NuxtLink>
        </div>
        <UButton v-if="data.next_cursor" class="mt-6" color="neutral" variant="soft" label="Show more" @click="after = data.next_cursor" />
      </template>
    </div>

    <template v-if="rows.length" #footer>
      <div class="flex items-center justify-between gap-4">
        <p class="text-lg font-semibold text-highlighted">{{ total }}</p>
        <UButton label="Export CSV" size="lg" @click="exportCsv" />
      </div>
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { paymentMoney, paymentStateLabel } from '~/shared/payment-display'
import { downloadCsv, isTransactionsView, type TransactionRow } from '~/shared/earnings-display'
import { minorAmountToMajor } from '~/shared/prices'
import type { CurrencyCode } from '~/shared/currencies'
import { formatCalendarDate, formatTimestamp } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Transactions | KrabiClaw', robots: 'noindex, nofollow' })

const route = useRoute()
const router = useRouter()
const api = useDashboardApi()
const now = new Date()
const monthKey = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
const queryString = (key: string) => typeof route.query[key] === 'string' && route.query[key] ? String(route.query[key]) : ''
// The filters live in the URL, as Airbnb's do: a UTC month or nothing (the last year), a location, an earnings type.
const from = ref(queryString('from'))
const through = ref(queryString('through'))
const locationId = ref(queryString('location_id'))
const earningsType = ref<'' | 'paid' | 'refunded'>(route.query.earnings_type === 'paid' || route.query.earnings_type === 'refunded' ? route.query.earnings_type : '')
const after = ref<string | null>(null)
const loaded = ref<TransactionRow[]>([])
watch([from, through, locationId, earningsType], () => {
  after.value = null
  void router.replace({ query: { ...route.query, from: from.value || undefined, through: through.value || undefined, location_id: locationId.value || undefined, earnings_type: earningsType.value || undefined } })
})

const months = Array.from({ length: 12 }, (_, offset) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1)))
const monthItems = computed(() => [[
  { label: 'All dates', type: 'checkbox' as const, checked: !from.value, onSelect: () => { from.value = ''; through.value = '' } },
  ...months.map(date => ({
    label: formatCalendarDate(date.toISOString().slice(0, 10), 'en', { month: 'long', year: 'numeric' }),
    type: 'checkbox' as const,
    checked: from.value === `${monthKey(date)}-01`,
    onSelect: () => {
      from.value = `${monthKey(date)}-01`
      through.value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
    },
  })),
]])
const periodLabel = computed(() => !from.value
  ? 'All dates'
  : from.value.slice(0, 7) === through.value.slice(0, 7)
    ? formatCalendarDate(from.value, 'en', { month: 'long', year: 'numeric' })
    : `${formatCalendarDate(from.value, 'en', { month: 'short', day: 'numeric' })} – ${formatCalendarDate(through.value, 'en', { month: 'short', day: 'numeric', year: 'numeric' })}`)

// Airbnb's "All listings": the business's locations, each with its picture.
type LocationPill = { id: string; title: string; imageUrl: string | null }
const isLocationList = (value: unknown): value is { locations: LocationPill[] } => isRecord(value) && Array.isArray(value.locations)
  && value.locations.every(row => isRecord(row) && typeof row.id === 'string' && typeof row.title === 'string' && (row.imageUrl === null || typeof row.imageUrl === 'string'))
const { data: locationData } = await useAsyncData(() => `earnings-transaction-locations:${route.params.orgSlug}`, () => api<{ locations: LocationPill[] }>('/api/dashboard/locations', { validate: isLocationList }))
const locations = computed(() => locationData.value?.locations ?? [])
const locationItems = computed(() => [[
  { label: 'All locations', type: 'checkbox' as const, checked: !locationId.value, onSelect: () => { locationId.value = '' } },
  ...locations.value.map(location => ({
    label: location.title,
    ...(location.imageUrl ? { avatar: { src: location.imageUrl } } : { icon: 'i-lucide-map-pin' }),
    type: 'checkbox' as const,
    checked: locationId.value === location.id,
    onSelect: () => { locationId.value = location.id },
  })),
]])
const locationLabel = computed(() => locations.value.find(location => location.id === locationId.value)?.title ?? 'All locations')

const TYPES = [{ value: '' as const, label: 'All earnings types' }, { value: 'paid' as const, label: 'Paid' }, { value: 'refunded' as const, label: 'Refunded' }]
const typeItems = computed(() => [TYPES.map(type => ({ label: type.label, type: 'checkbox' as const, checked: earningsType.value === type.value, onSelect: () => { earningsType.value = type.value } }))])
const typeLabel = computed(() => TYPES.find(type => type.value === earningsType.value)!.label)

const { data, error } = await useAsyncData(
  () => `earnings-transactions:${route.params.orgSlug}:${from.value}:${through.value}:${locationId.value}:${earningsType.value}:${after.value ?? ''}`,
  async () => {
    // "All dates" is the last twelve months, the span the month list offers.
    const start = from.value ? new Date(`${from.value}T00:00:00.000Z`) : months.at(-1)!
    const end = through.value ? new Date(`${through.value}T00:00:00.000Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) throw new Error('Choose a valid period')
    end.setUTCDate(end.getUTCDate() + 1)
    const page = await api<{ payments: TransactionRow[]; next_cursor: string | null }>('/api/dashboard/payments', {
      query: {
        view: 'transactions', from: start.toISOString(), to: end.toISOString(),
        ...(locationId.value ? { location_id: locationId.value } : {}),
        ...(earningsType.value ? { earnings_type: earningsType.value } : {}),
        ...(after.value ? { after: after.value } : {}),
      },
      validate: isTransactionsView,
    })
    loaded.value = after.value ? [...loaded.value, ...page.payments] : page.payments
    return page
  },
  { watch: [from, through, locationId, earningsType, after] },
)
// Newest first, as Airbnb lists them.
const rows = computed(() => [...loaded.value].sort((a, b) => b.created_at.localeCompare(a.created_at)))
const total = computed(() => {
  const totals = new Map<string, number>()
  for (const row of rows.value) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.captured_amount - row.refunded_amount)
  return [...totals].map(([code, amount]) => paymentMoney(amount, code)).join(' · ')
})
function whenLabel(row: TransactionRow): string {
  if (!row.starts_at || !row.timezone) return row.title
  const start = formatTimestamp(row.starts_at, 'en', row.timezone, { month: 'short', day: 'numeric' })
  const end = row.ends_at ? formatTimestamp(row.ends_at, 'en', row.timezone, { month: 'short', day: 'numeric' }) : start
  return `${row.title} · ${start === end ? start : `${start}–${end}`}`
}
function exportCsv() {
  downloadCsv(`transactions-${String(route.params.orgSlug)}-${from.value || 'all'}.csv`, ['Date', 'Status', 'Buyer', 'Item', 'Paid', 'Refunded', 'Currency', 'Payment ID'],
    rows.value.map(row => [row.created_at.slice(0, 10), paymentStateLabel(row), row.buyer_name ?? '', row.title, minorAmountToMajor(row.captured_amount, row.currency as CurrencyCode), minorAmountToMajor(row.refunded_amount, row.currency as CurrencyCode), row.currency, row.id]))
}
</script>
