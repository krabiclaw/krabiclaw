import { jsonResponse, readRequiredBody, rethrowHttpError } from '~/server/utils/api-response'
import { requireLocationAccess } from '~/server/utils/location-access'
import { renderBookingPolicySummary, reservationPolicySummarySource, upsertLocationReservationConfig, validateLocationReservationConfigPatch } from '~/server/utils/reservations'
import { getSourceLocale } from '~/server/utils/organization-locales'
import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'

/** Creating this row is what enables reservations at the location. */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const locationId = getRouterParam(event, 'locationId')
  if (!organizationId || !locationId) return jsonResponse({ error: 'Organization ID and location ID are required' }, { status: 400 })
  try {
    const { env, db, session, organization } = await requireLocationAccess(event, organizationId, locationId)
    const { expected_updated_at, ...fields } = await readRequiredBody<Record<string, unknown>>(event)
    if (expected_updated_at !== undefined && expected_updated_at !== null && typeof expected_updated_at !== 'string') return jsonResponse({ error: 'expected_updated_at must be a timestamp or null' }, { status: 400 })
    const patch = await validateLocationReservationConfigPatch(fields)
    const config = await upsertLocationReservationConfig(db, {
      env, organizationId: organization.id, locationId, patch, actorId: session.user.id, expectedUpdatedAt: expected_updated_at as string | null | undefined,
    })
    const locale = await getSourceLocale(db, organization.id)
    return jsonResponse({ success: true, config, summary: renderBookingPolicySummary(reservationPolicySummarySource(config), locale) })
  } catch (error) {
    rethrowHttpError(error)
    console.error('reservation_config_write_failed', { organizationId, locationId, error: error instanceof Error ? error.message : String(error) })
    return jsonResponse({ error: 'Failed to save the reservation policy' }, { status: 500 })
  }
})
