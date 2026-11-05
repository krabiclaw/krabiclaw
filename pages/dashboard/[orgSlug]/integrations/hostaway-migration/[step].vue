<template>
  <DashboardLeafPanel id="hostaway-migration-step" :title="labels[openKey]" :lead="lead" :save-label="saveLabel" :saving="busy" :disabled="disabled" :error="error" @save="save">
    <template #right>
      <UButton v-if="previous" :to="`${base}/${previous}`" label="Back" color="neutral" variant="ghost" :disabled="busy" />
    </template>

    <div :inert="busy">
    <div v-if="openKey === 'upload'" class="space-y-6">
      <ol class="list-decimal space-y-3 ps-5 text-base text-muted">
        <li>Pause the Airbnb listings you are moving and keep them paused while you check the handover.</li>
        <li>In Hostaway, open <strong class="text-highlighted">Reservations → Download Report</strong> and choose the complete list of fields.</li>
        <li>Include every current and future stay, across all booking channels. Include guests who have already checked in.</li>
      </ol>
      <UButton to="https://support.hostaway.com/hc/en-us/articles/360021922293-Reservations-Download-Reservations-via-CSV" target="_blank" external label="Hostaway export instructions" icon="i-lucide-external-link" color="neutral" variant="link" />
      <UFormField label="Reservation export" required>
        <input type="file" accept=".csv,text/csv" aria-label="Reservation export" class="block w-full rounded-xl border border-default p-4 text-base file:me-4 file:rounded-lg file:border-0 file:bg-elevated file:px-4 file:py-2 file:font-medium" :disabled="busy" @change="readFile">
      </UFormField>
      <p v-if="draft.filename" class="text-sm text-muted">{{ draft.filename }} · {{ preview?.rows.length ?? 0 }} reservation rows</p>
      <UCheckbox v-model="draft.paused" label="I've paused the affected Airbnb listings for this handover." />
      <p class="text-sm text-muted">KrabiClaw does not pause or reopen your listings. Manual blocks are reviewed in a separate step because a reservation export may not include them.</p>
      <UAlert v-if="context && !context.homes.length" color="warning" variant="soft" title="Add your Airbnb homes first" description="Keep the listings paused, sync the homes you are moving, then return here with your export." />
      <UButton v-if="context && !context.homes.length" :to="airbnbPath" label="Open Airbnb sync" color="neutral" variant="outline" />
    </div>

    <div v-else-if="openKey === 'columns'" class="space-y-7">
      <div class="grid gap-5 sm:grid-cols-2">
        <UFormField label="Date format" required>
          <USelect v-model="draft.date_format" :items="dateFormats" placeholder="Choose the export's date format" aria-label="Date format" class="w-full" @update:model-value="invalidate" />
        </UFormField>
        <UFormField label="Decimal format" required>
          <USelect v-model="draft.decimal_format" :items="decimalFormats" placeholder="Choose the export's decimal format" aria-label="Decimal format" class="w-full" @update:model-value="invalidate" />
        </UFormField>
      </div>
      <div class="space-y-5">
        <UFormField v-for="field in requiredFields" :key="field" :label="MIGRATION_FIELD_LABELS[field]" :required="field === 'source_id' || field === 'source_listing'">
          <USelect :model-value="draft.columns[field] || unmappedColumn" :items="columnItems" :aria-label="MIGRATION_FIELD_LABELS[field]" class="w-full" @update:model-value="setColumn(field, String($event))" />
        </UFormField>
      </div>
      <details class="rounded-xl border border-default p-4">
        <summary class="cursor-pointer font-medium text-highlighted">Additional details and payment receipts</summary>
        <div class="mt-5 space-y-5">
          <UFormField v-for="field in optionalFields" :key="field" :label="MIGRATION_FIELD_LABELS[field]">
            <USelect :model-value="draft.columns[field] || unmappedColumn" :items="columnItems" :aria-label="MIGRATION_FIELD_LABELS[field]" class="w-full" @update:model-value="setColumn(field, String($event))" />
          </UFormField>
        </div>
      </details>
      <p class="text-sm text-muted">Suggested column matches are shown for you to confirm. Missing values stay unresolved. Paid stays need the actual amount received, payment date and payment method before import. Changing the reservation ID or property column clears home matches, blocked dates and source corrections so you can review them again.</p>
    </div>

    <div v-else-if="openKey === 'homes'" class="space-y-8">
      <p class="text-sm text-muted">Compare every Hostaway home's calendar, including homes absent from this export. These checks cover only the homes and records you include here.</p>
      <UAlert v-if="!draft.columns.source_listing" color="warning" variant="soft" description="Choose the Hostaway property column before matching your homes." />
      <UAlert v-else-if="preview && !preview.source_listings.length" color="neutral" variant="soft" description="No properties have current or future reservation rows. Select any homes with manual closures below." />
      <div v-for="source in preview?.source_listings ?? []" :key="source" class="space-y-3 border-b border-default pb-6">
        <UFormField :label="source" required>
          <USelect :model-value="ownHome(source)" :items="homeItems" placeholder="Choose the matching KrabiClaw home" :aria-label="`KrabiClaw home for ${source}`" class="w-full" @update:model-value="setHome(source, String($event))" />
        </UFormField>
        <p v-if="mappedHome(source)" class="text-sm text-muted">{{ mappedHome(source)!.timezone }} · {{ mappedHome(source)!.currency }}</p>
      </div>
      <UFormField label="Other homes with manual blocked dates" description="Include homes missing from the reservation export if their Hostaway calendars have closures to move.">
        <USelect :model-value="draft.additional_homes" :items="additionalHomeItems" multiple placeholder="Choose any other homes to review" aria-label="Other homes with manual blocked dates" class="w-full" @update:model-value="setAdditionalHomes($event)" />
      </UFormField>
      <div v-for="home in mappedHomes" :key="home.product_id" class="space-y-5 rounded-xl border border-default p-5">
        <h2 class="text-lg font-semibold text-highlighted">{{ home.name }}: manual blocked dates</h2>
        <p class="text-sm text-muted">Check this home's Hostaway calendar for maintenance, owner stays and other blocked dates. Add any closures that are not reservations in the export.</p>
        <div v-for="block in blocksFor(home.product_id)" :key="block.index" class="space-y-4 border-t border-default pt-4">
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Blocked from" required><UInput v-model="block.value.from" type="date" aria-label="Blocked from" class="w-full" @update:model-value="invalidate" /></UFormField>
            <UFormField label="First available date" required><UInput v-model="block.value.to" type="date" :min="block.value.from || undefined" aria-label="First available date" class="w-full" @update:model-value="invalidate" /></UFormField>
          </div>
          <UFormField label="Reason"><UInput v-model="block.value.note" aria-label="Block reason" class="w-full" @update:model-value="invalidate" /></UFormField>
          <UButton label="Remove blocked dates" color="neutral" variant="link" @click="removeBlock(block.index)" />
        </div>
        <UButton label="Add blocked dates" icon="i-lucide-plus" color="neutral" variant="outline" @click="addBlock(home.product_id)" />
        <UCheckbox :model-value="draft.blocks_reviewed.includes(home.product_id)" :label="`I checked ${home.name}'s manual blocks and included every missing closure.`" @update:model-value="reviewBlocks(home.product_id, Boolean($event))" />
      </div>
      <UButton v-if="context && !context.homes.length" :to="airbnbPath" label="Open Airbnb sync" color="neutral" variant="outline" />
    </div>

    <div v-else-if="openKey === 'review'" class="space-y-6">
      <template v-if="preview">
        <div class="grid grid-cols-2 gap-3">
          <div v-for="stat in counts" :key="stat.label" class="rounded-xl bg-elevated p-4"><span class="block text-2xl font-semibold text-highlighted">{{ stat.count }}</span><span class="text-sm text-muted">{{ stat.label }}</span></div>
        </div>
        <UAlert v-if="dirty" color="warning" variant="soft" description="You changed the source details. Update the preview before importing." />
        <UAlert v-for="issue in preview.issues" :key="issue" color="warning" variant="soft" :description="issue" />
        <p class="text-sm text-muted">Confirmed unpaid stays still occupy their nights. Existing channel bookings are checked by confirmation code. The import does not send a new-booking confirmation or collect payment. Your check-in and checkout message schedules still apply; review your arrival instructions before importing.</p>
        <div v-if="draft.blocks.length" class="space-y-3 rounded-xl border border-default p-4">
          <h2 class="font-semibold text-highlighted">Manual blocked dates to move</h2>
          <p v-for="(block, index) in draft.blocks" :key="index" class="text-sm text-muted">{{ targetName(block.product_id) }} · {{ block.from }} → {{ block.to }} (first available)<template v-if="block.note"> · {{ block.note }}</template></p>
        </div>
        <div v-for="row in preview.rows" :key="row.row_number" class="rounded-xl border border-default p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0"><p class="font-medium text-highlighted">{{ row.stay?.guest_name || row.source.guest_name || `Row ${row.row_number}` }}</p><p class="mt-1 text-sm text-muted">{{ row.source_listing }} → {{ targetName(row.product_id) }} · {{ row.source_id || 'Missing reservation ID' }}</p><p v-if="row.stay" class="mt-1 text-sm text-muted">{{ row.stay.check_in_date }} → {{ row.stay.check_out_date }} · {{ row.stay.currency }} {{ amount(row.stay.total_minor, row.stay.currency) }} · {{ row.stay.payment_status }}</p></div>
            <UBadge :color="row.state === 'needs_attention' ? 'warning' : row.state === 'skipped' ? 'neutral' : 'success'" variant="soft" :label="rowLabel(row.state)" />
          </div>
          <p v-if="row.skip_reason" class="mt-3 text-sm text-muted">{{ row.skip_reason }}</p>
          <ul v-if="row.issues.length" class="mt-3 list-disc space-y-1 ps-5 text-sm text-error"><li v-for="issue in row.issues" :key="issue">{{ issue }}</li></ul>
          <UButton v-if="row.existing_stay_id" :to="stayPath(row.existing_stay_id)" label="View existing stay" color="neutral" variant="link" class="mt-2" />
          <details v-if="row.state === 'needs_attention' && row.source_id" class="mt-4 border-t border-default pt-4">
            <summary class="cursor-pointer font-medium">Correct this reservation's source details</summary>
            <p class="mt-3 text-sm text-muted">Enter only values you can confirm from the original record. Property and reservation identity stay fixed; resolve overlapping bookings in their own records.</p>
            <div class="mt-4 grid gap-4 sm:grid-cols-2">
              <UFormField v-for="field in correctionFields" :key="field" :label="MIGRATION_FIELD_LABELS[field]">
                <USelect v-if="field === 'payment_method'" :model-value="overrideValue(row.source_id, field) || 'source'" :items="paymentMethods" :aria-label="`${MIGRATION_FIELD_LABELS[field]} for ${row.source_id}`" class="w-full" @update:model-value="editRow(row.source_id, field, $event === 'source' ? '' : String($event))" />
                <UInput v-else :model-value="overrideValue(row.source_id, field) ?? ''" :placeholder="row.source[field] || undefined" :aria-label="`${MIGRATION_FIELD_LABELS[field]} for ${row.source_id}`" class="w-full" @update:model-value="editRow(row.source_id, field, String($event ?? ''))" />
              </UFormField>
            </div>
          </details>
        </div>
      </template>
      <p v-else class="text-muted">Upload an export and match its columns and homes to build your preview.</p>
      <div v-if="receipt" class="space-y-3 border-t border-default pt-6">
        <h2 class="text-lg font-semibold">Import results</h2>
        <p class="text-sm text-muted">{{ receipt.imported }} imported · {{ receipt.existing }} already here · {{ receipt.remaining }} remaining · {{ receipt.failed }} failed</p>
        <div v-for="outcome in receipt.outcomes" :key="outcome.source_id" class="rounded-xl border border-default p-4 text-sm">
          <p class="font-medium" :class="outcome.state === 'failed' ? 'text-error' : 'text-highlighted'">{{ outcome.source_id }} · {{ outcome.state === 'failed' && outcome.committed ? 'Saved; needs attention' : outcomeLabels[outcome.state] }}</p>
          <p v-if="outcome.detail" class="mt-1 text-muted">{{ outcome.detail }}</p>
          <UButton v-if="outcome.stay_id" :to="stayPath(outcome.stay_id)" label="View saved stay" color="neutral" variant="link" />
        </div>
        <p v-for="block in receipt.blocks" :key="`${block.product_id}:${block.from}`" class="text-sm" :class="block.state === 'failed' ? 'text-error' : 'text-muted'">{{ block.from }}–{{ block.to }} · {{ block.state === 'saved' ? 'Closed dates saved' : block.state === 'pending' ? 'Waiting to save' : block.committed ? 'Saved; needs attention' : 'Not saved' }}<template v-if="block.detail">: {{ block.detail }}</template></p>
      </div>
    </div>

    <div v-else class="space-y-6">
      <UAlert v-if="!receipt" color="warning" variant="soft" description="Import your reviewed stays before checking the handover. Upload the same export to resume a previous import." />
      <UAlert v-else-if="dirty" color="warning" variant="soft" description="Your source details changed. Return to Review your move and update the preview before checking calendars." />
      <UAlert v-else-if="!importComplete" color="warning" variant="soft" description="Some records are unfinished or still need delivery. Return to Review your move and retry the import before checking the handover." />
      <template v-else>
        <p class="text-base text-highlighted">{{ receipt.imported }} stays imported · {{ receipt.existing }} already here · {{ receipt.remaining }} remaining · {{ receipt.failed }} failed</p>
        <UAlert v-if="!verification" color="neutral" variant="soft" title="Calendar checks are still required" description="Saved stays and closures must be checked against connected calendars before you reopen." />
        <template v-else>
          <UAlert :color="verification.state === 'verified' ? 'success' : 'warning'" variant="soft" :title="verification.state === 'verified' ? 'Occupied dates are protected' : 'The handover needs attention'" :description="verification.state === 'verified' ? 'KrabiClaw read the imported stays and checked the covered dates on connected Airbnb calendars.' : 'Keep affected listings paused while you resolve the items below.'" />
          <ul v-if="verification.issues.length" class="list-disc space-y-2 ps-5 text-sm text-error"><li v-for="issue in verification.issues" :key="issue">{{ issue }}</li></ul>
          <div v-for="home in verification.homes" :key="home.product_id" class="space-y-2 rounded-xl border border-default p-4">
            <p class="font-medium text-highlighted">{{ home.name }}</p>
            <p class="text-sm text-muted">{{ home.checked_dates.length }} dates checked · {{ home.unverified_dates.length }} dates not verified</p>
            <p v-if="home.detail" class="text-sm text-muted">{{ home.detail }}</p>
            <details v-if="home.unverified_dates.length" class="text-sm text-muted"><summary class="cursor-pointer font-medium">Dates still needing verification</summary><p class="mt-2 break-words">{{ home.unverified_dates.join(', ') }}</p></details>
            <ul v-if="home.mismatches.length" class="list-disc space-y-1 ps-5 text-sm text-error"><li v-for="mismatch in home.mismatches" :key="mismatch">{{ mismatch }}</li></ul>
          </div>
          <template v-if="verification.state === 'verified'">
            <p class="text-sm text-muted">Review your arrival instructions and any overlapping reservations. When you are ready, reopen the listings in Airbnb and confirm the handover below.</p>
            <UButton to="https://www.airbnb.com/hosting/listings" target="_blank" external label="Open Airbnb listings" color="neutral" variant="outline" icon="i-lucide-external-link" />
            <UCheckbox v-model="unpaused" label="I've reviewed the handover and reopened the listings I want to accept bookings." />
            <UAlert v-if="unpaused" color="success" variant="soft" title="Checks complete for these homes and records" description="KrabiClaw now holds these stays and blocked dates. Keep the source export with your records." />
          </template>
        </template>
      </template>
    </div>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { migrationKey } from '../hostaway-migration.vue'
