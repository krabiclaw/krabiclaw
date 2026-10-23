import { HTTPError } from 'nitro'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { countActiveHomes, homeAllowance, homesQuote, homeLimit, liveHomeSql } from '~/server/utils/billing'
import { AirbnbConnection, type ImportStage } from './airbnb-connection'
import { ChannexError } from './client'

/**
 * Which of an organization's Airbnb listings sync, done in the background. The
 * app posts the change once: listings to sync (imported as homes if they are
 * not yet, then made live) and homes to stop syncing (back to free drafts).
 * The plan is checked for the whole change before anything is queued. Each
 * listing is then one row of airbnb_sync_jobs, leased, retried and advanced by
 * the airbnb-sync cron task the way google_calendar_cleanup_jobs are, through
 * the same AirbnbConnection steps an import has always taken, so a run that is
 * interrupted carries on from the stage it reached.
 */

export interface AirbnbSyncListing {
  listing_id: string
  product_id: string | null
  action: 'sync' | 'stop'
  status: 'queued' | 'running' | 'done' | 'failed'
  stage: ImportStage | null
  error: { code: string; message: string } | null
  /** Attempts so far, and when the next retry of a transient failure runs; null when none is due. */
  attempts: number
  next_attempt_at: string | null
  updated_at: string
}

interface JobRow {
  id: string
  organization_id: string
  listing_id: string
  product_id: string | null
  action: 'sync' | 'stop'
  details: string | null
  state: 'pending' | 'error' | 'done' | 'failed'
  requested_by: string | null
  attempts: number
  last_error_code: string | null
  last_error: string | null
  lease_until: string | null
  next_attempt_at: string | null
  updated_at: string
}

/** How long a claimed job is held by its run; each step renews it. */
const LEASE_MS = 120_000
/** A cron run stops starting steps after this, so runs two minutes apart never overlap. */
export const CRON_SLICE_MS = 100_000
/** Transient failures are retried this many times in all before the job fails. */
const MAX_ATTEMPTS = 8

/**
 * Whether a failure is transient, so the job retries it on its own: the
 * network, or a provider answering 5xx or 429. Anything else is the same on
 * every retry (a refusal, a missing detail, a verification that did not hold)
 * and fails the job until a new request names the listing.
 */
function transient(error: unknown): boolean {
  if (error instanceof ChannexError) return error.status === 429 || error.status >= 500
  if (error instanceof HTTPError) return (error.status === 429 || error.status >= 500) && (error.data as { code?: unknown } | undefined)?.code !== 'PROVIDER_VERIFICATION_FAILED'
  return error instanceof TypeError
}

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
  const connection = new AirbnbConnection(db, env, organizationId, userId)
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

  const at = now()
  const queued = [...items.map(item => ({ listing: item.listing_id, product: productOf(item.listing_id) ?? null, action: 'sync' as const, details: item.details ? JSON.stringify(item.details) : null })),
    ...stopped.map(listing => ({ listing: listing.id, product: productOf(listing.id) ?? null, action: 'stop' as const, details: null }))]
  // A request clears any run's lease, so a run still on the old request writes nothing over this one.
  for (const job of queued) {
    await execute(db, `INSERT INTO airbnb_sync_jobs (id, organization_id, listing_id, product_id, action, details, state, requested_by, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)
      ON CONFLICT (organization_id, listing_id) DO UPDATE SET action = excluded.action, details = excluded.details, state = 'pending', requested_by = excluded.requested_by,
        product_id = COALESCE(excluded.product_id, airbnb_sync_jobs.product_id), attempts = 0, last_error_code = NULL, last_error = NULL,
        next_attempt_at = NULL, completed_at = NULL, lease_token = NULL, lease_until = NULL, updated_at = excluded.updated_at`,
    [crypto.randomUUID(), organizationId, job.listing, job.product, job.action, job.details, userId, at, at])
  }
  const named = new Set(queued.map(job => job.listing))
  return (await readAirbnbSync(db, organizationId)).filter(listing => named.has(listing.listing_id))
}

/** Every listing this organization asked to sync or stop, with where each stands. */
export async function readAirbnbSync(db: DbClient, organizationId: string): Promise<AirbnbSyncListing[]> {
  const rows = await queryAll<JobRow & { stage: ImportStage | null }>(db, `SELECT j.*, m.import_stage AS stage FROM airbnb_sync_jobs j
    LEFT JOIN product_channel_mappings m ON m.organization_id = j.organization_id AND m.provider = 'channex' AND m.listing_id = j.listing_id
    WHERE j.organization_id = ? ORDER BY j.created_at, j.listing_id`, [organizationId])
  const at = now()
  return rows.map(row => ({
    listing_id: row.listing_id,
    product_id: row.product_id,
    action: row.action,
    status: row.state === 'done' ? 'done' : row.state === 'failed' ? 'failed'
      : (row.lease_until !== null && row.lease_until > at) || (row.stage !== null && row.stage !== 'draft' && row.stage !== 'complete') ? 'running' : 'queued',
    stage: row.stage,
    error: row.last_error_code && row.last_error ? { code: row.last_error_code, message: row.last_error } : null,
    attempts: row.attempts,
    next_attempt_at: row.state === 'error' ? row.next_attempt_at : null,
    updated_at: row.updated_at,
  }))
}

type Step = 'done' | 'continue' | 'later'

