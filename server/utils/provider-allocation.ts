import { PUBLISHED_PROFILE_SQL } from '~/shared/member-scheduling'

/** Session commitment wins over the current offering assignment. */
export function sessionMemberSql(s: string): string {
  return `COALESCE(CASE WHEN ${s}.assigned_member_id IS NOT NULL AND (EXISTS(SELECT 1 FROM bookings committed WHERE committed.product_session_id=${s}.id AND committed.organization_id=${s}.organization_id AND committed.status IN ('pending','confirmed')) OR EXISTS(SELECT 1 FROM payment_checkout_holds committed WHERE committed.session_id=${s}.id AND committed.organization_id=${s}.organization_id AND committed.status='active' AND committed.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) THEN ${s}.assigned_member_id END, (SELECT CASE WHEN c.assigned_team_id IS NULL THEN CASE WHEN ${s}.assigned_member_id IS NULL OR ${s}.assigned_member_id=c.assigned_member_id THEN c.assigned_member_id END ELSE (SELECT m.id FROM member m JOIN teamMember tm ON tm.userId=m.userId JOIN team t ON t.id=tm.teamId AND t.organizationId=m.organizationId WHERE t.id=c.assigned_team_id AND m.organizationId=c.organization_id AND m.id=${s}.assigned_member_id) END FROM product_booking_configs c WHERE c.organization_id=${s}.organization_id AND c.product_id=${s}.product_id AND c.scheduling_mode='provider'))`
}

/**
 * Each use of `providerUnavailableSql` binds the same parameter twice: the JSON
 * `memberAvailabilityJson` returned for the span the sessions lie in. Bind it
 * with `providerAvailabilityParams` where the predicate falls in the statement.
 */
export const PROVIDER_AVAILABILITY_PARAMS_PER_USE = 2
export function providerAvailabilityParams(availabilityJson: string, uses = 1): string[] {
  return Array.from({ length: uses * PROVIDER_AVAILABILITY_PARAMS_PER_USE }, () => availabilityJson)
}

/**
 * One occupancy per distinct Session. Group attendees share capacity.
 * A provider is available for a session when their hours cover it, no time off
 * overlaps it, and, when they check a Google calendar, nothing there is busy
 * across it. Hours and busy times come from the bound availability JSON; a
 * provider absent from it has no windows there and is unavailable.
 */
export function providerUnavailableSql(s: string, replacingBooking = 'NULL', convertingPayment = 'NULL', member = sessionMemberSql(s)): string {
  // Inside the member_scheduling subquery the provider is `ms.member_id`; naming it
  // through ${member} again would deepen an expression SQLite already bounds.
  const entry = `'$."' || ms.member_id || '"'`
  return `((EXISTS (SELECT 1 FROM products consultation WHERE consultation.id=${s}.product_id AND consultation.organization_id=${s}.organization_id AND consultation.kind='service') AND (
    NOT EXISTS (SELECT 1 FROM product_booking_configs legal WHERE legal.product_id=${s}.product_id AND legal.organization_id=${s}.organization_id AND legal.scheduling_mode='provider')
    OR ${member} IS NULL
    OR NOT EXISTS (SELECT 1 FROM member_scheduling ms WHERE ms.member_id=${member} AND ms.organization_id=${s}.organization_id AND ${PUBLISHED_PROFILE_SQL})
  )) OR ((EXISTS(SELECT 1 FROM product_booking_configs c WHERE c.organization_id=${s}.organization_id AND c.product_id=${s}.product_id AND c.scheduling_mode='provider') OR ${s}.assigned_member_id IS NOT NULL) AND ${member} IS NULL) OR (${member} IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM member_scheduling ms JOIN member m ON m.id=ms.member_id AND m.organizationId=ms.organization_id
      WHERE ms.member_id=${member} AND ms.organization_id=${s}.organization_id AND ms.timezone IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each(?, ${entry} || '.windows') w WHERE json_extract(w.value,'$.start')<=${s}.starts_at AND json_extract(w.value,'$.end')>=${s}.ends_at)
      AND NOT EXISTS (SELECT 1 FROM json_each(ms.time_off_json) t WHERE json_extract(t.value,'$.start')<${s}.ends_at AND json_extract(t.value,'$.end')>${s}.starts_at)
      AND (ms.calendar_account_id IS NULL OR json_array_length(ms.calendar_ids_json)=0 OR (
        EXISTS (SELECT 1 FROM account a WHERE a.id=ms.calendar_account_id AND a.userId=m.userId AND a.providerId='google')
        AND NOT EXISTS (SELECT 1 FROM json_each(?, ${entry} || '.busy') busy WHERE json_extract(busy.value,'$.start')<${s}.ends_at AND json_extract(busy.value,'$.end')>${s}.starts_at))))
    OR EXISTS (SELECT 1 FROM bookings b JOIN product_sessions occupied ON occupied.id=b.product_session_id AND occupied.organization_id=b.organization_id
      WHERE b.organization_id=${s}.organization_id AND b.assigned_member_id=${member} AND b.status IN ('pending','confirmed')
      AND b.id IS NOT ${replacingBooking} AND occupied.id<>${s}.id AND occupied.starts_at<${s}.ends_at AND occupied.ends_at>${s}.starts_at)
    OR EXISTS (SELECT 1 FROM payment_checkout_holds h WHERE h.organization_id=${s}.organization_id AND h.assigned_member_id=${member}
      AND h.status='active' AND h.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND h.payment_id IS NOT ${convertingPayment}
      AND h.session_id<>${s}.id AND h.starts_at<${s}.ends_at AND h.ends_at>${s}.starts_at)
  )))`
}
