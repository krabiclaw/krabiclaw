import { HTTPError } from 'nitro'
import { execute, executeBatch, MAX_D1_BATCH_STATEMENTS, queryAll, queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { countActiveHomes, homeAllowance, homesQuote, homeLimit, liveHomeSql, reportBillingUsage } from '~/server/utils/billing'
import { AirbnbConnection, type ImportStage } from './airbnb-connection'
import { ChannexError } from './client'
import { assertRoleAllows, resolveOrganizationMembership } from '~/server/utils/member-access'

/**
 * Which of an organization's Airbnb listings sync, done in the background. The
 * app posts the change once: listings to sync (imported as homes if they are
 * not yet, then made live) and homes to stop syncing (back to free drafts).
 * The plan is checked for the whole change before anything is queued. Each
 * listing is then one row of airbnb_sync_jobs, advanced by the airbnb-sync
 * cron task through the same AirbnbConnection steps an import has always
 * taken; the mapping's import_stage is where a job carries on from. A job is
 * done, or it failed with its error recorded until a new request names the
 * listing.
 */

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

/** A cron run stops starting steps after this, so runs two minutes apart never overlap. */
export const CRON_SLICE_MS = 100_000
/** Scheduling headroom for cron steps; the deadline still guards stalled I/O. */
const CRON_START_RESERVE_MS = 30_000

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
function syncItems(value: unknown): Array<{ listing_id: string; details: Record<string, string> | null }> {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(422, 'VALIDATION_ERROR', 'sync must be a list of {listing_id, details}', { field: 'sync' })
  const items = value.map((item, index) => {
    const record = item as Record<string, unknown> | null
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.listing_id !== 'string' || !record.listing_id.trim()
      || Object.keys(record).some(key => key !== 'listing_id' && key !== 'details')) fail(422, 'VALIDATION_ERROR', 'Each sync item is {listing_id, details}', { field: `sync[${index}]` })
    const details = record.details
    if (details !== undefined && (!details || typeof details !== 'object' || Array.isArray(details) || Object.values(details).some(field => typeof field !== 'string' || !field.trim()))) {
      fail(422, 'VALIDATION_ERROR', 'details must name listing fields, each as non-empty text', { field: `sync[${index}].details` })
    }
    return { listing_id: record.listing_id, details: details === undefined ? null : details as Record<string, string> }
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
export async function requestAirbnbSync(env: CloudflareEnv, db: DbClient, organizationId: string, userId: string, body: { sync?: unknown; stop?: unknown }): Promise<AirbnbSyncListing[]> {
  const items = syncItems(body.sync)
  const sync = items.map(item => item.listing_id)
  const stop = ids(body.stop, 'stop')
  if (!sync.length && !stop.length) fail(422, 'VALIDATION_ERROR', 'Name listings to sync or homes to stop', { field: 'sync' })
  if (sync.length + stop.length > MAX_D1_BATCH_STATEMENTS) fail(422, 'VALIDATION_ERROR', `Name at most ${MAX_D1_BATCH_STATEMENTS} listings and homes in one change`, { field: 'sync' })
  const connection = new AirbnbConnection(db, env, organizationId, userId)
  // Starting a sync is Business; stopping one never needs a plan.
  if (sync.length) await connection.requireChannelSync()
  const listings = await connection.listings()
  const unknownListing = sync.find(id => !listings.some(listing => listing.id === id))
  if (unknownListing) fail(404, 'LISTING_NOT_FOUND', 'This listing is not on your connected Airbnb account', { listing_id: unknownListing })
  // A listing's details may only hold the fields its listing details report missing, as the review asked for them.
  for (const item of items) {
    if (!item.details) continue
    const missing = (await connection.details(item.listing_id)).missingFields as string[]
    const extra = Object.keys(item.details).find(key => !missing.includes(key))
    if (extra) fail(422, 'ONLY_MISSING_DETAILS', 'Only the listing details Airbnb left out may be supplied', { listing_id: item.listing_id, field: `details.${extra}` })
  }
  const stopped = stop.map((productId) => {
    const listing = listings.find(row => row.import.status === 'imported' && row.import.product_id === productId)
    if (!listing) fail(404, 'IMPORT_NOT_FOUND', 'This home is not imported from your connected Airbnb account', { product_id: productId })
    return listing
  })
  const both = stopped.find(listing => sync.includes(listing.id))
  if (both) fail(422, 'VALIDATION_ERROR', 'A listing cannot be synced and stopped at once', { listing_id: both.id })

  // The live homes the change leaves: a synced listing is live; a stopped home stays live only while published on the site.
  const homes = await queryAll<{ product_id: string; live: number; published: number }>(db, `SELECT p.id AS product_id, ${liveHomeSql('p')} AS live,
      EXISTS (SELECT 1 FROM product_publications pp WHERE pp.organization_id = p.organization_id AND pp.product_id = p.id AND pp.published = 1) AS published
    FROM products p JOIN product_channel_mappings m ON m.organization_id = p.organization_id AND m.product_id = p.id AND m.provider = 'channex' WHERE p.organization_id = ?`, [organizationId])
  const home = (productId: string | undefined) => homes.find(row => row.product_id === productId)
  const productOf = (listingId: string) => {
    const listing = listings.find(row => row.id === listingId)!
    return listing.import.status === 'imported' ? listing.import.product_id : undefined
  }
  const adding = sync.filter(id => !home(productOf(id))?.live).length
  const leaving = stop.filter(id => home(id)?.live && !home(id)?.published).length
  if (adding > leaving && !(await homeAllowance(env, db, organizationId, adding - leaving)).allowed) {
    const refusal = homeLimit(await countActiveHomes(db, organizationId))
    throw new HTTPError({ statusCode: refusal.status, statusMessage: refusal.data.error, data: { ...refusal.data, quote: await homesQuote(env, db, organizationId, adding - leaving) } })
  }

  const queued = [...items.map(item => ({ listing: item.listing_id, product: productOf(item.listing_id) ?? null, action: 'sync' as const, details: item.details ? JSON.stringify(item.details) : null })),
    ...stopped.map(listing => ({ listing: listing.id, product: productOf(listing.id) ?? null, action: 'stop' as const, details: null }))]
  await queueJobs(db, organizationId, userId, queued)
  const named = new Set(queued.map(job => job.listing))
  return (await readAirbnbSync(db, organizationId)).filter(listing => named.has(listing.listing_id))
}

/**
 * Queue each listing's change, replacing any earlier request for it. A request
 * gives the row a new id, so a run still on the old request writes nothing
 * over this one. `requestedBy` is null only for a stop KrabiClaw asks for itself.
 */
async function queueJobs(db: DbClient, organizationId: string, requestedBy: string | null, jobs: Array<{ listing: string; product: string | null; action: 'sync' | 'stop'; details: string | null }>): Promise<void> {
  const at = now()
  await executeBatch(db, jobs.map(job => ({ query: `INSERT INTO airbnb_sync_jobs (id, organization_id, listing_id, product_id, action, details, state, requested_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT (organization_id, listing_id) DO UPDATE SET id = excluded.id, action = excluded.action, details = excluded.details, state = 'pending', requested_by = excluded.requested_by,
        product_id = COALESCE(excluded.product_id, airbnb_sync_jobs.product_id), last_error_code = NULL, last_error = NULL,
        completed_at = NULL, updated_at = excluded.updated_at`,
    params: [crypto.randomUUID(), organizationId, job.listing, job.product, job.action, job.details, requestedBy, at, at] })), { operation: 'Queue an Airbnb sync change' })
}

/**
 * Stop syncing these homes with Airbnb because the organization's paid plan
 * ended: queued as a stop no one asked for, which the airbnb-sync task runs as
 * it runs any other. Each must be a home imported from the connected account.
 */
export async function stopAirbnbSyncForPlanEnd(db: DbClient, organizationId: string, productIds: string[]): Promise<void> {
  if (!productIds.length) return
  const mappings = await queryAll<{ product_id: string; listing_id: string }>(db, `SELECT m.product_id, m.listing_id FROM product_channel_mappings m
    JOIN channex_connections c ON c.organization_id = m.organization_id AND c.channel_id = m.channel_id
    WHERE m.organization_id = ? AND m.provider = 'channex' AND m.product_id IN (SELECT value FROM json_each(?))`, [organizationId, JSON.stringify(productIds)])
  const missing = productIds.find(id => !mappings.some(row => row.product_id === id))
  if (missing) throw new Error(`Home ${missing} is not imported from the organization's connected Airbnb account`)
  // One batch holds at most D1's statements per batch; an organization past Basic may have more homes than that.
  for (let start = 0; start < mappings.length; start += MAX_D1_BATCH_STATEMENTS) {
    await queueJobs(db, organizationId, null, mappings.slice(start, start + MAX_D1_BATCH_STATEMENTS).map(row => ({ listing: row.listing_id, product: row.product_id, action: 'stop', details: null })))
  }
}

/** Every listing this organization asked to sync or stop, with where each stands. */
export async function readAirbnbSync(db: DbClient, organizationId: string): Promise<AirbnbSyncListing[]> {
  const rows = await queryAll<JobRow & { stage: ImportStage | null }>(db, `SELECT j.*, m.import_stage AS stage FROM airbnb_sync_jobs j
    LEFT JOIN product_channel_mappings m ON m.organization_id = j.organization_id AND m.provider = 'channex' AND m.listing_id = j.listing_id
    WHERE j.organization_id = ? ORDER BY j.created_at, j.listing_id`, [organizationId])
  return rows.map(row => ({
    listing_id: row.listing_id,
    product_id: row.product_id,
    action: row.action,
    status: row.state === 'done' ? 'done' : row.state === 'failed' ? 'failed'
      : row.stage !== null && row.stage !== 'draft' && row.stage !== 'complete' ? 'running' : 'queued',
    stage: row.stage,
    error: row.last_error_code && row.last_error ? { code: row.last_error_code, message: row.last_error } : null,
    updated_at: row.updated_at,
  }))
}

type Step = 'done' | 'continue' | 'later'

/** One step of a job: what the listing needs next to reach what was asked, as one AirbnbConnection call. */
async function step(env: CloudflareEnv, db: DbClient, job: JobRow, signal: AbortSignal): Promise<Step> {
  // A sync acts for the person who asked; a stop writes nothing of theirs, so one KrabiClaw asked for, or whose requester left, still runs.
  if (job.action === 'sync') {
    if (!job.requested_by) fail(409, 'REQUESTER_REMOVED', 'The person who asked for this sync is no longer a member; ask again')
    const membership = await resolveOrganizationMembership(env, { organizationId: job.organization_id, userId: job.requested_by })
    if (!membership) fail(409, 'REQUESTER_REMOVED', 'The person who asked for this sync is no longer a member; ask again')
    await assertRoleAllows({ organizationId: membership.organizationId, role: membership.role, permissions: { integrations: ['update'] }, message: 'The person who asked for this sync no longer has permission to manage Airbnb; ask again' })
  }
  const connection = new AirbnbConnection(db, env, job.organization_id, job.requested_by ?? 'system', signal)
  const mapping = await queryFirst<{ product_id: string; import_stage: ImportStage; enabled: number; channel_id: string; connected_channel_id: string | null }>(db,
    `SELECT m.product_id, m.import_stage, m.enabled, m.channel_id, c.channel_id AS connected_channel_id FROM product_channel_mappings m
      LEFT JOIN channex_connections c ON c.organization_id = m.organization_id
      WHERE m.organization_id = ? AND m.provider = 'channex' AND m.listing_id = ?`, [job.organization_id, job.listing_id])
  if (mapping && mapping.product_id !== job.product_id) {
    await execute(db, 'UPDATE airbnb_sync_jobs SET product_id = ? WHERE id = ?', [mapping.product_id, job.id])
    job.product_id = mapping.product_id
  }
  if (job.action === 'sync') {
    if (!mapping || mapping.channel_id !== mapping.connected_channel_id) {
      // The fields Airbnb leaves out come from the request's details, contact details from the organization; anything still missing fails this listing with its field.
      const prepared = await connection.prepare(job.listing_id, { missingDetails: job.details ? JSON.parse(job.details) as Record<string, string> : {} })
      await execute(db, 'UPDATE airbnb_sync_jobs SET product_id = ? WHERE id = ?', [prepared.product_id, job.id])
      job.product_id = prepared.product_id
      return 'continue'
    }
    if (mapping.import_stage === 'complete' && mapping.enabled === 1) {
      // A requested resync reads the actual source through the content hash guard, then publishes the canonical calendar.
      if ((await connection.refreshContent(mapping.product_id)).channel_push?.state === 'pending') return 'later'
      await reportBillingUsage(env, db, job.organization_id)
      return 'done'
    }
    if (mapping.import_stage === 'complete') fail(409, 'IMPORT_NEEDS_REVIEW', 'This completed listing is not enabled. Review its Airbnb connection before syncing it again.')
    if (mapping.import_stage === 'draft') {
      await connection.activate(mapping.product_id)
      return 'continue'
    }
    return advanced(await connection.advance(mapping.product_id))
  }
  if (!mapping || mapping.import_stage === 'draft') {
    await reportBillingUsage(env, db, job.organization_id)
    return 'done'
  }
  if (mapping.import_stage === 'complete') {
    await connection.deactivate(mapping.product_id)
    return 'done'
  }
  // A home being imported or activated is taken to where it rests first, then stopped.
  return advanced(await connection.advance(mapping.product_id))
}

/** A stage asked again: the content stage has more photos to fetch now; any other waits for Channex to apply its last step. */
function advanced(result: { stage: ImportStage; waiting: boolean }): Step {
  return result.waiting && result.stage !== 'content' ? 'later' : 'continue'
}

/**
 * Advance pending jobs. New steps stop at the cron's launch cutoff; an
 * already-started step keeps its stall guard until `until`. A job that is
 * waiting on Channex or out of its start window stays pending and the next
 * run carries on from the stage its mapping reached. A step that throws fails
 * the job with its error until a new request names the listing. A job whose
 * connection is busy is left for the next run.
 */
export async function runAirbnbSyncJobs(env: CloudflareEnv, until: number, options: { startReserveMs?: number } = {}): Promise<{ stepped: number; done: number; failed: number }> {
  const db = env.DB
  const totals = { stepped: 0, done: 0, failed: 0 }
  const startBy = until - (options.startReserveMs ?? CRON_START_RESERVE_MS)
  // Stops first: the plan admitted this whole change after subtracting its stopped homes, and
  // until they are stopped, activating a replacement would spend their allowance twice.
  const due = await queryAll<JobRow>(db, `SELECT * FROM airbnb_sync_jobs WHERE state = 'pending'
    ORDER BY CASE action WHEN 'stop' THEN 0 ELSE 1 END, created_at, id`)
  for (const job of due) {
    if (Date.now() >= startBy) break
    if (job.action === 'sync' && await queryFirst(db, "SELECT 1 FROM airbnb_sync_jobs WHERE organization_id = ? AND action = 'stop' AND state = 'pending'", [job.organization_id])) continue
    const signal = AbortSignal.timeout(Math.max(0, until - Date.now()))
    const operationEnv = { ...env, requestSignal: signal }
    let outcome: Step = 'continue'
    try {
      while (outcome === 'continue' && Date.now() < startBy) {
        // A newer request replaces this job's id; this run must not complete it.
        const current = await queryFirst<JobRow>(db, "SELECT * FROM airbnb_sync_jobs WHERE id = ? AND state = 'pending'", [job.id])
        if (!current || Date.now() >= startBy) break
        outcome = await step(operationEnv, db, current, signal)
        totals.stepped++
        await execute(db, 'UPDATE airbnb_sync_jobs SET updated_at = ? WHERE id = ?', [now(), job.id])
      }
      if (outcome === 'done') {
        const completed = await execute(db, `UPDATE airbnb_sync_jobs SET state = 'done', last_error_code = NULL, last_error = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND state = 'pending'`, [now(), now(), job.id])
        totals.done += completed.meta.changes
      }
    } catch (error) {
      // H3 retains constructor details in cause, including the original provider cause.
      const failure = error instanceof HTTPError && error.data?.code === 'POST_WRITE_COMPLETION_FAILED' && error.data?.field === 'billing_usage' && error.data?.committed === true ? (error.cause as { cause: unknown }).cause : error
      const data = failure instanceof HTTPError || failure instanceof ChannexError ? failure.data as { code?: unknown } | undefined : undefined
      const code = typeof data?.code === 'string' ? data.code : signal.aborted ? 'SYNC_SLICE_ENDED' : 'SYNC_STEP_FAILED'
      // Another step of this organization holds the connection: not a failure of this listing.
      if (code === 'CONNECTION_BUSY') continue
      const message = error instanceof Error ? error.message : String(error)
      const failed = await execute(db, "UPDATE airbnb_sync_jobs SET state = 'failed', last_error_code = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
        [code, message, now(), job.id])
      totals.failed += failed.meta.changes
    }
  }
  return totals
}