/** One step of a job: what the listing needs next to reach what was asked, as one AirbnbConnection call. */
async function step(env: CloudflareEnv, db: DbClient, job: JobRow, lease: string): Promise<Step> {
  if (!job.requested_by) fail(409, 'REQUESTER_REMOVED', 'The person who asked for this sync is no longer a member; ask again')
  const connection = new AirbnbConnection(db, env, job.organization_id, job.requested_by)
  const mapping = await queryFirst<{ product_id: string; import_stage: ImportStage; enabled: number }>(db,
    "SELECT product_id, import_stage, enabled FROM product_channel_mappings WHERE organization_id = ? AND provider = 'channex' AND listing_id = ?", [job.organization_id, job.listing_id])
  if (mapping && mapping.product_id !== job.product_id) {
    await execute(db, 'UPDATE airbnb_sync_jobs SET product_id = ? WHERE id = ? AND lease_token = ?', [mapping.product_id, job.id, lease])
    job.product_id = mapping.product_id
  }
  if (job.action === 'sync') {
    if (!mapping) {
      // The fields Airbnb leaves out come from the request's details, contact details from the organization; anything still missing fails this listing with its field.
      const prepared = await connection.prepare(job.listing_id, { missingDetails: job.details ? JSON.parse(job.details) as Record<string, string> : {} })
      await execute(db, 'UPDATE airbnb_sync_jobs SET product_id = ? WHERE id = ? AND lease_token = ?', [prepared.product_id, job.id, lease])
      job.product_id = prepared.product_id
      return 'continue'
    }
    if (mapping.import_stage === 'complete') return 'done'
    if (mapping.import_stage === 'draft') {
      await connection.activate(mapping.product_id)
      return 'continue'
    }
    return advanced(await connection.advance(mapping.product_id))
  }
  if (!mapping || mapping.import_stage === 'draft') return 'done'
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
 * Advance due jobs until `until`: each is claimed with a lease, stepped until
 * it is done, has to wait for Channex, or the time is up, and released. A
 * transient failure (the network, a provider's 5xx or 429) is retried with the
 * calendar outbox's backoff up to MAX_ATTEMPTS; any other fails the job. A job whose connection is busy is left for
 * the next run.
 */
export async function runAirbnbSyncJobs(env: CloudflareEnv, until: number): Promise<{ stepped: number; done: number; failed: number }> {
  const db = env.DB
  const totals = { stepped: 0, done: 0, failed: 0 }
  const due = await queryAll<JobRow>(db, `SELECT * FROM airbnb_sync_jobs WHERE state IN ('pending', 'error')
    AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (lease_until IS NULL OR lease_until <= ?)
    ORDER BY COALESCE(next_attempt_at, created_at), id`, [now(), now()])
  for (const job of due) {
    if (Date.now() >= until) break
    const lease = crypto.randomUUID()
    const claimed = await execute(db, `UPDATE airbnb_sync_jobs SET lease_token = ?, lease_until = ? WHERE id = ? AND state IN ('pending', 'error') AND (lease_until IS NULL OR lease_until <= ?)`,
      [lease, new Date(Date.now() + LEASE_MS).toISOString(), job.id, now()])
    if (claimed.meta.changes !== 1) continue
    let outcome: Step = 'continue'
    try {
      while (outcome === 'continue' && Date.now() < until) {
        // The request may have changed while this run held the job: it always acts on the latest.
        const current = await queryFirst<JobRow>(db, 'SELECT * FROM airbnb_sync_jobs WHERE id = ? AND lease_token = ?', [job.id, lease])
        if (!current) break
        outcome = await step(env, db, current, lease)
        totals.stepped++
        await execute(db, 'UPDATE airbnb_sync_jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND lease_token = ?', [new Date(Date.now() + LEASE_MS).toISOString(), now(), job.id, lease])
      }
      if (outcome === 'done') {
        totals.done++
        await execute(db, `UPDATE airbnb_sync_jobs SET state = 'done', last_error_code = NULL, last_error = NULL, next_attempt_at = NULL, lease_token = NULL, lease_until = NULL,
          completed_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?`, [now(), now(), job.id, lease])
      } else {
        // Waiting on Channex, or out of time: the next run carries on from the same stage.
        await execute(db, `UPDATE airbnb_sync_jobs SET next_attempt_at = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND lease_token = ?`,
          [outcome === 'later' ? new Date(Date.now() + 30_000).toISOString() : null, now(), job.id, lease])
      }
    } catch (error) {
      const data = error instanceof HTTPError ? error.data as { code?: unknown } | undefined : undefined
      const code = typeof data?.code === 'string' ? data.code : 'SYNC_STEP_FAILED'
      const message = error instanceof Error ? error.message : String(error)
      if (code === 'CONNECTION_BUSY') {
        // Another step of this organization holds the connection: not a failure of this listing.
        await execute(db, `UPDATE airbnb_sync_jobs SET next_attempt_at = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND lease_token = ?`,
          [new Date(Date.now() + 30_000).toISOString(), now(), job.id, lease])
        continue
      }
      totals.failed++
      const final = !transient(error) || job.attempts + 1 >= MAX_ATTEMPTS
      await execute(db, `UPDATE airbnb_sync_jobs SET state = ?, last_error_code = ?, last_error = ?, attempts = attempts + 1, next_attempt_at = ?,
        lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND lease_token = ?`,
      [final ? 'failed' : 'error', code, message, final ? null : new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(job.attempts, 7))).toISOString(), now(), job.id, lease])
    }
  }
  return totals
}
