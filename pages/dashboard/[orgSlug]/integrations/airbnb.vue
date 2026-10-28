<template>
  <DashboardLeafPanel
    id="integration-airbnb"
    icon="i-simple-icons-airbnb"
    title="Airbnb sync"
    :lead="integrationDefinition('airbnb').purpose"
    :error="panelError"
    :footer="Boolean(applyLabel)"
    :save-label="applyLabel"
    :saving="applying"
    :disabled="pending || resolving.size > 0"
    @save="apply"
  >
    <!-- The sync is Business. A connection made under a lapsed plan, in whatever state, can still be disconnected. -->
    <OfferCard v-if="!entitled && (!status || status.status === 'not_connected')" :offer="offer('airbnb_sync')" />
    <IntegrationLeaf
      v-else
      v-model:selected="checked"
      integration="airbnb"
      :connection="connection"
      :disconnecting="disconnecting"
      :items="connected ? rows : null"
      items-title="Choose listings to sync"
      items-lead="Checked listings keep their calendar, prices and guest messages in sync with Airbnb and take bookings on your site. Uncheck one any time to stop; it stays here as a free draft."
      :items-loading="listingsPending"
      :items-error="listingsError ? getErrorMessage(listingsError, 'Could not load your Airbnb listings.') : null"
      items-empty="Airbnb returned no listings for this account. Check that you connected your hosting account."
      :items-status="itemsStatus"
      :applying="applying || pending"
      @choose="choose"
      @act="addDetails"
      @retry-failed="retryFailed"
      @disconnect="disconnect"
    >
      <div v-if="!connection" class="space-y-4">
        <p class="text-sm text-muted">
          Connect your Airbnb host account to sync listings, availability, rates, and guest messages directly to your dashboard.
        </p>
        <UButton icon="i-simple-icons-airbnb" size="xl" block :loading="starting" @click="startConnection">Connect Airbnb</UButton>
        <p class="text-center text-xs text-dimmed">You can also connect and sync directly within the KrabiClaw app on iOS.</p>
      </div>
    </IntegrationLeaf>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import IntegrationLeaf, { type IntegrationLeafConnection, type IntegrationLeafItem, type IntegrationLeafItemsStatus } from '~/components/dashboard/IntegrationLeaf.vue'
import AirbnbListingDetailsDialog, { type AirbnbListingDetails } from '~/components/dashboard/AirbnbListingDetailsDialog.vue'
import OfferCard from '~/components/dashboard/OfferCard.vue'
import { integrationDefinition, itemsApplyLabel } from '~/shared/integrations'
import { IMPORT_STAGES, importStageTitle, isInterruptedStage, type ImportStage } from '~/shared/airbnb-import'
import { offer } from '~/shared/offers'
import { getErrorMessage } from '~/utils/errors'
import { integrationsKey } from '../integrations.vue'

definePageMeta({ layout: 'dashboard' })

/*
  The Airbnb sync checklist, as the iOS app has it: every listing on the
  connected account, checked when it syncs with KrabiClaw. Checking one brings
  it over and turns its sync on; unchecking stops the sync and keeps the home
  as a free draft. The changes apply together from one button, after the plan
  check, and KrabiClaw runs them in the background (sync.post, then sync.get
  until nothing is waiting). A listing Airbnb left details out of gets them in
  its own dialog first.
*/
interface AirbnbStatus {
  status: 'not_connected' | 'authorizing' | 'connected' | 'disconnecting' | 'needs_review'
  connected_at: string | null
  listing_count: number
  channel_active: boolean
}

type ListingImport = { status: 'not_imported' } | { status: 'imported'; product_id: string; stage: ImportStage; syncing: boolean }
interface AirbnbListing { id: string; title: string; city: string; country_code: string; import: ListingImport }

interface SyncChange {
  listing_id: string
  product_id: string | null
  action: 'sync' | 'stop'
  status: 'queued' | 'running' | 'done' | 'failed'
  stage: ImportStage | null
  error: { code: string; message: string } | null
}

const integrations = inject(integrationsKey)!
const route = useRoute()
const dashboardApi = useDashboardApi()
const dashboard = useDashboardOrganization()
const entitled = computed(() => dashboard.entitlements.value.channel_sync === true)
const api = `/api/organizations/${integrations.organizationId}/integrations/airbnb`
const detailsDialog = useOverlay().create(AirbnbListingDetailsDialog)

