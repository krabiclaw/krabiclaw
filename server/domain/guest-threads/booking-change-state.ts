import { queryAll, type DbClient } from '~/server/db'
import { BOOKED_RECORDS_SQL } from '~/server/domain/requests'

export type BookingChangeStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'stale' | 'expired'
export interface BookingChangeState { status: BookingChangeStatus; decisionId: string | null; message?: string }

/** Compare the immutable source shown to the client with its current canonical record. */
function sourceMatchesSql(proposal: string, owner: string): string {
  const recorded = ['recordKind', 'assignedMemberId', 'sessionId', 'operationalUpdatedAt', 'recordId', 'status', 'partySize', 'startsAt', 'endsAt', 'timezone', 'locationId', 'productId', 'partySizeIsMinimum', 'notes', 'guest.name', 'guest.email', 'guest.phone']
    .map(field => `json_extract(${proposal}.payload_json,'$.before.${field}')`).join(',')
  const guest = ['party_size_is_minimum', 'notes', 'guest.name', 'guest.email', 'guest.phone'].map(field => `json_extract(${owner}.payload_json,'$.${field}')`).join(',')
  // A reservation records no operational update time in its source; only a booking's is compared.
  return `EXISTS (SELECT 1 FROM ${BOOKED_RECORDS_SQL} br WHERE br.request_id=${owner}.id AND br.organization_id=${owner}.organization_id AND br.kind=${owner}.kind AND br.kind<>'stay'
        AND json_array(br.kind,br.assigned_member_id,br.product_session_id,CASE br.kind WHEN 'booking' THEN br.updated_at END,br.id,br.status,br.party_size,br.starts_at,br.ends_at,br.timezone,br.location_id,br.product_id,${guest})=json_array(${recorded}))`
}

/**
 * The single proposal lifecycle read: decision, elapsed validity, then source
 * staleness. A stay's change is its guest's request on their channel, which
 * answers and expires it there, so until answered it is pending.
 */
function statusSql(proposal: string, owner: string, decision: string, now: string): string {
  return `(CASE
    WHEN ${decision}.event_name='booking_change.accepted' THEN 'accepted'
    WHEN ${decision}.event_name='booking_change.declined' THEN 'declined'
    WHEN ${decision}.event_name='booking_change.withdrawn' THEN 'withdrawn'
    WHEN ${decision}.id IS NOT NULL THEN json('Invalid booking change decision')
    WHEN ${owner}.kind='stay' THEN 'pending'
    WHEN julianday(${proposal}.occurred_at)+7<=julianday(${now})
      OR EXISTS (SELECT 1 FROM ${BOOKED_RECORDS_SQL} br WHERE br.request_id=${owner}.id AND br.organization_id=${owner}.organization_id AND br.kind<>'stay' AND br.ends_at<=${now}) THEN 'expired'
    WHEN ${proposal}.id IS NOT (SELECT latest.id FROM activity_entries latest WHERE latest.request_id=${owner}.id AND latest.event_name='booking_change.requested' ORDER BY latest.sequence DESC LIMIT 1)
      OR NOT ${sourceMatchesSql(proposal, owner)} THEN 'stale'
    ELSE 'pending' END)`
}

/** One app-clock instant is shared by all expressions in a read. The ISO value is generated here. */
function clockSql(now = new Date().toISOString()): string { return `'${new Date(now).toISOString()}'` }

const messages = {
  stale: 'This booking or proposal has changed since the request was sent. Ask the business for a new request.',
  expired: 'This change request has expired. Your appointment is unchanged.',
}

export async function bookingChangeStates(db: DbClient, proposalIds: string[], now = new Date().toISOString()): Promise<Map<string, BookingChangeState>> {
  const states = new Map<string, BookingChangeState>()
  if (!proposalIds.length) return states
  const rows = await queryAll<{ id: string; status: BookingChangeStatus; decision_id: string | null }>(db, `SELECT proposal.id,decision.id decision_id,${statusSql('proposal', 'owner', 'decision', clockSql(now))} status
    FROM activity_entries proposal JOIN requests owner ON owner.id=proposal.request_id
    LEFT JOIN activity_entries decision ON decision.request_id=proposal.request_id AND decision.dedupe_key='booking-change-decision:'||proposal.id
    WHERE proposal.event_name='booking_change.requested' AND proposal.id IN (SELECT value FROM json_each(?))`, [JSON.stringify(proposalIds)])
  for (const row of rows) states.set(row.id, { status: row.status, decisionId: row.decision_id, ...(['stale', 'expired'].includes(row.status) ? { message: messages[row.status as 'stale' | 'expired'] } : {}) })
  return states
}
