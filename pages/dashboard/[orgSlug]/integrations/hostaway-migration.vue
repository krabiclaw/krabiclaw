<template>
  <DashboardIndexPanel id="hostaway-migration" title="Migrate from Hostaway" :create="context ? walk.firstStep.value : null" lead="Move existing stays and blocked dates, then check your connected calendars.">
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(loadError, 'Could not load your homes.')" class="mb-6" />
    <template v-else-if="context">
      <p class="mb-6 text-base text-muted">This is a one-time move using your export. Your Hostaway account stays private.</p>
      <EditorNavigationList :groups="[{ id: 'migration', items: stepItems }]" :active-item="openKey" :inert="busy" />
      <div v-if="context.recent_import" class="mt-8 border-t border-default pt-6 text-sm text-muted">
        <p class="font-medium text-highlighted">Previous import</p>
        <p class="mt-2">{{ context.recent_import.receipt.imported }} imported · {{ context.recent_import.receipt.existing }} already here · {{ context.recent_import.receipt.failed }} need attention</p>
        <p class="mt-2">Upload the same export to resume. Existing stays are checked before anything is added.</p>
      </div>
    </template>
    <p v-else class="text-muted" role="status">Loading your homes…</p>
  </DashboardIndexPanel>
</template>

<script lang="ts">
import type { InjectionKey, Ref, ComputedRef } from 'vue'
import { isMigrationContext, isMigrationPreview, isMigrationReceipt, isMigrationVerification, MIGRATION_MAX_CSV_BYTES, type MigrationField, type MigrationContext, type MigrationDateFormat, type MigrationDecimalFormat, type MigrationInput, type MigrationPreview, type MigrationReceipt, type MigrationVerification } from '~/shared/stay-migration'
export type MigrationStep = 'upload' | 'columns' | 'homes' | 'review' | 'verify'
export type MigrationDraft = Omit<MigrationInput, 'date_format' | 'decimal_format'> & { date_format: MigrationDateFormat | ''; decimal_format: MigrationDecimalFormat | ''; filename: string; paused: boolean; additional_homes: string[] }
export const migrationKey = Symbol('hostaway-migration') as InjectionKey<{
  draft: Ref<MigrationDraft>; context: Ref<MigrationContext | undefined>; preview: Ref<MigrationPreview | null>; receipt: Ref<MigrationReceipt | null>; verification: Ref<MigrationVerification | null>
  openKey: ComputedRef<MigrationStep>; labels: Record<MigrationStep, string>; base: ComputedRef<string>; busy: Ref<boolean>; error: Ref<string>; unpaused: Ref<boolean>; dirty: ComputedRef<boolean>; importComplete: ComputedRef<boolean>; saveLabel: ComputedRef<string>; disabled: ComputedRef<boolean>
  save: () => Promise<void>; readFile: (event: Event) => Promise<void>; invalidate: () => void; editRow: (sourceId: string, field: string, value: string) => void
}>
</script>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
definePageMeta({ layout: 'dashboard', key: route => `hostaway-migration:${route.params.orgSlug}` })
useSeoMeta({ title: 'Migrate from Hostaway | KrabiClaw', robots: 'noindex, nofollow' })
const route = useRoute()
const orgSlug = String(route.params.orgSlug)
const dashboardApi = useDashboardApi(computed(() => ({ orgSlug })))
const base = computed(() => `/dashboard/${String(route.params.orgSlug)}/integrations/hostaway-migration`)
const labels: Record<MigrationStep, string> = { upload: 'Your Hostaway export', columns: 'Match the columns', homes: 'Homes and blocked dates', review: 'Review your move', verify: 'Check your calendars' }
const steps: MigrationStep[] = ['upload', 'columns', 'homes', 'review', 'verify']
const openKey = computed<MigrationStep>(() => steps.includes(route.params.step as MigrationStep) ? route.params.step as MigrationStep : 'upload')
const blank = (): MigrationDraft => ({ csv: '', columns: {}, homes: {}, blocks: [], blocks_reviewed: [], overrides: {}, date_format: '', decimal_format: '', filename: '', paused: false, additional_homes: [] })
const draft = useState<MigrationDraft>(`hostaway-migration:${String(route.params.orgSlug)}`, blank)
const preview = ref<MigrationPreview | null>(null)
const receipt = ref<MigrationReceipt | null>(null)
const verification = ref<MigrationVerification | null>(null)
const unpaused = ref(false)
let active = true
const busy = ref(false)
const error = ref('')
const confirmedColumns = ref(false)
const confirmedHomes = ref(false)
const lastPreview = ref('')
const { data: context, error: loadError } = await useAsyncData(
  () => `hostaway-migration-context:${String(route.params.orgSlug)}`,
  () => dashboardApi('/api/dashboard/stays/migration', { validate: isMigrationContext }),
)
const input = computed(() => ({ csv: draft.value.csv, columns: draft.value.columns, homes: draft.value.homes, blocks: draft.value.blocks, blocks_reviewed: draft.value.blocks_reviewed, overrides: draft.value.overrides, date_format: draft.value.date_format, decimal_format: draft.value.decimal_format }))
const signature = computed(() => JSON.stringify(input.value))
const dirty = computed(() => signature.value !== lastPreview.value)
const importComplete = computed(() => Boolean(receipt.value) && receipt.value!.failed === 0 && !receipt.value!.has_more && receipt.value!.remaining === 0 && !receipt.value!.outcomes.some(outcome => ['failed', 'pending'].includes(outcome.state) || outcome.completion_pending) && receipt.value!.blocks.every(block => block.state === 'saved'))
const mappingsReady = computed(() => Boolean(preview.value) && (preview.value!.source_listings.length > 0 || draft.value.additional_homes.length > 0) && preview.value!.source_listings.every(source => Object.hasOwn(draft.value.homes, source) && Boolean(draft.value.homes[source])))
const manualBlocksReady = computed(() => mappingsReady.value && [...new Set([...Object.values(draft.value.homes), ...draft.value.additional_homes])].every(id => draft.value.blocks_reviewed.includes(id)))
const walk = useCreateWalk({
  recordPath: base, isNew: computed(() => true), openKey, labels, order: ['upload', 'columns', 'homes', 'review'] as const, noun: 'migration', saving: busy,
  missing: key => key === 'upload' ? !draft.value.csv || !draft.value.paused : key === 'columns' ? !confirmedColumns.value : key === 'homes' ? !confirmedHomes.value : !preview.value?.can_import,
  commit: async () => { busy.value = true; try { await importStays() } finally { busy.value = false } },
})
const stepItems = computed<EditorNavigationItem[]>(() => steps.map(key => ({
  id: key, label: labels[key], to: `${base.value}/${key}`, mark: (key === 'upload' && draft.value.csv && draft.value.paused) || (key === 'columns' && confirmedColumns.value) || (key === 'homes' && confirmedHomes.value) || (key === 'review' && importComplete.value) || (key === 'verify' && verification.value?.state === 'verified' && unpaused.value) ? 'met' : 'open',
})))
const saveLabel = computed(() => openKey.value === 'verify' ? 'Check calendars again' : openKey.value === 'review' ? dirty.value || !preview.value?.can_import ? 'Update preview' : receipt.value?.failed ? 'Retry import' : 'Import stays' : `Next: ${labels[steps[steps.indexOf(openKey.value) + 1]!]}`)
const disabled = computed(() => busy.value || Boolean(loadError.value) || !context.value || (openKey.value === 'upload' ? !draft.value.csv || !draft.value.paused : openKey.value === 'columns' ? !draft.value.columns.source_id || !draft.value.columns.source_listing || !draft.value.date_format || !draft.value.decimal_format : openKey.value === 'homes' ? !manualBlocksReady.value : openKey.value === 'review' ? !preview.value : !importComplete.value || dirty.value))