const isStage = (value: unknown): value is ImportStage => typeof value === 'string' && (IMPORT_STAGES as readonly string[]).includes(value)
const isStatus = (value: unknown): value is AirbnbStatus =>
  isRecord(value) && ['not_connected', 'authorizing', 'connected', 'disconnecting', 'needs_review'].includes(String(value.status))
  && (value.connected_at === null || typeof value.connected_at === 'string') && typeof value.listing_count === 'number'
const isListing = (value: unknown): value is AirbnbListing =>
  isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string' && isRecord(value.import)
  && (value.import.status === 'not_imported' || (value.import.status === 'imported' && typeof value.import.product_id === 'string' && isStage(value.import.stage) && typeof value.import.syncing === 'boolean'))
const isListings = (value: unknown): value is { listings: AirbnbListing[] } => isRecord(value) && Array.isArray(value.listings) && value.listings.every(isListing)
const isChange = (value: unknown): value is SyncChange =>
  isRecord(value) && typeof value.listing_id === 'string' && (value.action === 'sync' || value.action === 'stop')
  && ['queued', 'running', 'done', 'failed'].includes(String(value.status)) && (value.stage === null || isStage(value.stage))
  && (value.error === null || (isRecord(value.error) && typeof value.error.message === 'string'))
  && (value.status !== 'failed' || value.error !== null)
const isChanges = (value: unknown): value is { listings: SyncChange[] } => isRecord(value) && Array.isArray(value.listings) && value.listings.every(isChange)
const isDetails = (value: unknown): value is AirbnbListingDetails =>
  isRecord(value) && typeof value.currency === 'string' && typeof value.maxGuests === 'number' && typeof value.nightlyRate === 'string'
  && Array.isArray(value.missingFields) && ['checkInTime', 'checkInEndTime', 'checkOutTime'].every(key => value[key] === null || typeof value[key] === 'string')
const isStart = (value: unknown): value is { authorization_url: string } => isRecord(value) && typeof value.authorization_url === 'string'
const isDisconnect = (value: unknown): value is { disconnected: boolean } => isRecord(value) && typeof value.disconnected === 'boolean'

const { data: status, error: statusError, refresh: refreshStatus } = await useAsyncData(
  () => `integration-airbnb-status:${integrations.organizationId}`,
  () => dashboardApi(`${api}/status`, { validate: isStatus }),
)
const connected = computed(() => status.value?.status === 'connected')

const { data: listingsData, error: listingsError, pending: listingsPending, refresh: refreshListings } = await useAsyncData(
  () => `integration-airbnb-listings:${integrations.organizationId}`,
  () => dashboardApi(`${api}/listings`, { validate: isListings }),
  { immediate: connected.value, watch: [connected] },
)
const listings = computed(() => connected.value ? listingsData.value?.listings ?? [] : [])

const { data: changes, error: changesError, refresh: refreshChanges } = await useAsyncData(
  () => `integration-airbnb-sync:${integrations.organizationId}`,
  () => dashboardApi(`${api}/sync`, { validate: isChanges }),
  { immediate: connected.value, watch: [connected] },
)
const jobs = computed(() => connected.value ? changes.value?.listings ?? [] : [])
const jobOf = (listingId: string) => jobs.value.find(job => job.listing_id === listingId)
const pending = computed(() => jobs.value.some(job => job.status === 'queued' || job.status === 'running'))
/** Changes that failed and are not yet asked for again; Retry re-queues exactly these. */
const failed = computed(() => jobs.value.filter(job => job.status === 'failed'))

const connection = computed<IntegrationLeafConnection | null>(() => {
  const s = status.value
  if (!s || s.status === 'not_connected') return null
  return {
    name: 'Airbnb host account',
    connectedAt: s.connected_at,
    through: null,
    // Connected but not active yet on Channex's side is the host's wait, said on the account line.
    status: s.status === 'connected' ? (s.channel_active ? 'active' : 'disabled') : s.status === 'needs_review' ? 'error' : null,
    lastError: s.status === 'needs_review' ? 'The Airbnb connection needs review. Contact support to finish it.' : null,
    note: s.status === 'authorizing' ? 'Finishing Airbnb sign-in' : s.status === 'disconnecting' ? 'Disconnecting…' : null,
  }
})

// The checklist: what syncs today, plus syncs left part-way, which finish when applied.
const interrupted = (listing: AirbnbListing) => listing.import.status === 'imported' && isInterruptedStage(listing.import.stage)
const syncing = (listing: AirbnbListing) => listing.import.status === 'imported' && listing.import.syncing
const checked = ref<string[]>([])
watch(listings, value => { checked.value = value.filter(listing => syncing(listing) || interrupted(listing)).map(listing => listing.id) }, { immediate: true })