import { MIGRATION_FIELDS, MIGRATION_REQUIRED_FIELDS, MIGRATION_FIELD_LABELS, type MigrationField, type MigrationRow } from '~/shared/stay-migration'
import { formatMinorAmount } from '~/shared/prices'
definePageMeta({ layout: 'dashboard' })
const migration = inject(migrationKey)
if (!migration) throw createError({ statusCode: 500, message: 'The migration task is not available.' })
const { draft, context, preview, receipt, verification, openKey, labels, base, busy, error, unpaused, dirty, importComplete, saveLabel, disabled, save, readFile, invalidate, editRow } = migration
const route = useRoute()
const order = ['upload', 'columns', 'homes', 'review', 'verify'] as const
if (!order.includes(route.params.step as typeof order[number])) throw createError({ statusCode: 404, message: 'Migration step not found.' })
const previous = computed(() => order[order.indexOf(openKey.value) - 1])
const lead = computed(() => ({ upload: 'Keep existing occupancy protected while you move.', columns: 'Confirm which export columns describe each reservation.', homes: 'Match each property explicitly and account for manual closures.', review: 'Check every stay before it changes your calendar.', verify: 'Saved records and verified channel availability are separate checks.' })[openKey.value])
const dateFormats = [{ label: 'Year-month-day · 2026-11-04', value: 'iso' }, { label: 'Month/day/year · 11/04/2026', value: 'mdy' }, { label: 'Day/month/year · 04/11/2026', value: 'dmy' }]
const decimalFormats = [{ label: 'Decimal point · 3700.00', value: 'dot' }, { label: 'Decimal comma · 3700,00', value: 'comma' }]
const unmappedColumn = computed(() => { let value = '__unmapped__'; while (preview.value?.headers.includes(value)) value += '_'; return value })
const columnItems = computed(() => [{ label: 'Not in this export', value: unmappedColumn.value }, ...(preview.value?.headers ?? []).map(value => ({ label: value, value }))])
const requiredFields = MIGRATION_REQUIRED_FIELDS
const optionalFields = MIGRATION_FIELDS.filter(field => !MIGRATION_REQUIRED_FIELDS.includes(field))
const correctionFields = MIGRATION_FIELDS.filter(field => !['source_id', 'source_listing'].includes(field))
const paymentMethods = [{ label: 'Use the export value', value: 'source' }, { label: 'Cash', value: 'cash' }, { label: 'Bank transfer', value: 'bank_transfer' }, { label: 'Card received elsewhere', value: 'card_external' }, { label: 'Other', value: 'other' }]
const homeItems = computed(() => (context.value?.homes ?? []).map(home => ({ label: home.name, value: home.product_id })))
const additionalHomeItems = computed(() => homeItems.value.filter(home => !Object.values(draft.value.homes).includes(home.value)))
const mappedHomes = computed(() => (context.value?.homes ?? []).filter(home => [...Object.values(draft.value.homes), ...draft.value.additional_homes].includes(home.product_id)))
const ownHome = (source: string) => Object.hasOwn(draft.value.homes, source) ? draft.value.homes[source] : undefined
const mappedHome = (source: string) => context.value?.homes.find(home => home.product_id === ownHome(source))
const targetName = (productId: string | null) => context.value?.homes.find(home => home.product_id === productId)?.name ?? 'Unmatched home'
const overrideValue = (sourceId: string, field: MigrationField) => draft.value.overrides && Object.hasOwn(draft.value.overrides, sourceId) ? draft.value.overrides[sourceId]?.[field] : undefined
const blocksFor = (productId: string) => draft.value.blocks.map((value, index) => ({ value, index })).filter(block => block.value.product_id === productId)
function setHome(source: string, productId: string) {
  draft.value.homes = { ...draft.value.homes, [source]: productId }
  draft.value.additional_homes = draft.value.additional_homes.filter(id => !Object.values(draft.value.homes).includes(id))
  pruneTargets()
  invalidate()
}
function setAdditionalHomes(ids: unknown) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Choose homes from the available list.')
  draft.value.additional_homes = ids
  pruneTargets()
  invalidate()
}
function pruneTargets() {
  const selected = new Set([...Object.values(draft.value.homes), ...draft.value.additional_homes])
  draft.value.blocks = draft.value.blocks.filter(block => selected.has(block.product_id))
  draft.value.blocks_reviewed = draft.value.blocks_reviewed.filter(id => selected.has(id))
}
function setColumn(field: MigrationField, value: string) {
  const column = value === unmappedColumn.value ? '' : value
  if (draft.value.columns[field] === column) return
  draft.value.columns[field] = column
  if (field === 'source_id' || field === 'source_listing') {
    draft.value.homes = {}; draft.value.overrides = {}; draft.value.blocks = []; draft.value.blocks_reviewed = []; draft.value.additional_homes = []
    receipt.value = null
  }
  invalidate()
}
function addBlock(productId: string) { draft.value.blocks.push({ product_id: productId, from: '', to: '', note: '' }); draft.value.blocks_reviewed = draft.value.blocks_reviewed.filter(id => id !== productId); invalidate() }
function removeBlock(index: number) { const productId = draft.value.blocks[index]!.product_id; draft.value.blocks.splice(index, 1); draft.value.blocks_reviewed = draft.value.blocks_reviewed.filter(id => id !== productId); invalidate() }
function reviewBlocks(productId: string, checked: boolean) { draft.value.blocks_reviewed = draft.value.blocks_reviewed.filter(id => id !== productId); if (checked) draft.value.blocks_reviewed.push(productId); invalidate() }
const counts = computed(() => [{ label: 'Ready to import', count: preview.value?.counts.ready ?? 0 }, { label: 'Already in KrabiClaw', count: preview.value?.counts.existing ?? 0 }, { label: 'Need attention', count: preview.value?.counts.needs_attention ?? 0 }, { label: 'Skipped with a reason', count: preview.value?.counts.skipped ?? 0 }])
const rowLabel = (state: MigrationRow['state']) => ({ ready: 'Ready', existing: 'Already here', skipped: 'Skipped', needs_attention: 'Needs attention' })[state]
const outcomeLabels = { imported: 'Imported', existing: 'Already here', skipped: 'Skipped', failed: 'Not saved', pending: 'Waiting to import' }
const amount = (minor: number, currency: string) => formatMinorAmount(minor, currency)
const airbnbPath = computed(() => `/dashboard/${String(route.params.orgSlug)}/integrations/airbnb`)
const stayPath = (id: string) => `/dashboard/${String(route.params.orgSlug)}/bookings/stay/${id}`
</script>
