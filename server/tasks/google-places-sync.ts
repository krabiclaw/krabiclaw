import type { D1Database } from '@cloudflare/workers-types'
import { syncPlaceToLocation } from '~/server/utils/google-places'
import { queryAllPages } from '~/server/db'
import { recordUsageEvent } from '~/server/utils/usage-metering'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import type { CloudflareEnv } from '~/server/utils/auth'
import { filterEntitledRows } from '~/server/utils/billing-access'

// Google Places ratings are the scheduled exception. Do not copy this pattern for other providers.
// The routine Google Maps sync: for every location connected to a place, what
// Google owns about it — rating, review count, the Maps link and the review
// snapshot. The tenant's own details (address, phone, hours, timezone) are
// written only by connecting or by an explicit re-import.

interface SyncTaskContext {
  cloudflare?: { env?: ApiRecord }
}


interface PlaceLocationRow {
  id: string
  organization_id: string
  title: string
  google_place_id: string
}

interface PlacesSyncResult {
  location_id: string
  title: string
  organization_id: string
  reviews_upserted: number
  error?: string
}

interface TaskResult {
  locations: number
  passed: number
  failed: number
  details: PlacesSyncResult[]
}

export default defineScheduledTask({
  meta: {
    name: 'social:google-places-sync',
    description: 'Weekly sync of Google Maps ratings and reviews for all connected locations',
  },
  async run({ context }): Promise<{ result: TaskResult }> {
    const taskContext = context as SyncTaskContext | undefined
    const env = taskContext?.cloudflare?.env ?? {}
    const db = env.DB as D1Database | undefined

    const emptyResult: TaskResult = { locations: 0, passed: 0, failed: 0, details: [] }

    if (!db && import.meta.dev) {
      return { result: emptyResult }
    }
    if (!db) throw new Error('DB is required')

    const apiKey = env.GOOGLE_PLACES_API_KEY as string | undefined
    if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY is not configured')

    // Better Auth's subscription table is the authority for paid scheduled
    // integrations; candidates are selected here and filtered against it below.
    const candidates = await queryAllPages<PlaceLocationRow>(db, `
      SELECT bl.id, bl.organization_id, bl.title, bl.google_place_id
      FROM business_locations bl
      WHERE bl.google_place_id IS NOT NULL
        AND bl.status = 'active'
      ORDER BY bl.organization_id, bl.id
    `, [])
    const locations = await filterEntitledRows(env as CloudflareEnv, candidates, 'google_places')

    if (locations.length === 0) {
      return { result: emptyResult }
    }

    const syncResults: PlacesSyncResult[] = []
    const runId = crypto.randomUUID()

    for (const loc of locations) {
      const locResult: PlacesSyncResult = {
        location_id: loc.id,
        title: loc.title,
        organization_id: loc.organization_id,
        reviews_upserted: 0,
      }

      await recordUsageEvent(db, {
        organizationId: loc.organization_id,
        resource: 'scheduled_task',
        source: 'google_places_sync',
        provider: 'blawby',
        channel: 'google_places',
        quantity: 1,
        unit: 'location_sync',
        metadata: { task: 'social:google-places-sync', locationId: loc.id },
        idempotencyKey: `scheduled-task:${runId}:${loc.id}`,
      })

      try {
        const { reviewsUpserted } = await syncPlaceToLocation(
          db,
          apiKey,
          loc.organization_id,
          loc.id,
          loc.google_place_id,
          'provider',
        )
        locResult.reviews_upserted = reviewsUpserted
      } catch (err) {
        locResult.error = err instanceof Error ? err.message : String(err)
      }

      if (!locResult.error) {
        await recordUsageEvent(db, {
          organizationId: loc.organization_id,
          resource: 'maps_api',
          source: 'scheduled_task',
          provider: 'google',
          channel: 'places_sync',
          quantity: 1,
          unit: 'location_sync',
          metadata: { task: 'social:google-places-sync', locationId: loc.id },
          idempotencyKey: `maps-api:${runId}:${loc.id}`,
        })
      }

      syncResults.push(locResult)
    }

    const failed = syncResults.filter(r => r.error)
    if (failed.length) {
      throw new Error(`Google Maps sync failed for ${failed.length} of ${locations.length} locations: ${failed.map(r => `${r.location_id}: ${r.error}`).join('; ')}`)
    }
    return { result: { locations: locations.length, passed: syncResults.length, failed: 0, details: syncResults } }
  },
})