/** What the host entered for listings Airbnb left details out of, by listing id, and the details each listing reported. */
const entered = ref<Record<string, Record<string, string>>>({})
const details = ref<Record<string, AirbnbListingDetails>>({})
const needsDetails = (listing: AirbnbListing) => {
  const known = details.value[listing.id]
  return listing.import.status === 'not_imported' && known !== undefined && !entered.value[listing.id]
    && (known.missingFields.length > 0 || !known.checkInTime || !known.checkOutTime)
}

/** "Backup" in the title, or a title already used by an earlier listing on the account. */
const isBackup = (listing: AirbnbListing) => /backup/i.test(listing.title) || listings.value.find(other => other.title === listing.title)?.id !== listing.id

const rows = computed<IntegrationLeafItem[]>(() => listings.value.map((listing) => {
  const job = jobOf(listing.id)
  const subtitle = [listing.city, listing.country_code].filter(Boolean).join(', ') || null
  const hint = isBackup(listing) ? 'Looks like a backup listing' : null
  const to = listing.import.status === 'imported' ? `/dashboard/${String(route.params.orgSlug)}/products/${listing.import.product_id}` : undefined
  if (job && (job.status === 'queued' || job.status === 'running')) {
    const note = job.action === 'stop' ? 'Stopping sync…' : job.status === 'queued' ? 'Waiting to sync' : job.stage ? importStageTitle(job.stage) : 'Preparing your home…'
    return { id: listing.id, title: listing.title, subtitle, status: 'pending', note, to }
  }
  if (job?.status === 'failed') return { id: listing.id, title: listing.title, subtitle, status: 'attention', note: job.error!.message, to }
  if (interrupted(listing)) return { id: listing.id, title: listing.title, subtitle, status: 'attention', note: 'Setup didn’t finish · it finishes when you apply', to }
  if (needsDetails(listing)) return { id: listing.id, title: listing.title, subtitle, status: 'not_syncing', note: hint, action: 'Add details' }
  return { id: listing.id, title: listing.title, subtitle, status: syncing(listing) ? 'syncing' : 'not_syncing', note: listing.import.status === 'imported' && listing.import.stage === 'draft' ? 'Draft' : hint, to }
}))

/** Listings whose details are still being read or asked for: nothing applies until each is settled. */
const resolving = ref(new Set<string>())
/** Where the listings stand, on the checklist's heading: a failed change first, then changes in progress, else how many sync. */
const itemsStatus = computed<IntegrationLeafItemsStatus | null>(() => {
  if (!connected.value || listingsPending.value) return null
  const firstFailed = failed.value[0]
  if (firstFailed) return { text: `Needs attention: ${firstFailed.error!.message}`, tone: 'warning', retryable: true }
  const running = jobs.value.filter(job => job.status === 'queued' || job.status === 'running').length
  if (running) return { text: `Updating ${running} ${running === 1 ? 'listing' : 'listings'}…`, tone: 'warning' }
  return { text: `${listings.value.filter(syncing).length} of ${listings.value.length} syncing` }
})

/** Checked listings that are not syncing yet, or whose sync setup stopped part-way, and have every detail the import asks for. */
const toSync = computed(() => listings.value.filter(listing => checked.value.includes(listing.id) && (!syncing(listing) || interrupted(listing)) && !needsDetails(listing)))
/** Syncing listings the host unchecked. */
const toStop = computed(() => listings.value.filter(listing => !checked.value.includes(listing.id) && syncing(listing)))
const applyLabel = computed(() => connected.value && !pending.value ? itemsApplyLabel(integrationDefinition('airbnb').items!, toSync.value.length, toStop.value.length) : null)

const starting = ref(false), applying = ref(false), disconnecting = ref(false)
const failure = ref('')
const panelError = computed(() => failure.value
  || (statusError.value ? getErrorMessage(statusError.value, 'Could not load the Airbnb connection.') : '')
  || (changesError.value ? getErrorMessage(changesError.value, 'Could not read the sync’s progress.') : '')
  || integrations.failure.value)

/**
 * A listing Airbnb left details out of has them added before it stays
 * checked: its details are read the first time it is chosen, and the dialog
 * opens when any are missing. Closing the dialog unchecks it again.
 */
