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
      :items-error="listingsError"
      items-empty="Airbnb returned no listings for this account. Check that you connected your hosting account."
      :items-status="itemsStatus"
      :applying="applying || pending"
      @choose="choose"
      @act="actOnListing"
      @retry-failed="retryFailed"
    >
      <div v-if="!connection" class="space-y-4">
        <p class="text-sm text-muted">
          Connect your Airbnb host account to sync listings, availability, rates, and guest messages directly to your dashboard.
        </p>
        <UButton icon="i-simple-icons-airbnb" size="xl" block :loading="starting" @click="startConnection">Connect Airbnb</UButton>
        <p class="text-center text-xs text-dimmed">You can also connect and sync directly within the Blawby app on iOS.</p>
      </div>
      <template #account>
        <section class="space-y-3">
          <h2 class="text-sm font-semibold text-muted">Airbnb accounts</h2>
          <div v-for="account in connectedAccounts" :key="account.channel_id" class="flex items-center justify-between gap-3">
            <div>
              <p class="font-medium">{{ accountsListingName(account.channel_id) }}</p>
              <p class="text-sm text-muted">{{ account.listing_count }} linked</p>
              <p v-if="account.disconnect_error" class="text-sm text-error">{{ account.disconnect_error }}</p>
            </div>
            <UButton v-if="canManage" color="error" variant="outline" :loading="account.status === 'disconnecting'" :disabled="disconnecting || applying || pending" @click="disconnect(account)">
              {{ account.disconnect_error ? 'Retry disconnect' : 'Disconnect' }}
            </UButton>
          </div>
          <UButton v-if="canManage && entitled" icon="i-lucide-plus" color="neutral" variant="outline" :loading="starting" @click="startConnection">
            {{ connected ? 'Connect another Airbnb account' : 'Continue with Airbnb' }}
          </UButton>
        </section>
      </template>
      <template #disconnect />
      <template #connected>
        <section v-if="canManage && linkableListings.length && linkedHomes.length" class="space-y-3">
          <h2 class="text-sm font-semibold text-muted">Share a home’s calendar</h2>
          <UFormField label="Airbnb listing">
            <USelect v-model="linkListing" :items="linkableListings" placeholder="Choose a listing" class="w-full" />
          </UFormField>
          <UFormField label="Existing home">
            <USelect v-model="linkHome" :items="linkedHomes" placeholder="Choose a home" class="w-full" />
          </UFormField>
          <UButton :disabled="!linkListing || !linkHome || pending || applying || disconnecting" @click="attachListing">
            Link listing
          </UButton>
        </section>

        <section v-if="missingListings.length" class="space-y-3">
          <div>
            <h2 class="text-sm font-semibold text-muted">Missing from Airbnb</h2>
            <p class="mt-1 text-sm text-muted">Airbnb no longer lists these homes on this account. Stopping Airbnb sync keeps the home and its reservations in Blawby.</p>
          </div>
          <div v-for="listing in missingListings" :key="listing.listing_id" class="flex items-center justify-between gap-3">
            <NuxtLink :to="`/dashboard/${String(route.params.org_slug)}/products/${listing.product_id}`" class="font-medium text-highlighted underline">
              {{ listing.internal_name }}
            </NuxtLink>
            <UButton v-if="canManage" color="neutral" variant="outline" :disabled="applying || pending || disconnecting" @click="submitChanges({ stop_listing_ids: [listing.listing_id] })">
              Stop Airbnb sync
            </UButton>
          </div>
        </section>
      </template>
    </IntegrationLeaf>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import IntegrationLeaf, { type IntegrationLeafConnection, type IntegrationLeafItem, type IntegrationLeafItemsStatus } from '~/components/dashboard/IntegrationLeaf.vue'
import AirbnbListingDetailsDialog, { type AirbnbListingDetails } from '~/components/dashboard/AirbnbListingDetailsDialog.vue'
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
import OfferCard from '~/components/dashboard/OfferCard.vue'
import { integrationDefinition, itemsApplyLabel } from '~/shared/integrations'
import { IMPORT_STAGES, importStageTitle, isInterruptedStage, type ImportStage } from '~/shared/airbnb-import'
import { isSuccessfulChannelPush, type SuccessfulChannelPush } from '~/shared/channel-push'
import { offer } from '~/shared/offers'
import { getErrorMessage } from '~/utils/errors'
import { organizationRoles } from '~/utils/organization-access'
import { integrationsKey } from '../integrations.vue'

