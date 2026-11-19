import { AIRBNB_MAPPINGS } from './listing-mappings'
import { HTTPError } from 'nitro'
import { publishAirbnbSync, type AirbnbSyncMessage } from '~/server/events'
import { scheduleBusinessWake } from '~/server/cloudflare/guest-inbox-events'
import { execute, executeBatch, MAX_D1_BATCH_STATEMENTS, queryAll, queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { countActiveHomes, homeAllowance, homesQuote, homeLimit, liveHomeSql, reportBillingUsage } from '~/server/utils/billing'
import { ChannexConnection, type ImportStage } from './channel-connection'
import { assertRoleAllows, resolveOrganizationMembership } from '~/server/utils/member-access'

/**
 * Which of an organization's Airbnb listings sync, done in the background. The
 * app posts the change once: listings to sync (imported as homes if they are
 * not yet, then made live) and homes to stop syncing (back to free drafts).
 * The plan is checked for the whole change before anything is queued. Each
 * listing is one row of airbnb_sync_jobs. The AIRBNB_SYNC queue advances it
 * through the ChannexConnection steps recorded in the mapping's import_stage.
 * The job's terminal result stays visible until a new request names the listing.
 *
 * AIRBNB_SYNC runs one delivery at a time (max_concurrency = 1 in wrangler.toml),
 * and nothing else calls a step that creates a Channex resource: a duplicate
 * delivery reads the stage the earlier one saved, so it never sends the same
 * create again. Disconnecting runs on the same queue, between steps.
 */

/** One delivery from the AIRBNB_SYNC queue. */
export async function consumeAirbnbSync(env: CloudflareEnv, message: AirbnbSyncMessage): Promise<void> {
  if (message.type === 'airbnb.sync_step') return advanceAirbnbSyncJob(env, message.organization_id, message.job_id)
  const connection = new ChannexConnection(env.DB, env, message.organization_id, message.user_id)
  let disconnected: boolean
  try {
    disconnected = await connection.disconnectStep(message.channel_id)
  } catch (error) {
    // The owner reads the reason with the connection and asks again; Cloudflare does not repeat it.
    await connection.disconnectFailed(message.channel_id, error instanceof Error ? error.message : String(error))
    return
  }
  if (!disconnected) await publishAirbnbSync(env, message)
}

export interface AirbnbSyncListing {
  listing_id: string
  product_id: string | null
  action: 'sync' | 'stop'
  status: 'queued' | 'running' | 'done' | 'failed'
  stage: ImportStage | null
  error: { code: string; message: string } | null
  updated_at: string
}

interface JobRow {
  id: string
  organization_id: string
  listing_id: string
  product_id: string | null
  action: 'sync' | 'stop'
  details: string | null
  state: 'pending' | 'done' | 'failed'
  requested_by: string | null
  last_error_code: string | null
  last_error: string | null
  updated_at: string
}

/** Channex prescribes a one-minute pause before another attempt for a waiting property. */
const PROVIDER_SETTLE_SECONDS = 60

const now = () => new Date().toISOString()

function fail(statusCode: number, code: string, message: string, detail: Record<string, unknown> = {}): never {
  throw new HTTPError({ statusCode, message, data: { code, ...detail } })
}

function ids(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) fail(422, 'VALIDATION_ERROR', `${field} must be a list of ids`, { field })
  return [...new Set(value as string[])]
}

/** The listings to sync: each `{listing_id, details?}`, details being the listing fields the host supplied, each text. */
function syncItems(value: unknown): Array<{ listing_id: string; product_id: string | null; details: Record<string, string> | null }> {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(422, 'VALIDATION_ERROR', 'sync must be a list of {listing_id, details}', { field: 'sync' })
  const items = value.map((item, index) => {
    const record = item as Record<string, unknown> | null
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.listing_id !== 'string' || !record.listing_id.trim()
      || Object.keys(record).some(key => key !== 'listing_id' && key !== 'details' && key !== 'product_id')) fail(422, 'VALIDATION_ERROR', 'Each sync item is {listing_id, details}', { field: `sync[${index}]` })
    if (record.product_id !== undefined && (typeof record.product_id !== 'string' || !record.product_id.trim() || record.details !== undefined)) {
      fail(422, 'VALIDATION_ERROR', 'Choose one existing home or supply the details for a new home.', { field: `sync[${index}].product_id` })
    }
    const details = record.details
    if (details !== undefined && (!details || typeof details !== 'object' || Array.isArray(details) || Object.values(details).some(field => typeof field !== 'string' || !field.trim()))) {
      fail(422, 'VALIDATION_ERROR', 'details must name listing fields, each as non-empty text', { field: `sync[${index}].details` })
    }
    return { listing_id: record.listing_id, product_id: typeof record.product_id === 'string' ? record.product_id : null, details: details === undefined ? null : details as Record<string, string> }
  })
  const repeated = items.find((item, index) => items.findIndex(other => other.listing_id === item.listing_id) !== index)
  if (repeated) fail(422, 'VALIDATION_ERROR', 'A listing is named twice', { listing_id: repeated.listing_id })
  return items
}

