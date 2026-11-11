import { expect, type APIRequestContext } from '@playwright/test'
import { seededTenant } from '../seed/manifest'
import { seededSiteHeaders, testBaseUrl } from '../test-env'

export type TableSeating = { id: string; starts_at: string; ends_at: string; location_id: string | null; timezone: string; remaining: number | null; is_full: boolean }

/** A seeded dining room's tables, as the restaurant seed made them: one table product per location. */
export function seededTables(location: 'brooklyn' | 'williamsburg' = 'brooklyn') {
  const tables = seededTenant('restaurant').products[`tables-${location}`]
  if (!tables) throw new Error(`The seeded restaurant has no tables at ${location}`)
  return tables
}

/** The seatings a guest is offered on the site, read through the product's public sessions. */
export async function tableSeatings(request: APIRequestContext, location: 'brooklyn' | 'williamsburg' = 'brooklyn') {
  const response = await request.get(`${testBaseUrl()}/api/public/products/${seededTables(location).slug}/sessions`, { headers: seededSiteHeaders('restaurant') })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json() as { sessions: TableSeating[] }).sessions
}

/** The first seating at least `afterMs` ahead with room for the party. */
export async function openSeating(request: APIRequestContext, partySize: number, afterMs = 0, location: 'brooklyn' | 'williamsburg' = 'brooklyn') {
  const seating = (await tableSeatings(request, location))
    .find(session => !session.is_full && (session.remaining === null || session.remaining >= partySize) && Date.parse(session.starts_at) > Date.now() + afterMs)
  if (!seating) throw new Error(`The seeded restaurant has no seating for ${partySize}`)
  return seating
}

/** A guest books a table on the site, as the booking form does. */
export async function bookTable(request: APIRequestContext, input: { name: string; email: string; phone: string; partySize: number; seating: TableSeating; location?: 'brooklyn' | 'williamsburg' }) {
  const response = await request.post(`${testBaseUrl()}/api/public/products/${seededTables(input.location).slug}/book`, { headers: seededSiteHeaders('restaurant'), data: {
    guest_name: input.name, guest_email: input.email, guest_phone: input.phone, product_session_id: input.seating.id, party_size: input.partySize, idempotency_key: crypto.randomUUID(),
  } })
  expect(response.status(), await response.text()).toBe(201)
  const body = await response.json() as { conversation_id: string; booking_id: string; cancellation_token: string; status: string }
  return { requestId: body.conversation_id, bookingId: body.booking_id, cancellationToken: body.cancellation_token, status: body.status }
}