definePageMeta({ layout: 'dashboard' })

/*
  The Airbnb sync checklist, as the iOS app has it: every listing on the
  connected account, checked when it syncs with Blawby. Checking one brings
  it over and turns its sync on; unchecking stops the sync and keeps the home
  as a free draft. The changes apply together from one button, after the plan
  check, and Blawby runs them in the background (sync.post, then sync.get
  until nothing is waiting). A listing Airbnb left details out of gets them in
  its own dialog first.
*/
interface AirbnbAccount {
  channel_id: string | null
  status: 'not_connected' | 'authorizing' | 'connected' | 'disconnecting'
  connected_at: string | null
  listing_count: number
  channel_active: boolean
  /** Why the last disconnect failed; null when none did. */
  disconnect_error: string | null
}

interface AirbnbStatus extends AirbnbAccount { connections: AirbnbAccount[] }

type ListingImport = { status: 'not_imported' } | { status: 'imported'; product_id: string; stage: ImportStage; syncing: boolean }
interface AirbnbListing { id: string; channel_id: string; title: string; city: string; country_code: string; import: ListingImport }
interface MissingAirbnbListing { listing_id: string; product_id: string; internal_name: string }
interface SyncRequest { sync?: Array<{ listing_id: string; product_id?: string; details?: Record<string, string> }>; stop_listing_ids: string[] }

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
const canManage = computed(() => dashboard.organization.value?.role.split(',').some((role) => {
  const access = organizationRoles[role.trim() as keyof typeof organizationRoles]
  return access?.authorize({ integrations: ['update'] }).success === true
}) ?? false)
const api = `/api/organizations/${integrations.organizationId}/integrations/airbnb`
const confirmDialog = useOverlay().create(DashboardConfirmDialog)
const detailsDialog = useOverlay().create(AirbnbListingDetailsDialog)

const isStage = (value: unknown): value is ImportStage => typeof value === 'string' && (IMPORT_STAGES as readonly string[]).includes(value)
const isAccount = (value: unknown): value is AirbnbAccount =>
  isRecord(value) && ['not_connected', 'authorizing', 'connected', 'disconnecting'].includes(String(value.status))
  && (value.connected_at === null || typeof value.connected_at === 'string') && typeof value.listing_count === 'number'
  && (value.channel_id === null || typeof value.channel_id === 'string')
  && (value.disconnect_error === null || typeof value.disconnect_error === 'string')
const isStatus = (value: unknown): value is AirbnbStatus =>
  isAccount(value) && 'connections' in value && Array.isArray(value.connections) && value.connections.every(isAccount)
const isListing = (value: unknown): value is AirbnbListing =>
  isRecord(value) && typeof value.id === 'string' && typeof value.channel_id === 'string' && typeof value.title === 'string' && isRecord(value.import)
  && (value.import.status === 'not_imported' || (value.import.status === 'imported' && typeof value.import.product_id === 'string' && isStage(value.import.stage) && typeof value.import.syncing === 'boolean'))
const isListings = (value: unknown): value is { listings: AirbnbListing[]; missing_listings: MissingAirbnbListing[] } =>
  isRecord(value) && Array.isArray(value.listings) && value.listings.every(isListing)
  && Array.isArray(value.missing_listings) && value.missing_listings.every(listing => isRecord(listing)
    && typeof listing.listing_id === 'string' && typeof listing.product_id === 'string' && typeof listing.internal_name === 'string')
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

type AirbnbWorkspace = {
  connection: AirbnbStatus
  inventory: { listings: AirbnbListing[]; missing_listings: MissingAirbnbListing[] } | null
  inventory_error: string | null
  jobs: SyncChange[]
}
const isAirbnbWorkspace = (value: unknown): value is AirbnbWorkspace =>
  isRecord(value) && isStatus(value.connection) && (value.inventory === null || isListings(value.inventory))
  && (value.inventory_error === null || typeof value.inventory_error === 'string')
  && Array.isArray(value.jobs) && value.jobs.every(isChange)