/**
 * Queue a change to which listings sync. `sync` names Airbnb listings on the
 * connected account; `stop` names homes imported from it. Refused with 402
 * HOME_LIMIT and the homes quote when the plan would not take the live homes
 * the change leaves; otherwise every named listing is queued, replacing any
 * earlier request for it, and the change's listings are answered as GET does.
 */
export async function requestAirbnbSync(env: CloudflareEnv, db: DbClient, organizationId: string, userId: string, body: { sync?: unknown; stop?: unknown; stop_listing_ids?: unknown }): Promise<AirbnbSyncListing[]> {
  const items = syncItems(body.sync)
  const sync = items.map(item => item.listing_id)
  const stopHomes = ids(body.stop, 'stop')
  const stop = ids(body.stop_listing_ids, 'stop_listing_ids')
  if (!sync.length && !stop.length && !stopHomes.length) fail(422, 'VALIDATION_ERROR', 'Name listings to sync or homes to stop', { field: 'sync' })
  if (sync.length + stop.length + stopHomes.length > MAX_D1_BATCH_STATEMENTS) fail(422, 'VALIDATION_ERROR', `Name at most ${MAX_D1_BATCH_STATEMENTS} listings and homes in one change`, { field: 'sync' })
  const connection = new ChannexConnection(db, env, organizationId, userId)
  // Starting a sync is Business; stopping one never needs a plan.
  if (sync.length) await connection.requireChannelSync()
  const listings = sync.length ? (await connection.listings()).listings : []
  const unknownListing = sync.find(id => !listings.some(listing => listing.id === id))
  if (unknownListing) fail(404, 'LISTING_NOT_FOUND', 'This listing is not on your connected Airbnb account', { listing_id: unknownListing })
  // A listing's details may only hold the fields its listing details report missing, as the review asked for them.
  for (const item of items) {
    if (!item.details) continue
    const missing = (await connection.details(item.listing_id)).missing_fields as string[]
    const extra = Object.keys(item.details).find(key => !missing.includes(key))
    if (extra) fail(422, 'ONLY_MISSING_DETAILS', 'Only the listing details Airbnb left out may be supplied', { listing_id: item.listing_id, field: `details.${extra}` })
  }
  const [stopListings, stopHomeListings] = await Promise.all([
    connectedAirbnbMappings(db, organizationId, stop, 'listing'),
    connectedAirbnbMappings(db, organizationId, stopHomes, 'product'),
  ])
  const unknownHome = stopHomes.find(id => !stopHomeListings.some(listing => listing.product_id === id))
  if (unknownHome) fail(404, 'IMPORT_NOT_FOUND', 'No Airbnb listings are connected to this home.', { product_id: unknownHome })
  const stopped = [...new Map([...stopListings, ...stopHomeListings].map(mapping => [mapping.listing_id, mapping])).values()]
  if (sync.length + stopped.length > MAX_D1_BATCH_STATEMENTS) fail(422, 'VALIDATION_ERROR', 'Choose fewer listings for this change.', { field: 'stop_listing_ids' })
  const missing = stop.find(listingId => !stopped.some(row => row.listing_id === listingId))
  if (missing) fail(404, 'IMPORT_NOT_FOUND', 'This listing is not imported from your connected Airbnb accounts.', { listing_id: missing })
  const both = stopped.find(mapping => sync.includes(mapping.listing_id))
  if (both) fail(422, 'VALIDATION_ERROR', 'A listing cannot be synced and stopped at once', { listing_id: both.listing_id })

  // The live homes the change leaves: a synced listing is live; a stopped home stays live only while published on the site.
  const homes = sync.length ? await queryAll<{ product_id: string; live: number; published: number }>(db, `SELECT p.id AS product_id, ${liveHomeSql('p')} AS live,
      EXISTS (SELECT 1 FROM product_publications pp WHERE pp.organization_id = p.organization_id AND pp.product_id = p.id AND pp.published = 1) AS published
    FROM products p JOIN product_channel_mappings m ON m.organization_id = p.organization_id AND m.product_id = p.id AND m.provider = 'channex' WHERE p.organization_id = ?`, [organizationId]) : []
  const home = (productId: string | undefined) => homes.find(row => row.product_id === productId)
  const productOf = (listingId: string) => {
    const listing = listings.find(row => row.id === listingId)!
    return listing.import.status === 'imported' ? listing.import.product_id : undefined
  }
  const adding = items.filter(item => {
    const source = home(productOf(item.listing_id))
    if (!item.product_id) return !source?.live
    return !source?.live || source.published === 1
  }).length
  const leaving = stopped.filter(mapping => home(mapping.product_id)?.live && !home(mapping.product_id)?.published).length
  if (adding > leaving && !(await homeAllowance(env, db, organizationId, adding - leaving)).allowed) {
    const refusal = homeLimit(await countActiveHomes(db, organizationId))
    throw new HTTPError({ statusCode: refusal.status, statusMessage: refusal.data.error, data: { ...refusal.data, quote: await homesQuote(env, db, organizationId, adding - leaving) } })
  }

  const queued = [...items.map(item => ({ listing: item.listing_id, product: item.product_id ?? null, action: 'sync' as const, details: item.details ? JSON.stringify(item.details) : null })),
    ...stopped.map(mapping => ({ listing: mapping.listing_id, product: mapping.product_id, action: 'stop' as const, details: null }))]
  await queueJobs(db, env, organizationId, userId, queued)
  const named = new Set(queued.map(job => job.listing))
  return (await readAirbnbSync(db, organizationId)).filter(listing => named.has(listing.listing_id))
}