async function choose(id: string, chosen: boolean) {
  const listing = listings.value.find(candidate => candidate.id === id)
  if (!chosen || !listing || listing.import.status !== 'not_imported') return
  failure.value = ''
  resolving.value = new Set([...resolving.value, id])
  try {
    details.value[id] ??= await dashboardApi(`${api}/listings/${encodeURIComponent(id)}`, { validate: isDetails })
    // Unchecked while Airbnb was answering: the host's last word stands.
    if (!checked.value.includes(id)) return
    if (needsDetails(listing)) await addDetails(id)
  } catch (cause) {
    checked.value = checked.value.filter(value => value !== id)
    failure.value = getErrorMessage(cause, `Could not read ${listing.title} from Airbnb.`)
  } finally {
    resolving.value = new Set([...resolving.value].filter(value => value !== id))
  }
}

let dialogQueue: Promise<unknown> = Promise.resolve()
async function addDetails(id: string) {
  const listing = listings.value.find(candidate => candidate.id === id)
  const known = details.value[id]
  if (!listing || !known) return
  resolving.value = new Set([...resolving.value, id])
  try {
    // One overlay, one dialog at a time: Select all asks for several listings' details in turn.
    const turn = dialogQueue.then(() => detailsDialog.open({
      listing: { title: listing.title, subtitle: [listing.city, listing.country_code].filter(Boolean).join(', ') || null },
      details: known,
      entered: entered.value[id] ?? {},
    }))
    dialogQueue = turn.then(() => undefined, () => undefined)
    const values = await turn
    if (values) {
      entered.value[id] = values
      if (!checked.value.includes(id)) checked.value = [...checked.value, id]
    } else {
      checked.value = checked.value.filter(value => value !== id)
    }
  } finally {
    resolving.value = new Set([...resolving.value].filter(value => value !== id))
  }
}

/** Hands the change to KrabiClaw, then follows its progress until nothing is waiting. */
async function apply() {
  if (!applyLabel.value) return
  applying.value = true
  failure.value = ''
  try {
    await dashboardApi(`${api}/sync`, {
      method: 'POST',
      body: {
        sync: toSync.value.map(listing => ({ listing_id: listing.id, ...(entered.value[listing.id] ? { details: entered.value[listing.id] } : {}) })),
        stop: toStop.value.map(listing => (listing.import as { product_id: string }).product_id),
      },
      validate: isChanges,
    })
    await refreshChanges()
    follow()
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The change could not be started.')
  } finally {
    applying.value = false
  }
}

/** Asks again for every change that failed, as it was asked: the same listings to sync, the same homes to stop. */
async function retryFailed() {
  if (!failed.value.length) return
  applying.value = true
  failure.value = ''
  try {
    await dashboardApi(`${api}/sync`, {
      method: 'POST',
      body: {
        sync: failed.value.filter(job => job.action === 'sync').map(job => ({ listing_id: job.listing_id, ...(entered.value[job.listing_id] ? { details: entered.value[job.listing_id] } : {}) })),
        stop: failed.value.filter(job => job.action === 'stop' && job.product_id).map(job => job.product_id),
      },
      validate: isChanges,
    })
    await refreshChanges()
    follow()
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The change could not be started again.')
  } finally {
    applying.value = false
  }
}

// The work continues on the server whether or not this page is open; while it runs, the checklist reads what syncs now every few seconds.
let timer: ReturnType<typeof setTimeout> | null = null
function follow() {
  if (timer) clearTimeout(timer)
  if (!pending.value) return
  timer = setTimeout(async () => {
    timer = null
    try {
      await refreshChanges()
      if (changesError.value) throw changesError.value
    } catch (cause) {
      failure.value = getErrorMessage(cause, 'Could not read the sync’s progress.')
      return
    }
    if (pending.value) return follow()
    await Promise.all([refreshListings(), integrations.refresh()])
    // What a listing now syncing was given is spent; a listing still waiting keeps what the host typed.
    entered.value = Object.fromEntries(Object.entries(entered.value).filter(([id]) => !listings.value.some(listing => listing.id === id && syncing(listing))))
  }, 3000)
}
onMounted(follow)
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

async function startConnection() {
  starting.value = true
  failure.value = ''
  try {
    const started = await dashboardApi(`${api}/start`, { method: 'POST', validate: isStart })
    window.location.href = started.authorization_url
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'Could not start the Airbnb connection.')
    starting.value = false
  }
}

async function disconnect() {
  disconnecting.value = true
  failure.value = ''
  try {
    // Disconnecting goes step by step; each answer says whether another step remains.
    let finished = false
    while (!finished) finished = (await dashboardApi(`${api}/disconnect`, { method: 'POST', validate: isDisconnect })).disconnected
    await Promise.all([refreshStatus(), integrations.refresh()])
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'Could not disconnect Airbnb.')
  } finally {
    disconnecting.value = false
  }
}
</script>
