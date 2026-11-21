<template>
  <DashboardLeafPanel
    id="booking-deposit-panel"
    :title="deposit?.label ?? 'Deposit'"
    :lead="deposit ? 'What you ask for, and what you received, returned or kept. Blawby moves no money here.' : undefined"
    :save-label="null"
    :footer="false"
    :error="deposit ? error : 'This booking has no price, so it has no deposit.'"
  >
    <template v-if="deposit && currency">
      <div class="divide-y divide-default border-y border-default">
        <button type="button" :class="rowClass" data-testid="deposit-required" @click="openRequired">
          <span class="min-w-0 flex-1">
            <span class="block font-medium">Amount you ask for</span>
            <span class="block text-sm text-muted">{{ deposit.required_minor === null ? 'None' : money(deposit.required_minor) }}</span>
          </span>
          <UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
        </button>
        <div class="flex items-center justify-between py-4 text-sm">
          <span class="font-medium text-highlighted">Held now</span>
          <span class="text-highlighted" data-testid="deposit-held">{{ money(deposit.held_minor) }}</span>
        </div>
      </div>

      <h3 class="mt-6 text-sm font-semibold text-highlighted">Recorded</h3>
      <ul v-if="deposit.entries.length" class="mt-2 divide-y divide-default" data-testid="deposit-entries">
        <li v-for="entry in deposit.entries" :key="entry.id" class="flex items-start gap-3 py-3 text-sm">
          <span class="min-w-0 flex-1">
            <span class="block text-highlighted">{{ KIND_LABELS[entry.kind] }} · {{ money(entry.amount_minor) }}</span>
            <span class="block text-muted">{{ day(entry.paid_on) }}<template v-if="entry.kind !== 'withheld'"> · {{ METHOD_LABELS[entry.method] }}</template><template v-if="entry.reference"> · {{ entry.reference }}</template></span>
            <span v-if="entry.note" class="block text-muted">{{ entry.note }}</span>
          </span>
          <UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" :aria-label="`Remove ${KIND_LABELS[entry.kind].toLowerCase()} of ${money(entry.amount_minor)}`" :loading="removing === entry.id" @click="removeEntry(entry)" />
        </li>
      </ul>
      <p v-else class="mt-2 text-sm text-muted">Nothing recorded yet.</p>

      <div class="mt-4 divide-y divide-default border-t border-default">
        <button v-for="kind in DEPOSIT_ENTRY_KINDS" :key="kind" type="button" :class="rowClass" :disabled="kind !== 'received' && deposit.held_minor === 0" :data-testid="`deposit-${kind}`" @click="openEntry(kind)">
          <UIcon :name="KIND_ICONS[kind]" class="size-5 shrink-0" /><span class="min-w-0 flex-1">{{ ACTION_LABELS[kind] }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
        </button>
      </div>
    </template>

    <DashboardListItemDialog v-model:open="requiredOpen" title="Amount you ask for" save-label="Save" :saving="saving" :removable="deposit?.required_minor != null" :removing="saving" :error="dialogError" @save="saveRequired(requiredDraft)" @remove="saveRequired(null)">
      <UFormField :label="`Amount (${currency})`">
        <UInput v-model="requiredDraft" inputmode="decimal" autocomplete="off" data-testid="deposit-required-input" />
      </UFormField>
    </DashboardListItemDialog>

    <DashboardListItemDialog v-model:open="entryOpen" :title="entryKind ? ACTION_LABELS[entryKind] : ''" save-label="Record" :saving="saving" :save-disabled="!entryDraft.amount || (entryKind === 'withheld' && !entryDraft.note.trim())" :error="dialogError" @save="saveEntry">
      <div class="space-y-4">
        <UFormField :label="`Amount (${currency})`" :hint="entryKind !== 'received' && deposit ? `${money(deposit.held_minor)} held` : undefined">
          <UInput v-model="entryDraft.amount" inputmode="decimal" autocomplete="off" data-testid="deposit-entry-amount" />
        </UFormField>
        <UFormField v-if="entryKind !== 'withheld'" label="How">
          <USelect v-model="entryDraft.method" :items="DEPOSIT_METHODS.map(value => ({ value, label: METHOD_LABELS[value] }))" class="w-full" />
        </UFormField>
        <UFormField label="Date">
          <UInput v-model="entryDraft.paid_on" type="date" />
        </UFormField>
        <UFormField v-if="entryKind !== 'withheld'" label="Reference" hint="Optional">
          <UInput v-model="entryDraft.reference" autocomplete="off" />
        </UFormField>
        <UFormField :label="entryKind === 'withheld' ? 'What it was kept for' : 'Note'" :hint="entryKind === 'withheld' ? undefined : 'Optional'">
          <UTextarea v-model="entryDraft.note" :rows="3" class="w-full" data-testid="deposit-entry-note" />
        </UFormField>
      </div>
    </DashboardListItemDialog>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import { isCurrencyCode } from '~/shared/currencies'
import { DEPOSIT_ENTRY_KINDS, DEPOSIT_METHODS, isBookingDeposit, type DepositEntry, type DepositEntryKind, type DepositMethod } from '~/shared/deposits'
import { formatMinorAmount, majorAmountToMinor, minorAmountToMajor } from '~/shared/prices'
import { isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const KIND_LABELS: Record<DepositEntryKind, string> = { received: 'Received', returned: 'Returned', withheld: 'Kept' }
const ACTION_LABELS: Record<DepositEntryKind, string> = { received: 'Record money received', returned: 'Record money returned', withheld: 'Keep part of it' }
const KIND_ICONS: Record<DepositEntryKind, string> = { received: 'i-lucide-arrow-down-left', returned: 'i-lucide-arrow-up-right', withheld: 'i-lucide-hand-coins' }
const METHOD_LABELS: Record<DepositMethod, string> = { cash: 'Cash', bank_transfer: 'Bank transfer', card_external: 'Card, outside Blawby', other: 'Other' }
const rowClass = 'flex w-full items-center gap-3 py-4 text-left text-sm text-highlighted disabled:opacity-50'

const editor = inject(bookingEditorKey, null)
const dashboardApi = useDashboardApi()
const context = computed(() => editor?.deposit.value ?? null)
const deposit = computed(() => context.value?.current ?? null)
const currency = computed(() => {
  const code = deposit.value?.currency
  if (code === undefined) return null
  if (!isCurrencyCode(code)) throw new Error(`Unsupported deposit currency ${code}`)
  return code
})
const money = (minor: number) => formatMinorAmount(minor, currency.value!)
const day = (date: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))

const error = ref('')
const dialogError = ref('')
const saving = ref(false)
const removing = ref<string | null>(null)

const requiredOpen = ref(false)
const requiredDraft = ref('')
function openRequired() {
  requiredDraft.value = deposit.value?.required_minor != null ? minorAmountToMajor(deposit.value.required_minor, currency.value!) : ''
  dialogError.value = ''
  requiredOpen.value = true
}

function minorFrom(value: string) {
  const minor = majorAmountToMinor(value.trim(), currency.value!)
  if (minor <= 0) throw new Error('Enter an amount above zero')
  return minor
}

function base() {
  return `/api/dashboard/bookings/${encodeURIComponent(context.value!.bookingId)}/deposit`
}

async function write(run: () => Promise<unknown>, onDone: () => void) {
  saving.value = true
  dialogError.value = ''
  try {
    await run()
    await editor!.refresh()
    onDone()
  } catch (failure) {
    dialogError.value = getErrorMessage(failure, 'The deposit could not be saved')
  } finally {
    saving.value = false
  }
}

function saveRequired(value: string | null) {
  void write(async () => {
    const answer = await dashboardApi(base(), { method: 'PUT', body: { deposit_minor: value === null ? null : minorFrom(value) }, validate: isRecord })
    if (answer.deposit !== null && !isBookingDeposit(answer.deposit)) throw new Error('The saved deposit could not be read back')
  }, () => { requiredOpen.value = false })
}

const entryOpen = ref(false)
const entryKind = ref<DepositEntryKind | null>(null)
const entryDraft = reactive({ amount: '', method: 'bank_transfer' as DepositMethod, paid_on: '', reference: '', note: '', key: '' })
function openEntry(kind: DepositEntryKind) {
  const value = deposit.value!
  // Received opens with what is still owed; returned with what is held.
  const suggested = kind === 'received' ? Math.max((value.required_minor ?? 0) - value.held_minor - value.returned_minor - value.withheld_minor, 0) : kind === 'returned' ? value.held_minor : 0
  Object.assign(entryDraft, { amount: suggested > 0 ? minorAmountToMajor(suggested, currency.value!) : '', method: 'bank_transfer', paid_on: context.value!.today, reference: '', note: '', key: crypto.randomUUID() })
  entryKind.value = kind
  dialogError.value = ''
  entryOpen.value = true
}

function saveEntry() {
  const kind = entryKind.value!
  void write(async () => {
    await dashboardApi(`${base()}/entries`, {
      method: 'POST', validate: isRecord,
      body: {
        kind, amount_minor: minorFrom(entryDraft.amount), method: kind === 'withheld' ? undefined : entryDraft.method, paid_on: entryDraft.paid_on,
        reference: entryDraft.reference.trim() || null, note: entryDraft.note.trim() || null, idempotency_key: entryDraft.key,
      },
    })
  }, () => { entryOpen.value = false })
}

async function removeEntry(entry: DepositEntry) {
  removing.value = entry.id
  error.value = ''
  try {
    await dashboardApi(`${base()}/entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE', validate: isRecord })
    await editor!.refresh()
  } catch (failure) {
    error.value = getErrorMessage(failure, 'The entry could not be removed')
  } finally {
    removing.value = null
  }
}
</script>