/** A stop addresses an imported home on this connected account even if Airbnb removed its listing. */
async function connectedAirbnbMappings(db: DbClient, organizationId: string, ids: string[], by: 'product' | 'listing') {
  if (!ids.length) return []
  return queryAll<{ product_id: string; listing_id: string }>(db, `SELECT m.product_id, m.listing_id FROM ${AIRBNB_MAPPINGS} m
    JOIN channex_connections c ON c.organization_id = m.organization_id AND c.channel_id = m.channel_id AND c.status = 'connected'
    WHERE m.organization_id = ? AND m.provider = 'channex' AND m.listing_id IS NOT NULL
      AND m.${by === 'product' ? 'product_id' : 'listing_id'} IN (SELECT value FROM json_each(?))`, [organizationId, JSON.stringify(ids)])
}

/**
 * Queue each listing's change, replacing any earlier request for it. A request
 * gives the row a new id, so a run still on the old request writes nothing
 * over this one. `requestedBy` is null only for a stop Blawby asks for itself.
 */
async function queueJobs(db: DbClient, env: CloudflareEnv, organizationId: string, requestedBy: string | null, jobs: Array<{ listing: string; product: string | null; action: 'sync' | 'stop'; details: string | null }>): Promise<void> {
  const at = now()
  const pending = jobs.map(job => ({ ...job, id: crypto.randomUUID() }))
  await executeBatch(db, pending.map(job => ({ query: `INSERT INTO airbnb_sync_jobs (id, organization_id, listing_id, product_id, action, details, state, requested_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT (organization_id, listing_id) DO UPDATE SET id = excluded.id, action = excluded.action, details = excluded.details, state = 'pending', requested_by = excluded.requested_by,
        product_id = excluded.product_id, last_error_code = NULL, last_error = NULL,
        completed_at = NULL, updated_at = excluded.updated_at`,
    params: [job.id, organizationId, job.listing, job.product, job.action, job.details, requestedBy, at, at] })), { operation: 'Queue an Airbnb sync change' })
  for (const job of pending) await publishAirbnbSync(env, { type: 'airbnb.sync_step', organization_id: organizationId, job_id: job.id })
}

/**
 * Stop syncing these homes with Airbnb because the organization's paid plan
 * ended: queued as a stop no one asked for, which the AIRBNB_SYNC consumer runs as
 * it runs any other. Each must be a home imported from the connected account.
 */