const { data: workspace, error: statusError, pending: listingsPending, refresh: refreshWorkspace } = await useAsyncData(
  () => `integration-airbnb-workspace:${integrations.organizationId}`,
  () => dashboardApi(`${api}/status`, { query: { view: 'workspace' }, validate: isAirbnbWorkspace }),
)
const status = computed(() => workspace.value?.connection)
const connected = computed(() => status.value?.status === 'connected')
const connectedAccounts = computed(() => status.value?.connections.flatMap(account => account.channel_id ? [{ ...account, channel_id: account.channel_id }] : []) ?? [])
function accountsListingName(channelId: string) {
  return workspace.value?.inventory?.listings.find(listing => listing.channel_id === channelId)?.title ?? 'Airbnb account'
}
const listings = computed(() => workspace.value?.inventory?.listings ?? [])
const missingListings = computed(() => workspace.value?.inventory?.missing_listings ?? [])
const listingsError = computed(() => workspace.value?.inventory_error ?? null)

const { data: changes, error: changesError, refresh: refreshChanges, clear: clearChanges } = useAsyncData(
  () => `integration-airbnb-sync:${integrations.organizationId}`,
  () => dashboardApi(`${api}/sync`, { validate: isChanges }),
  { immediate: false },
)
async function refreshStatus() {
  await refreshWorkspace()
  if (statusError.value) throw statusError.value
  clearChanges()
}
const jobs = computed(() => connected.value ? changes.value?.listings ?? workspace.value?.jobs ?? [] : [])
const jobOf = (listingId: string) => jobs.value.find(job => job.listing_id === listingId)
const pending = computed(() => jobs.value.some(job => job.status === 'queued' || job.status === 'running'))
/** Changes that failed and are not yet asked for again. */
const failed = computed(() => jobs.value.filter(job => job.status === 'failed'))
/**
 * The failed changes Retry can ask for again: a sync of a listing still on the
 * account, a stop of a home that still exists. One that names neither would
 * refuse the whole batch, so it is left out and, alone, offers no Retry.
 */
const retryBatch = computed(() => {
  const imported = new Set(listings.value.flatMap(listing => listing.import.status === 'imported' ? [listing.import.product_id] : []))
  return {
    sync: failed.value.filter(job => job.action === 'sync' && listings.value.some(listing => listing.id === job.listing_id)),
    stop: failed.value.filter(job => job.action === 'stop' && job.product_id !== null && imported.has(job.product_id)),
  }
})