function invalidate() {
  verification.value = null
  unpaused.value = false
  if (openKey.value === 'columns') { confirmedColumns.value = false; confirmedHomes.value = false }
  if (openKey.value === 'homes') confirmedHomes.value = false
}
function editRow(sourceId: string, field: string, value: string) {
  const previous = draft.value.overrides && Object.hasOwn(draft.value.overrides, sourceId) ? draft.value.overrides[sourceId]! : {}
  const fields = value ? { ...previous, [field as MigrationField]: value } : Object.fromEntries(Object.entries(previous).filter(([key]) => key !== field))
  draft.value.overrides = { ...draft.value.overrides, [sourceId]: fields }
  invalidate()
}
async function refreshPreview() {
  const response = await dashboardApi('/api/dashboard/stays/migration/preview', { method: 'POST', body: input.value, validate: isMigrationPreview })
  if (active) { preview.value = response; lastPreview.value = signature.value }
  return response
}
async function readFile(event: Event) {
  error.value = ''
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  draft.value = blank()
  preview.value = null; lastPreview.value = ''
  receipt.value = null; verification.value = null; unpaused.value = false
  confirmedColumns.value = false; confirmedHomes.value = false
  if (file.size > MIGRATION_MAX_CSV_BYTES) { error.value = `Choose a CSV file no larger than ${MIGRATION_MAX_CSV_BYTES / 1_000_000} MB.`; return }
  busy.value = true
  try {
    const csv = await file.text()
    if (!active) return
    draft.value = { ...blank(), csv, filename: file.name }
    const first = await refreshPreview()
    if (!active) return
    draft.value.columns = { ...first.suggested_columns }
    await refreshPreview()
  } catch (cause) { error.value = getErrorMessage(cause, 'The export could not be read.') }
  finally { busy.value = false }
}
async function importStays() {
  const payload = { ...(JSON.parse(signature.value) as MigrationInput), fingerprint: preview.value!.fingerprint }
  const importedIds = new Set<string>()
  let previousRemaining: number | null = null
  verification.value = null; unpaused.value = false
  while (active) {
    const result = await dashboardApi('/api/dashboard/stays/migration/import', { method: 'POST', body: payload, validate: isMigrationReceipt })
    if (!active) return
    for (const outcome of result.outcomes) if (outcome.state === 'imported') importedIds.add(outcome.source_id)
    receipt.value = { ...result, imported: importedIds.size, existing: result.outcomes.filter(outcome => outcome.state === 'existing' && !importedIds.has(outcome.source_id)).length }
    if (result.failed || result.blocks.some(block => block.state === 'failed')) {
      error.value = 'Some records need attention. Saved stays are retained; update the preview before retrying.'
      await refreshPreview()
      return
    }
    if (!result.has_more) break
    const progressed = result.outcomes.some(outcome => outcome.committed && ['imported', 'existing'].includes(outcome.state) && !outcome.completion_pending) || result.blocks.some(block => block.state === 'saved' && block.committed)
    if (!progressed || (previousRemaining !== null && result.remaining >= previousRemaining)) throw new Error('The remaining records could not advance. Saved records are retained; resolve the reported delivery issues and retry the import.')
    previousRemaining = result.remaining
  }
  if (!active) return
  if (!importComplete.value) { error.value = 'Some imported records still need delivery. Return to this review and retry the import before checking the handover.'; await refreshPreview(); return }
  await navigateTo(`${base.value}/verify`)
  await checkCalendars()
}
async function checkCalendars() {
  if (!importComplete.value) throw new Error('Finish or retry the incomplete import from Review your move before checking the handover.')
  verification.value = null; unpaused.value = false
  const payload = { ...(JSON.parse(signature.value) as MigrationInput), fingerprint: preview.value!.fingerprint }
  const allIds = [...new Set([...Object.values(payload.homes), ...payload.blocks_reviewed, ...payload.blocks.map(block => block.product_id)])].sort()
  const checked = new Map<string, MigrationVerification['homes'][number]>()
  const issues = new Set<string>()
  for (let offset = 0; offset < allIds.length && active; offset += 5) {
    const result = await dashboardApi('/api/dashboard/stays/migration/verify', { method: 'POST', body: { ...payload, product_ids: allIds.slice(offset, offset + 5) }, validate: isMigrationVerification })
    if (!active) return
    if (result.fingerprint !== payload.fingerprint || JSON.stringify([...result.all_product_ids].sort()) !== JSON.stringify(allIds)) throw new Error('The verification scope changed. Update your preview and check the calendars again.')
    for (const home of result.homes) checked.set(home.product_id, home)
    for (const issue of result.issues) issues.add(issue)
    const complete = allIds.every(id => checked.has(id))
    const homes = allIds.flatMap(id => checked.has(id) ? [checked.get(id)!] : [])
    verification.value = { ...result, homes, issues: [...issues], product_ids: homes.map(home => home.product_id), scope_complete: complete, state: complete && issues.size === 0 && homes.every(home => home.state === 'verified' && home.unverified_dates.length === 0 && home.mismatches.length === 0) ? 'verified' : 'needs_attention' }
  }
}
async function save() {
  if (disabled.value) return
  error.value = ''
  try {
    if (openKey.value === 'review' && !dirty.value && preview.value?.can_import) { await walk.save(); return }
    busy.value = true
    if (openKey.value === 'verify') { await checkCalendars(); return }
    if (openKey.value === 'upload') { await refreshPreview(); if (active) await navigateTo(`${base.value}/columns`); return }
    if (openKey.value === 'columns') { await refreshPreview(); if (active) { confirmedColumns.value = true; await navigateTo(`${base.value}/homes`) }; return }
    if (openKey.value === 'homes') { await refreshPreview(); if (active) { confirmedHomes.value = true; await navigateTo(`${base.value}/review`) }; return }
    if (dirty.value || !preview.value?.can_import) { await refreshPreview(); return }
    await walk.save()
  } catch (cause) { error.value = getErrorMessage(cause, 'The migration could not be completed.') }
  finally { busy.value = false }
}
provide(migrationKey, { draft, context, preview, receipt, verification, openKey, labels, base, busy, error, unpaused, dirty, importComplete, saveLabel, disabled, save, readFile, invalidate, editRow })
onBeforeUnmount(() => { active = false; draft.value = blank() })
</script>