export async function stopAirbnbSyncForPlanEnd(db: DbClient, env: CloudflareEnv, organizationId: string, productIds: string[]): Promise<void> {
  const mappings = await connectedAirbnbMappings(db, organizationId, productIds, 'product')
  const missing = productIds.find(id => !mappings.some(row => row.product_id === id))
  if (missing) throw new Error(`Home ${missing} is not imported from the organization's connected Airbnb account`)
  // One batch holds at most D1's statements per batch; an organization past Basic may have more homes than that.
  for (let start = 0; start < mappings.length; start += MAX_D1_BATCH_STATEMENTS) {
    await queueJobs(db, env, organizationId, null, mappings.slice(start, start + MAX_D1_BATCH_STATEMENTS).map(row => ({ listing: row.listing_id, product: row.product_id, action: 'stop', details: null })))
  }
}

/** Every listing this organization asked to sync or stop, with where each stands. */
export async function readAirbnbSync(db: DbClient, organizationId: string): Promise<AirbnbSyncListing[]> {
  const rows = await queryAll<JobRow & { stage: ImportStage | null; mapped_product_id: string | null }>(db, `SELECT j.*, m.import_stage AS stage, m.product_id AS mapped_product_id FROM airbnb_sync_jobs j
    LEFT JOIN ${AIRBNB_MAPPINGS} m ON m.organization_id = j.organization_id AND m.provider = 'channex' AND m.listing_id = j.listing_id
    WHERE j.organization_id = ? ORDER BY j.created_at, j.listing_id`, [organizationId])
  return rows.map(row => ({
    listing_id: row.listing_id,
    product_id: row.state === 'failed' ? row.product_id : row.product_id ?? row.mapped_product_id,
    action: row.action,
    status: row.state === 'done' ? 'done' : row.state === 'failed' ? 'failed'
      : row.stage !== null && row.stage !== 'draft' && row.stage !== 'complete' ? 'running' : 'queued',
    stage: row.stage,
    error: row.last_error_code && row.last_error ? { code: row.last_error_code, message: row.last_error } : null,
    updated_at: row.updated_at,
  }))
}

type Step = 'done' | 'continue' | 'later'

/** One step of a job: what the listing needs next to reach what was asked, as one ChannexConnection call. */
async function step(env: CloudflareEnv, db: DbClient, job: JobRow): Promise<Step> {
  // A sync acts for the person who asked; a stop writes nothing of theirs, so one Blawby asked for, or whose requester left, still runs.
  if (job.action === 'sync') {
    if (!job.requested_by) fail(409, 'REQUESTER_REMOVED', 'The person who asked for this sync is no longer a member; ask again')
    const membership = await resolveOrganizationMembership(env, { organizationId: job.organization_id, userId: job.requested_by })
    if (!membership) fail(409, 'REQUESTER_REMOVED', 'The person who asked for this sync is no longer a member; ask again')
    await assertRoleAllows({ organizationId: membership.organizationId, role: membership.role, permissions: { integrations: ['update'] }, message: 'The person who asked for this sync no longer has permission to manage Airbnb; ask again' })
  }
  const connection = new ChannexConnection(db, env, job.organization_id, job.requested_by ?? 'system')
  const mapping = await queryFirst<{ product_id: string; import_stage: ImportStage; enabled: number; channel_id: string; connected_channel_id: string | null }>(db,
    `SELECT m.product_id, m.import_stage, m.enabled, m.channel_id, c.channel_id AS connected_channel_id FROM ${AIRBNB_MAPPINGS} m
      LEFT JOIN channex_connections c ON c.organization_id = m.organization_id AND c.channel_id = m.channel_id AND c.status = 'connected'
      WHERE m.organization_id = ? AND m.provider = 'channex' AND m.listing_id = ?`, [job.organization_id, job.listing_id])
  if (job.action === 'sync') {
    if (job.product_id && mapping?.product_id !== job.product_id) {
      await connection.attach(job.listing_id, job.product_id)
      return 'continue'
    }
    if (!mapping || mapping.channel_id !== mapping.connected_channel_id) {
      // Prepare creates the mapping; the job retains only the host's explicitly requested destination.
      await connection.prepare(job.listing_id, { missingDetails: job.details ? JSON.parse(job.details) as Record<string, string> : {} })
      return 'continue'
    }
    if (mapping.import_stage === 'complete' && mapping.enabled === 1) {
      // A requested resync reads the actual source through the content hash guard, then publishes the canonical calendar.
      if ((await connection.refreshContent(job.listing_id)).channel_push?.state === 'pending') return 'later'
      await reportBillingUsage(env, db, job.organization_id)
      return 'done'
    }
    if (mapping.import_stage === 'complete') fail(409, 'IMPORT_NEEDS_REVIEW', 'This completed listing is not enabled. Review its Airbnb connection before syncing it again.')
    if (mapping.import_stage === 'draft') {
      await connection.activate(job.listing_id)
      return 'continue'
    }
    const progressed = await connection.advance(job.listing_id)
    if (progressed.stage === 'complete') {
      await reportBillingUsage(env, db, job.organization_id)
      return 'done'
    }
    return advanced(progressed)
  }
  if (!mapping || mapping.product_id !== job.product_id || mapping.channel_id !== mapping.connected_channel_id) {
    fail(404, 'IMPORT_NOT_FOUND', 'This home is not imported from your connected Airbnb account', { product_id: job.product_id })
  }
  if (mapping.import_stage === 'draft') {
    await reportBillingUsage(env, db, job.organization_id)
    return 'done'
  }
  if (mapping.import_stage === 'complete') {
    await connection.deactivate(job.listing_id)
    return 'done'
  }
  // A home being imported or activated is taken to where it rests first, then stopped.
  return advanced(await connection.advance(job.listing_id))
}