const connection = computed<IntegrationLeafConnection | null>(() => {
  const s = status.value
  if (!s || s.status === 'not_connected') return null
  return {
    name: 'Airbnb host account',
    connectedAt: s.connected_at,
    through: null,
    // Connected but not active yet on Channex's side is the host's wait, said on the account line.
    status: s.disconnect_error ? 'error' : s.status === 'connected' ? (s.channel_active ? 'active' : 'disabled') : null,
    lastError: s.disconnect_error ? `Disconnecting failed: ${s.disconnect_error}` : null,
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
    && known.missingFields.length > 0
}

/** "Backup" in the title, or a title already used by an earlier listing on the account. */
const isBackup = (listing: AirbnbListing) => /backup/i.test(listing.title) || listings.value.find(other => other.title === listing.title)?.id !== listing.id
const fullSyncProduct = (listing: AirbnbListing) => entitled.value && canManage.value
  && listing.import.status === 'imported' && listing.import.stage === 'complete' && listing.import.syncing ? listing.import.product_id : null
const fullSyncStatus = ref<{ id: string; status: IntegrationLeafItem['status']; note: string } | null>(null)

const rows = computed<IntegrationLeafItem[]>(() => listings.value.map((listing) => {
  const job = jobOf(listing.id)
  const subtitle = [listing.city, listing.country_code].filter(Boolean).join(', ') || null
  const hint = isBackup(listing) ? 'Looks like a backup listing' : null
  const to = listing.import.status === 'imported' ? `/dashboard/${String(route.params.org_slug)}/products/${listing.import.product_id}` : undefined
  if (job && (job.status === 'queued' || job.status === 'running')) {
    const note = job.action === 'stop' ? 'Stopping sync…' : job.status === 'queued' ? 'Waiting to sync' : job.stage ? importStageTitle(job.stage) : 'Preparing your home…'
    return { id: listing.id, title: listing.title, subtitle, status: 'pending', note, to }
  }
  const action = fullSyncProduct(listing) ? 'Full sync' : undefined
  if (action && fullSyncStatus.value?.id === listing.id) return { title: listing.title, subtitle, to, action, ...fullSyncStatus.value }
  if (job?.status === 'failed') return { id: listing.id, title: listing.title, subtitle, status: 'attention', note: job.error!.message, to, action }
  if (interrupted(listing)) return { id: listing.id, title: listing.title, subtitle, status: 'attention', note: 'Setup didn’t finish · it finishes when you apply', to }
  if (needsDetails(listing)) return { id: listing.id, title: listing.title, subtitle, status: 'not_syncing', note: hint, action: 'Add details' }
  return { id: listing.id, title: listing.title, subtitle, status: syncing(listing) ? 'syncing' : 'not_syncing', note: listing.import.status === 'imported' && listing.import.stage === 'draft' ? 'Draft' : hint, to, action }
}))

/** Listings whose details are still being read or asked for: nothing applies until each is settled. */
const resolving = ref(new Set<string>())
/** Where the listings stand, on the checklist's heading: a failed change first, then changes in progress, else how many sync. */
const itemsStatus = computed<IntegrationLeafItemsStatus | null>(() => {
  // A sync read that failed is the panel's error; a count the page cannot know is not shown.
  if (!connected.value || listingsPending.value || listingsError.value || changesError.value) return null
  // The failure shown is one Retry can clear when there is one; otherwise the first, without Retry.
  const retryable = [...retryBatch.value.sync, ...retryBatch.value.stop]
  const firstFailed = retryable[0] ?? failed.value[0]
  if (firstFailed) return { text: `Needs attention: ${firstFailed.error!.message}`, tone: 'warning', retryable: retryable.length > 0 }
  const running = jobs.value.filter(job => job.status === 'queued' || job.status === 'running').length
  if (running) return { text: `Updating ${running} ${running === 1 ? 'listing' : 'listings'}…`, tone: 'warning' }
  return { text: `${listings.value.filter(syncing).length} of ${listings.value.length} syncing` }
})

/** Checked listings that are not syncing yet, or whose sync setup stopped part-way, and have every detail the import asks for. */
const toSync = computed(() => listings.value.filter(listing => checked.value.includes(listing.id) && (!syncing(listing) || interrupted(listing)) && !needsDetails(listing)))
/** Syncing listings the host unchecked. */
const linkListing = ref<string>()
const linkHome = ref<string>()
const linkableListings = computed(() => listings.value.filter(listing => listing.import.status === 'not_imported' || listing.import.stage === 'complete' || listing.import.stage === 'draft')
  .map(listing => ({ label: listing.title, value: listing.id })))
const linkedHomes = computed(() => {
  const source = listings.value.find(listing => listing.id === linkListing.value)?.import
  return [...new Map(listings.value.flatMap(listing =>
    listing.import.status === 'imported' && listing.import.syncing && (source?.status !== 'imported' || source.product_id !== listing.import.product_id)
      ? [[listing.import.product_id, { label: listing.title, value: listing.import.product_id }] as const] : [],
  )).values()]
})
watch(linkListing, () => { linkHome.value = undefined })
async function attachListing() {
  if (!linkListing.value || !linkHome.value) return
  const selected = listings.value.find(listing => listing.id === linkListing.value)
  if (!selected || (selected.import.status === 'imported' && selected.import.product_id === linkHome.value)) return
  if (selected.import.status === 'imported' && !await confirmDialog.open({
    title: 'Merge these homes?',
    description: 'Blawby will move the reservations and guest conversations to the selected home and remove the duplicate home from your calendar and website.',
    confirmLabel: 'Merge homes', cancelLabel: 'Keep separate',
  })) return
  await submitChanges({ sync: [{ listing_id: selected.id, product_id: linkHome.value }], stop_listing_ids: [] })
}
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
/** Opens the listing's details dialog; true when the host finished it, false when they closed it. */
async function addDetails(id: string): Promise<boolean> {
  const listing = listings.value.find(candidate => candidate.id === id)
  const known = details.value[id]
  if (!listing || !known) return false
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
    return values !== null
  } finally {
    resolving.value = new Set([...resolving.value].filter(value => value !== id))
  }
}

async function actOnListing(id: string) {
  if (applying.value || pending.value || disconnecting.value) return
  const listing = listings.value.find(candidate => candidate.id === id)
  if (!listing) return
  if (needsDetails(listing)) { await addDetails(id); return }
  const productId = fullSyncProduct(listing)
  if (!productId) return
  applying.value = true
  failure.value = ''
  fullSyncStatus.value = { id, status: 'pending', note: 'Sending calendar…' }
  try {
    const { channel_push: channel } = await dashboardApi(`${api}/imports/${encodeURIComponent(productId)}/calendar`, {
      method: 'POST',
      validate: (value): value is { product_id: string; channel_push: SuccessfulChannelPush } =>
        isRecord(value) && value.product_id === productId && value.channel_push !== null && isSuccessfulChannelPush(value.channel_push),
    })
    fullSyncStatus.value = { id, status: 'syncing', note: channel.state === 'pushed' ? 'Calendar sent to Channex.' : `Calendar sync queued. ${channel.detail}` }
  } catch (cause) {
    fullSyncStatus.value = { id, status: 'attention', note: getErrorMessage(cause, 'Could not sync this calendar.') }
  } finally {
    applying.value = false
  }
}

/** Hands the change to Blawby, then follows its progress until nothing is waiting. */
function apply() {
  if (!applyLabel.value) return
  return submitChanges({
    sync: toSync.value.map(listing => ({ listing_id: listing.id, ...(entered.value[listing.id] ? { details: entered.value[listing.id] } : {}) })),
    stop_listing_ids: toStop.value.map(listing => listing.id),
  })
}

async function submitChanges(body: SyncRequest) {
  if (applying.value || pending.value || disconnecting.value) return
  applying.value = true
  failure.value = ''
  try {
    changes.value = await dashboardApi(`${api}/sync`, { method: 'POST', body, validate: isChanges })
    follow()
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The change could not be started.')
  } finally {
    applying.value = false
  }
}

/**
 * Asks again for every change that failed, as it was asked: the same listings
 * to sync, the same homes to stop. A listing Airbnb left details out of has
 * them asked for again first when the page no longer holds them (the status
 * read does not return what was sent), so the retry never drops them.
 */
async function retryFailed() {
  const batch = retryBatch.value
  if (!batch.sync.length && !batch.stop.length) return
  if (applying.value) return
  failure.value = ''
  applying.value = true
  try {
    for (const job of batch.sync) {
      // Listings may have been read again while an earlier dialog was open.
      const listing = listings.value.find(candidate => candidate.id === job.listing_id)
      if (!listing || job.product_id || listing.import.status !== 'not_imported') continue
      // A detail the server refused is corrected in the same dialog; details still held are otherwise sent as they are.
      if (entered.value[listing.id] && job.error?.code !== 'INVALID_DETAIL') continue
      try {
        details.value[listing.id] ??= await dashboardApi(`${api}/listings/${encodeURIComponent(listing.id)}`, { validate: isDetails })
      } catch (cause) {
        failure.value = getErrorMessage(cause, `Could not read ${listing.title} from Airbnb.`)
        return
      }
      if (!needsDetails(listing) && job.error?.code !== 'INVALID_DETAIL') continue
      // Closing the dialog, with or without earlier values held, means the host is not resubmitting.
      if (!await addDetails(listing.id)) return
    }
    // What is sent is the batch the host saw, as it stands now: a listing or home gone meanwhile is left out,
    // and a change that failed meanwhile waits for its own Retry, since its details were not asked for.
    const asked = { sync: new Set(batch.sync.map(job => job.listing_id)), stop: new Set(batch.stop.map(job => job.listing_id)) }
    const current = { sync: retryBatch.value.sync.filter(job => asked.sync.has(job.listing_id)), stop: retryBatch.value.stop.filter(job => asked.stop.has(job.listing_id)) }
    if (!current.sync.length && !current.stop.length) return
    changes.value = await dashboardApi(`${api}/sync`, {
      method: 'POST',
      body: {
        sync: current.sync.map(job => ({ listing_id: job.listing_id, ...(job.product_id ? { product_id: job.product_id } : entered.value[job.listing_id] ? { details: entered.value[job.listing_id] } : {}) })),
        stop_listing_ids: current.stop.map(job => job.listing_id),
      },
      validate: isChanges,
    })
    follow()
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The change could not be started again.')
  } finally {
    applying.value = false
  }
}

// The work continues on the server whether or not this page is open; while it runs, the checklist reads what syncs now every few seconds.
let timer: ReturnType<typeof setTimeout> | null = null
async function refreshSync() {
  await refreshChanges()
  if (changesError.value) throw changesError.value
  if (pending.value) return follow()
  // The first listing to sync activates the channel, which the account line reads from status.
  await Promise.all([refreshStatus(), integrations.refresh()])
  // What a listing now syncing was given is spent; a listing still waiting keeps what the host typed.
  entered.value = Object.fromEntries(Object.entries(entered.value).filter(([id]) => !listings.value.some(listing => listing.id === id && syncing(listing))))
}

function follow(delay = 3000) {
  if (timer) clearTimeout(timer)
  if (!pending.value) return
  timer = setTimeout(async () => {
    timer = null
    try {
      await refreshSync()
    } catch (cause) {
      failure.value = getErrorMessage(cause, 'Could not read the sync’s progress.')
    }
  }, delay)
}
const realtime = useDashboardInvalidations()
watch(realtime.event, event => {
  if (event?.type === 'business.changed' || event?.type === 'stay.changed' || event?.type === 'nights.changed') follow(0)
})
onMounted(() => follow())
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

async function startConnection() {
  starting.value = true
  failure.value = ''
  try {
    const started = await dashboardApi(`${api}/start?client=web`, { method: 'POST', validate: isStart })
    window.location.href = started.authorization_url
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'Could not start the Airbnb connection.')
    starting.value = false
  }
}