/** A stage asked again: the content stage has more photos to fetch now; any other waits for Channex to apply its last step. */
function advanced(result: { stage: ImportStage; waiting: boolean }): Step {
  return result.waiting && result.stage !== 'content' ? 'later' : 'continue'
}

/** An organization starts syncs only after its stops finish. */
async function resumeWaitingSyncs(env: CloudflareEnv, organizationId: string): Promise<void> {
  const waiting = await queryAll<{ id: string }>(env.DB, `SELECT id FROM airbnb_sync_jobs j
    WHERE j.organization_id = ? AND j.action = 'sync' AND j.state = 'pending'
      AND NOT EXISTS (SELECT 1 FROM airbnb_sync_jobs stop WHERE stop.organization_id = j.organization_id AND stop.action = 'stop' AND stop.state = 'pending')
    ORDER BY j.created_at, j.id`, [organizationId])
  for (const row of waiting) await publishAirbnbSync(env, { type: 'airbnb.sync_step', organization_id: organizationId, job_id: row.id })
}

/** Process one persisted listing change and send its continuation only when it has one. */
export async function advanceAirbnbSyncJob(env: CloudflareEnv, organizationId: string, jobId: string): Promise<void> {
  const db = env.DB
  const job = await queryFirst<JobRow & { waiting_for_stop: number }>(db, `SELECT j.*,
    EXISTS (SELECT 1 FROM airbnb_sync_jobs stop WHERE stop.organization_id = j.organization_id AND stop.action = 'stop' AND stop.state = 'pending') AS waiting_for_stop
    FROM airbnb_sync_jobs j WHERE j.organization_id = ? AND j.id = ?`, [organizationId, jobId])
  if (!job) return
  if (job.state !== 'pending') {
    if (job.action === 'stop') await resumeWaitingSyncs(env, organizationId)
    return
  }
  if (job.action === 'sync' && job.waiting_for_stop) return
  const message = { type: 'airbnb.sync_step' as const, organization_id: organizationId, job_id: jobId }
  let outcome: Step
  try {
    outcome = await step(env, db, job)
  } catch (error) {
    const data = error instanceof HTTPError ? error.data as { code?: unknown } | undefined : undefined
    const code = typeof data?.code === 'string' ? data.code : 'SYNC_STEP_FAILED'
    const message = error instanceof Error ? error.message : String(error)
    await execute(db, "UPDATE airbnb_sync_jobs SET state = 'failed', last_error_code = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
      [code, message, now(), job.id])
    if (job.action === 'stop') await resumeWaitingSyncs(env, organizationId)
    throw error
  }
  if (outcome === 'done') {
    if (job.action === 'sync') await scheduleBusinessWake(env, organizationId, 'channex_ari', Date.now())
    await execute(db, `UPDATE airbnb_sync_jobs SET state = 'done', last_error_code = NULL, last_error = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'`, [now(), now(), job.id])
    if (job.action === 'stop') await resumeWaitingSyncs(env, organizationId)
    return
  }
  await execute(db, 'UPDATE airbnb_sync_jobs SET updated_at = ? WHERE id = ? AND state = ?', [now(), job.id, 'pending'])
  await publishAirbnbSync(env, message, outcome === 'later' ? { delaySeconds: PROVIDER_SETTLE_SECONDS } : undefined)
}