onMounted(async () => {
  const { success, token, channel_id: channelId, ...rest } = route.query
  if (success === undefined && token === undefined && channelId === undefined) return
  await navigateTo({ path: route.path, query: rest }, { replace: true })
  if (success !== 'true' || typeof token !== 'string' || typeof channelId !== 'string') {
    failure.value = 'Airbnb didn’t authorize this connection.'
    return
  }
  try {
    await dashboardApi(`${api}/complete`, {
      method: 'POST', body: { token, channel_id: channelId },
      validate: (value: unknown): value is { connected: true } => isRecord(value) && value.connected === true,
    })
    await Promise.all([refreshStatus(), integrations.refresh()])
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'Could not finish the Airbnb connection.')
  }
})

async function disconnect(account: AirbnbAccount & { channel_id: string }) {
  failure.value = ''
  try {
    const result = await dashboardApi(`${api}/disconnect`, {
      method: 'POST', body: { channel_id: account.channel_id, retry: Boolean(account.disconnect_error) }, validate: isDisconnect,
    })
    if (result.disconnected) await Promise.all([refreshStatus(), integrations.refresh()])
    else await watchDisconnect()
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'Could not disconnect Airbnb.')
    await refreshWorkspace()
  }
}

// Blawby disconnects in the background, between sync steps; the status reads not_connected when it is done,
// or connected again with the reason it failed. A page opened mid-disconnect follows it too.
let watching = false
async function watchDisconnect() {
  if (watching) return
  watching = true
  disconnecting.value = true
  try {
    for (let first = true; ; first = false) {
      if (!first) await new Promise(resolve => setTimeout(resolve, 2000))
      if (!watching) return
      await refreshStatus()
      if (!connectedAccounts.value.some(account => account.status === 'disconnecting')) break
    }
    await integrations.refresh()
    if (status.value?.disconnect_error) failure.value = `Disconnecting failed: ${status.value.disconnect_error}`
  } finally {
    watching = false
    disconnecting.value = false
  }
}
onMounted(() => {
  if (connectedAccounts.value.some(account => account.status === 'disconnecting')) watchDisconnect().catch((cause) => { failure.value = getErrorMessage(cause, 'Could not disconnect Airbnb.') })
})
onBeforeUnmount(() => { watching = false })
</script>
