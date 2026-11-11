-- Data copy for the v26 to v27 replacement. Run by transfer-database-export.mjs.

-- stage: reservations
-- ===========================================================================
-- Data move: table reservations become bookings of a `table` product.
--
-- PRECONDITIONS (the combined migration owns these; this file only moves data)
--
--  1. It runs inside the combined migration, in one transaction, AFTER the new
--     columns exist and BEFORE anything old is dropped:
--       product_booking_configs: party_size_min, party_size_max,
--         minimum_guest_age, accessibility_contact_required (DEFAULT 0 NOT NULL),
--         payment_basis (DEFAULT 'per_guest' NOT NULL), payment_min_party_size
--       bookings.policy_json: add it NULLABLE first
--         (ALTER TABLE bookings ADD COLUMN policy_json TEXT). This file fills it
--         for every row; the migration's later rebuild of `bookings`
--         (__new_bookings + INSERT ... SELECT, which drizzle generates for a
--         NOT NULL column without a default) then enforces NOT NULL and
--         bookings_policy_check.
--       products: products_kind_check already admits 'table' (the products
--         rebuild for the new PRODUCT_KINDS runs before this file).
--     Still present while it runs: reservations, location_reservation_configs,
--     business_locations.assigned_member_id / max_capacity,
--     payment_checkout_holds.converted_reservation_id,
--     google_calendar_event_links.booking_kind. The migration drops/rebuilds
--     them after this file (their rebuilds also re-check every new CHECK, e.g.
--     payment_holds_subject_check, scheduled_guest_messages_subject_check).
--
--  2. review_requests has a composite foreign key onto
--     requests(organization_id, id, kind). Changing requests.kind and
--     review_requests.booking_type is only consistent once both are written, so
--     foreign keys are deferred to the end of the transaction. D1 supports this
--     pragma inside a migration's transaction.
--
-- Identifiers are derived, so a rerun and every cross-reference agree:
--   table product   'table-'         || location_id
--   default variant 'table-variant-' || location_id
--   price           'table-price-'   || location_id
--   rule            'table-rule-'    || location_id || '-' || weekday || '-' || start_time
--   session         'table-session-' || location_id || '-' || starts_at
--
-- Production at authoring: 5 location_reservation_configs, 49 reservations.
-- ===========================================================================



-- ---------------------------------------------------------------------------
-- 1. One table product per location that takes reservations.
-- ---------------------------------------------------------------------------

-- The slug is 'table-<location slug>'; if the business already has a product
-- with that slug, the location id's first eight hex digits are appended.
INSERT INTO products (id, organization_id, kind, details_json, name, slug, description, active, marketing_features, metadata, created_at, updated_at, created_by, updated_by)
SELECT 'table-' || c.location_id, c.organization_id, 'table', '{}',
       'Tables at ' || l.title,
       CASE WHEN EXISTS (SELECT 1 FROM products p WHERE p.organization_id = c.organization_id AND p.slug = 'table-' || l.slug AND p.id <> 'table-' || c.location_id)
            THEN 'table-' || l.slug || '-' || lower(substr(replace(c.location_id, '-', ''), 1, 8))
            ELSE 'table-' || l.slug END,
       '', 1, '[]', '{}', c.created_at, c.updated_at, c.created_by, c.updated_by
  FROM location_reservation_configs c
  JOIN business_locations l ON l.id = c.location_id AND l.organization_id = c.organization_id WHERE true
ON CONFLICT (id) DO NOTHING;

INSERT INTO product_variants (id, organization_id, product_id, name, sku, active, sort_order, created_at, updated_at, created_by, updated_by)
SELECT 'table-variant-' || c.location_id, c.organization_id, 'table-' || c.location_id, 'Table', NULL, 1, 0, c.created_at, c.updated_at, c.created_by, c.updated_by
  FROM location_reservation_configs c WHERE true
ON CONFLICT (id) DO NOTHING;

-- The deposit is the table's price, charged once per booking (payment_basis
-- 'per_booking' below). A location without a deposit gets an explicit free
-- price: a variant with no price row is not purchasable. A deposit is in the
-- currency the owner set; the verification at the end refuses one that is not
-- the business's own currency, because the booking flow prices in that one.
INSERT INTO prices (id, organization_id, product_variant_id, location_id, active, currency, unit_amount, type, tax_behavior, source, created_at, updated_at, created_by, updated_by)
SELECT 'table-price-' || c.location_id, c.organization_id, 'table-variant-' || c.location_id, NULL, 1,
       CASE WHEN c.deposit_required = 1 THEN c.deposit_currency ELSE o.default_currency END,
       CASE WHEN c.deposit_required = 1 THEN c.deposit_amount ELSE 0 END,
       'one_time', CASE WHEN c.deposit_required = 1 THEN COALESCE(c.deposit_tax_behavior, 'unspecified') ELSE 'unspecified' END,
       'manual', c.created_at, c.updated_at, c.created_by, c.updated_by
  FROM location_reservation_configs c
  JOIN organization o ON o.id = c.organization_id WHERE true
ON CONFLICT (id) DO NOTHING;

-- Published, so the reservations page offers it as it offered the location.
INSERT INTO product_publications (organization_id, product_id, published, created_at, updated_at, created_by, updated_by)
SELECT c.organization_id, 'table-' || c.location_id, 1, c.created_at, c.updated_at, c.created_by, c.updated_by
  FROM location_reservation_configs c WHERE true
ON CONFLICT (product_id, organization_id) DO NOTHING;

INSERT INTO product_locations (organization_id, product_id, location_id, active, published, created_at, updated_at, created_by, updated_by)
SELECT c.organization_id, 'table-' || c.location_id, c.location_id, 1, 1, c.created_at, c.updated_at, c.created_by, c.updated_by
  FROM location_reservation_configs c WHERE true
ON CONFLICT (product_id, location_id) DO NOTHING;

-- Who handles the tables: the location's assignee. A location with none gets
-- the business's earliest owner, because the booking settings writer refuses
-- a bookable product without a member (prepareProductBookingConfig).
INSERT INTO product_booking_configs (
  product_id, organization_id, unit, duration_minutes, default_capacity, confirmation_mode, online_payment_required, held_online,
  scheduling_mode, assigned_member_id, advance_notice_minutes, questions,
  party_size_min, party_size_max, minimum_guest_age, accessibility_contact_required, payment_basis, payment_min_party_size,
  created_at, updated_at, created_by, updated_by)
SELECT 'table-' || c.location_id, c.organization_id, 'slot', COALESCE(c.duration_minutes, 120), c.slot_capacity, 'instant',
       CASE WHEN c.deposit_required = 1 AND c.deposit_amount IS NOT NULL THEN 1 ELSE 0 END, 0,
       'business',
       COALESCE(l.assigned_member_id, (SELECT m.id FROM member m WHERE m.organizationId = c.organization_id AND m.role = 'owner' ORDER BY m.createdAt, m.id LIMIT 1)),
       NULLIF(c.advance_notice_minutes, 0), c.questions,
       NULL, NULL, c.minimum_guest_age, c.accessibility_contact_required, 'per_booking', c.deposit_trigger_party_size,
       c.created_at, c.updated_at, c.created_by, c.updated_by
  FROM location_reservation_configs c
  JOIN business_locations l ON l.id = c.location_id AND l.organization_id = c.organization_id WHERE true
ON CONFLICT (product_id) DO NOTHING;

-- The reservation questions' translations were the location's
-- 'reservation_questions'; a product's are its own 'questions'.
INSERT INTO resource_localizations (id, organization_id, resource_type, resource_id, locale, values_json, route_path, created_at, created_by_user_id, updated_at, updated_by_user_id)
SELECT 'table-localization-' || rl.resource_id || '-' || rl.locale, rl.organization_id, 'product', 'table-' || rl.resource_id, rl.locale,
       json_object('questions', json(json_extract(rl.values_json, '$.reservation_questions'))), NULL,
       rl.created_at, rl.created_by_user_id, rl.updated_at, rl.updated_by_user_id
  FROM resource_localizations rl
  JOIN location_reservation_configs c ON c.location_id = rl.resource_id AND c.organization_id = rl.organization_id
 WHERE rl.resource_type = 'business_location' AND json_type(rl.values_json, '$.reservation_questions') IS NOT NULL
ON CONFLICT (organization_id, resource_type, resource_id, locale) DO UPDATE SET
  values_json = json_set(resource_localizations.values_json, '$.questions', json(json_extract(excluded.values_json, '$.questions')));

UPDATE resource_localizations SET values_json = json_remove(values_json, '$.reservation_questions')
 WHERE resource_type = 'business_location' AND json_type(values_json, '$.reservation_questions') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Sessions for every instant a reservation, a reservation checkout hold or
--    a change proposal names. Sessions are hand-made rows (no rule, no
--    occurrence key); the generator's insert at the same instant leaves them
--    alone (product_sessions_location_instant_unique). A start shared by two
--    reservations is one session; its end is the latest of theirs.
-- ---------------------------------------------------------------------------
INSERT INTO product_sessions (id, organization_id, product_id, location_id, availability_rule_id, source_occurrence_key, timezone, starts_at, ends_at, capacity, status, created_at, updated_at, created_by, updated_by)
SELECT 'table-session-' || x.location_id || '-' || x.starts_at, x.organization_id, 'table-' || x.location_id, x.location_id, NULL, NULL,
       max(x.timezone), x.starts_at, max(x.ends_at), c.slot_capacity, 'scheduled', min(x.created_at), min(x.created_at), c.created_by, c.created_by
  FROM (
    SELECT organization_id, location_id, timezone, starts_at, ends_at, created_at FROM reservations
    UNION ALL
    SELECT h.organization_id, h.location_id, h.timezone, h.starts_at, h.ends_at, h.created_at
      FROM payment_checkout_holds h JOIN payments p ON p.id = h.payment_id
     WHERE p.subject_type = 'reservation' AND h.product_id IS NULL
    UNION ALL
    SELECT r.organization_id,
           COALESCE(json_extract(e.payload_json, '$.afterLocationId'), json_extract(e.payload_json, '$.after.locationId')),
           json_extract(e.payload_json, '$.afterTimezone'), json_extract(e.payload_json, '$.afterStartsAt'),
           COALESCE(json_extract(e.payload_json, '$.afterEndsAt'),
                    strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(e.payload_json, '$.afterStartsAt'),
                      '+' || (unixepoch(json_extract(e.payload_json, '$.before.endsAt')) - unixepoch(json_extract(e.payload_json, '$.before.startsAt'))) || ' seconds')),
           e.created_at
      FROM activity_entries e JOIN requests r ON r.id = e.request_id
     WHERE r.kind = 'reservation' AND e.event_name IN ('booking_change.requested', 'booking_change.moved')
       AND json_extract(e.payload_json, '$.afterStartsAt') IS NOT NULL AND json_extract(e.payload_json, '$.afterTimezone') IS NOT NULL
  ) x
  JOIN location_reservation_configs c ON c.location_id = x.location_id AND c.organization_id = x.organization_id
 WHERE true
 GROUP BY x.organization_id, x.location_id, x.starts_at
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Bookings.
-- ---------------------------------------------------------------------------

-- The frozen terms (server/utils/booking-policy-summary.ts BookingPolicy),
-- from the reservation's own snapshot (its policy_json, or for a paid one the
-- copy its checkout froze), else from its location's settings now.
INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, user_id, request_id, party_size, status,
                      cancelled_at, cancellation_reason, no_show_at, policy_json, created_at, updated_at)
SELECT r.id, r.organization_id, 'table-' || r.location_id, 'table-session-' || r.location_id || '-' || r.starts_at, 'table-variant-' || r.location_id,
       r.user_id, r.request_id, r.party_size, r.status, r.cancelled_at, r.cancellation_reason, r.no_show_at,
       json_object(
         'advance_notice_minutes', NULLIF(COALESCE(json_extract(s.terms, '$.advance_notice_minutes'), c.advance_notice_minutes), 0),
         'party_size_min', NULL, 'party_size_max', NULL,
         'minimum_guest_age', COALESCE(json_extract(s.terms, '$.minimum_guest_age'), c.minimum_guest_age),
         'accessibility_contact_required', json(CASE WHEN COALESCE(json_extract(s.terms, '$.accessibility_contact_required'), c.accessibility_contact_required) = 1 THEN 'true' ELSE 'false' END),
         'payment', json(CASE
           WHEN s.terms IS NOT NULL AND json_extract(s.terms, '$.deposit_required') = 1 AND json_extract(s.terms, '$.deposit_amount') IS NOT NULL THEN json_object(
             'basis', 'per_booking', 'unit_amount', json_extract(s.terms, '$.deposit_amount'), 'currency', json_extract(s.terms, '$.deposit_currency'),
             'tax_behavior', COALESCE(json_extract(s.terms, '$.deposit_tax_behavior'), 'unspecified'), 'min_party_size', json_extract(s.terms, '$.deposit_trigger_party_size'))
           WHEN s.terms IS NULL AND c.deposit_required = 1 AND c.deposit_amount IS NOT NULL THEN json_object(
             'basis', 'per_booking', 'unit_amount', c.deposit_amount, 'currency', c.deposit_currency,
             'tax_behavior', COALESCE(c.deposit_tax_behavior, 'unspecified'), 'min_party_size', c.deposit_trigger_party_size)
           ELSE 'null' END)),
       r.created_at, r.updated_at
  FROM reservations r
  JOIN location_reservation_configs c ON c.location_id = r.location_id AND c.organization_id = r.organization_id
  JOIN (SELECT r2.id, COALESCE(r2.policy_json,
          (SELECT json_extract(p.price_snapshot_json, '$.reservation') FROM payments p
            WHERE p.organization_id = r2.organization_id AND p.subject_type = 'reservation' AND p.subject_id = r2.id ORDER BY p.created_at LIMIT 1)) AS terms
          FROM reservations r2) s ON s.id = r.id WHERE true
ON CONFLICT (id) DO NOTHING;

-- Every booking made before terms were frozen: its offering's settings now,
-- and the price it was paid at when it was paid online (per guest, the only
-- basis there was).
UPDATE bookings SET policy_json = (
  SELECT json_object(
    'advance_notice_minutes', c.advance_notice_minutes,
    'party_size_min', c.party_size_min, 'party_size_max', c.party_size_max,
    'minimum_guest_age', c.minimum_guest_age,
    'accessibility_contact_required', json(CASE WHEN c.accessibility_contact_required = 1 THEN 'true' ELSE 'false' END),
    'payment', json(COALESCE((
      SELECT json_object('basis', 'per_guest', 'unit_amount', json_extract(p.price_snapshot_json, '$.price.unit_amount'), 'currency', p.currency,
                         'tax_behavior', COALESCE(json_extract(p.price_snapshot_json, '$.price.tax_behavior'), 'unspecified'), 'min_party_size', NULL)
        FROM payments p WHERE p.organization_id = bookings.organization_id AND p.subject_type = 'booking' AND p.subject_id = bookings.id AND p.captured_amount > 0
       ORDER BY p.created_at LIMIT 1), 'null')))
    FROM product_booking_configs c WHERE c.organization_id = bookings.organization_id AND c.product_id = bookings.product_id)
 WHERE policy_json IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Every record that named a reservation names the booking (same id).
-- ---------------------------------------------------------------------------

-- 5a. Conversation ledger, while reservations still says which threads were reservations.
UPDATE activity_entries
   SET event_name = 'booking.' || substr(event_name, length('reservation.') + 1)
 WHERE event_name LIKE 'reservation.%' AND request_id IN (SELECT request_id FROM reservations WHERE request_id IS NOT NULL);

-- Notification alerts whose event is a schedule change keep their family name in step with bookings'.
UPDATE activity_entries
   SET event_name = 'booking.' || substr(event_name, length('reservation.') + 1)
 WHERE kind = 'notification' AND event_name LIKE 'reservation.change_%';

UPDATE activity_entries
   SET dedupe_key = 'booking:' || substr(dedupe_key, length('reservation:') + 1)
 WHERE dedupe_key LIKE 'reservation:%'
   AND EXISTS (SELECT 1 FROM reservations r WHERE activity_entries.dedupe_key LIKE 'reservation:' || r.id || ':%');

UPDATE activity_entries
   SET payload_json = json_set(json_remove(payload_json, '$.operational_reservation_id'), '$.operational_booking_id', json_extract(payload_json, '$.operational_reservation_id'))
 WHERE json_type(payload_json, '$.operational_reservation_id') IS NOT NULL;

UPDATE activity_entries SET payload_json = json_set(payload_json, '$.intent', 'booking.created')
 WHERE json_extract(payload_json, '$.intent') = 'reservation.created';

-- Owner notifications: their thread is a booking now, and so is its screen.
UPDATE activity_entries
   SET payload_json = json_set(payload_json, '$.submission_type', 'booking')
 WHERE json_extract(payload_json, '$.submission_type') = 'reservation';

UPDATE activity_entries
   SET payload_json = json_set(payload_json, '$.deep_link', replace(json_extract(payload_json, '$.deep_link'), '/bookings/reservation/', '/bookings/booking/'))
 WHERE json_extract(payload_json, '$.deep_link') LIKE '%/bookings/reservation/%';

-- Change proposals on a reservation thread: the before is the booking, the
-- after the seating at the proposed instant (created in step 3).
UPDATE activity_entries
   SET payload_json = json_set(payload_json,
         '$.before.recordKind', 'booking',
         '$.before.productId', 'table-' || json_extract(payload_json, '$.before.locationId'),
         '$.before.sessionId', 'table-session-' || json_extract(payload_json, '$.before.locationId') || '-' || json_extract(payload_json, '$.before.startsAt'),
         '$.after', json_object('kind', 'booking',
           'sessionId', 'table-session-' || COALESCE(json_extract(payload_json, '$.afterLocationId'), json_extract(payload_json, '$.after.locationId')) || '-' || json_extract(payload_json, '$.afterStartsAt'),
           'partySize', json_extract(payload_json, '$.after.partySize')),
         '$.afterLocationId', COALESCE(json_extract(payload_json, '$.afterLocationId'), json_extract(payload_json, '$.after.locationId')))
 WHERE event_name IN ('booking_change.requested', 'booking_change.moved')
   AND json_extract(payload_json, '$.before.recordKind') = 'reservation'
   AND json_extract(payload_json, '$.afterStartsAt') IS NOT NULL;

-- 5b. The conversation and what names it by kind.
UPDATE requests SET kind = 'booking' WHERE kind = 'reservation';
UPDATE review_requests SET booking_type = 'booking' WHERE booking_type = 'reservation';
UPDATE reviews SET booking_type = 'booking' WHERE booking_type = 'reservation';

-- 5c. Money. subject_id was the reservation id, which is now the booking id.
UPDATE payments
   SET price_snapshot_json = json_set(json_remove(price_snapshot_json, '$.reservation'),
         '$.product_id', 'table-' || location_id,
         '$.variant_id', 'table-variant-' || location_id,
         '$.session_id', 'table-session-' || location_id || '-' || (SELECT h.starts_at FROM payment_checkout_holds h WHERE h.payment_id = payments.id),
         '$.policy', json((SELECT b.policy_json FROM bookings b WHERE b.id = payments.subject_id)))
 WHERE subject_type = 'reservation' AND EXISTS (SELECT 1 FROM payment_checkout_holds h WHERE h.payment_id = payments.id);

UPDATE payment_checkout_holds
   SET product_id = 'table-' || location_id, variant_id = 'table-variant-' || location_id, price_id = 'table-price-' || location_id,
       session_id = 'table-session-' || location_id || '-' || starts_at,
       converted_booking_id = converted_reservation_id, converted_reservation_id = NULL
 WHERE product_id IS NULL AND EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_checkout_holds.payment_id AND p.subject_type = 'reservation');

UPDATE payments SET subject_type = 'booking' WHERE subject_type = 'reservation';

UPDATE payment_authorizations SET action = 'cancel_booking' WHERE action = 'cancel_reservation';
UPDATE payment_refunds SET idempotency_key = 'cancelled:' || substr(idempotency_key, length('cancelled-reservation:') + 1) WHERE idempotency_key LIKE 'cancelled-reservation:%';
UPDATE payment_refunds SET idempotency_key = 'guest-cancelled-booking:' || substr(idempotency_key, length('guest-cancelled-reservation:') + 1) WHERE idempotency_key LIKE 'guest-cancelled-reservation:%';

-- 5d. Work, team conversations and automatic messages about the visit.
UPDATE tasks SET subject_type = 'booking' WHERE subject_type = 'reservation';
UPDATE team_threads SET subject_type = 'booking' WHERE subject_type = 'reservation';
UPDATE scheduled_guest_messages
   SET subject_type = 'booking', product_id = (SELECT b.product_id FROM bookings b WHERE b.id = scheduled_guest_messages.subject_id AND b.organization_id = scheduled_guest_messages.organization_id)
 WHERE subject_type = 'reservation';

-- An automatic message named a table reservation by its location
-- (BOOKED_RECORDS_SQL offering_id); it names the table product now.
UPDATE message_templates
   SET schedule_json = json_set(schedule_json, '$.productIds', (
         SELECT json_group_array(CASE WHEN c.location_id IS NOT NULL THEN 'table-' || c.location_id ELSE ids.value END)
           FROM json_each(message_templates.schedule_json, '$.productIds') ids
           LEFT JOIN location_reservation_configs c ON c.location_id = ids.value AND c.organization_id = message_templates.organization_id))
 WHERE schedule_json IS NOT NULL
   AND EXISTS (SELECT 1 FROM json_each(message_templates.schedule_json, '$.productIds') ids
                JOIN location_reservation_configs c ON c.location_id = ids.value AND c.organization_id = message_templates.organization_id);

-- 5e. Nothing to rewrite:
--  * google_calendar_event_links: operational_id already is the booking id;
--    booking_kind is dropped by the migration's rebuild. The new unique key
--    (organization_id, integration_revision, operational_id) cannot collide:
--    reservation and booking ids are distinct UUIDs.
--  * analytics_events: conversion rows keep event_name 'reservation_submit'
--    (the provider-side GA4/Ads name) and their entity is the request id,
--    which is unchanged.
--  * Owner alert template ids 'new_reservation' / 'reservation_cancelled' are
--    the approved WhatsApp template names and stay as recorded.

-- ---------------------------------------------------------------------------
-- 6. Verification. Each SELECT must return no rows; the migration aborts
--    (its runner checks these) if any does.
-- ---------------------------------------------------------------------------

-- A reservation that did not become a booking.
SELECT 'reservation_not_moved' AS failure, r.id FROM reservations r WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = r.id);

-- A booking without frozen terms.
SELECT 'booking_without_policy' AS failure, id FROM bookings WHERE policy_json IS NULL OR NOT json_valid(policy_json) OR json_type(policy_json) <> 'object';

-- A table nobody handles (a business with no owner member).
SELECT 'table_without_member' AS failure, product_id FROM product_booking_configs WHERE product_id LIKE 'table-%' AND assigned_member_id IS NULL;

-- A deposit the booking flow could not price: not in the business's currency, or without an amount.
SELECT 'deposit_not_priceable' AS failure, c.location_id FROM location_reservation_configs c JOIN organization o ON o.id = c.organization_id
 WHERE c.deposit_required = 1 AND (c.deposit_amount IS NULL OR c.deposit_currency IS NOT o.default_currency);

-- Anything still naming a reservation as a kind of record.
SELECT 'request_kind' AS failure, id FROM requests WHERE kind = 'reservation'
UNION ALL SELECT 'payment_subject', id FROM payments WHERE subject_type = 'reservation'
UNION ALL SELECT 'task_subject', id FROM tasks WHERE subject_type = 'reservation'
UNION ALL SELECT 'team_thread_subject', id FROM team_threads WHERE subject_type = 'reservation'
UNION ALL SELECT 'scheduled_message_subject', id FROM scheduled_guest_messages WHERE subject_type = 'reservation' OR product_id IS NULL
UNION ALL SELECT 'review_request_type', id FROM review_requests WHERE booking_type = 'reservation'
UNION ALL SELECT 'review_type', id FROM reviews WHERE booking_type = 'reservation'
UNION ALL SELECT 'authorization_action', id FROM payment_authorizations WHERE action = 'cancel_reservation'
UNION ALL SELECT 'refund_key', id FROM payment_refunds WHERE idempotency_key LIKE '%-reservation:%'
UNION ALL SELECT 'entry_event', id FROM activity_entries WHERE event_name LIKE 'reservation.%' AND request_id IN (SELECT id FROM requests WHERE kind = 'booking')
UNION ALL SELECT 'entry_payload', id FROM activity_entries WHERE json_type(payload_json, '$.operational_reservation_id') IS NOT NULL OR json_extract(payload_json, '$.submission_type') = 'reservation';

-- A checkout hold that does not satisfy the new payment_holds_subject_check.
SELECT 'hold_check' AS failure, id FROM payment_checkout_holds
 WHERE NOT ((product_id IS NOT NULL AND variant_id IS NOT NULL AND price_id IS NOT NULL AND session_id IS NOT NULL AND converted_stay_id IS NULL)
   OR (product_id IS NOT NULL AND variant_id IS NULL AND price_id IS NULL AND session_id IS NULL AND location_id IS NOT NULL AND timezone IS NOT NULL AND converted_booking_id IS NULL
       AND date(starts_at, '+0 days') IS starts_at AND date(ends_at, '+0 days') IS ends_at AND ends_at > starts_at))
   OR converted_reservation_id IS NOT NULL;

-- A hold or booking pointing at a session that does not exist.
SELECT 'missing_session' AS failure, h.id FROM payment_checkout_holds h WHERE h.session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_sessions s WHERE s.id = h.session_id)
UNION ALL SELECT 'missing_session', b.id FROM bookings b WHERE NOT EXISTS (SELECT 1 FROM product_sessions s WHERE s.id = b.product_session_id AND s.product_id = b.product_id);

-- A change proposal still in the reservation shape: one recorded before
-- proposals carried afterStartsAt names its new time only as a local date and
-- time, which SQL cannot place in its zone. Each must be rewritten by hand
-- (its session id from afterLabel and the location's zone) before the
-- migration may proceed.
SELECT 'proposal_not_moved' AS failure, id FROM activity_entries
 WHERE event_name IN ('booking_change.requested', 'booking_change.moved')
   AND (json_extract(payload_json, '$.before.recordKind') = 'reservation' OR json_extract(payload_json, '$.after.kind') = 'reservation');

-- stage: open-time
-- Open time: a table is seated through its location's hours (branch claude/consolidation-open-time).
--
-- Runs inside the combined migration, after data-move-reservations.sql and
-- before the generated statements that drop product_availability_rules.end_time
-- and .interval_minutes. product_booking_configs.seating_interval_minutes is
-- added (nullable) by the generated schema statements first.
--
-- data-move-reservations.sql step 2 ("Weekly rules mirroring each location's
-- opening hours") is replaced by this file: a table has no weekly rules, its
-- seatings are generated from business_locations.opening_hours/special_hours by
-- server/utils/availability.ts tableSeatings. Delete that step from the combined
-- migration; the statements below also remove its rows if it already ran.
--
-- The interval: the reservation system seated every 30 minutes from each
-- period's opening (shared/reservation-hours.ts generateReservationTimes, the
-- "+ 30" in step 2), so every table product carries 30. Its last start was
-- close - max(60, duration); the one rule now is that the table's duration
-- still ends by closing, so a table held under an hour gains seatings in the
-- last hour before close. Every table product today was made by the reservations
-- move (duration_minutes = COALESCE(location_reservation_configs.duration_minutes, 120)).

-- Must return 0: no non-table product uses a repeating rule, so dropping the
-- end_time/interval_minutes columns loses nothing.
SELECT COUNT(*) FROM product_availability_rules r
  JOIN products p ON p.organization_id = r.organization_id AND p.id = r.product_id
 WHERE p.kind <> 'table' AND (r.end_time IS NOT NULL OR r.interval_minutes IS NOT NULL);

-- Must return 0: every table product has a session length to seat with.
SELECT COUNT(*) FROM product_booking_configs c
  JOIN products p ON p.organization_id = c.organization_id AND p.id = c.product_id
 WHERE p.kind = 'table' AND c.duration_minutes IS NULL;

UPDATE product_booking_configs SET seating_interval_minutes = 30
 WHERE product_id IN (SELECT id FROM products WHERE kind = 'table' AND organization_id = product_booking_configs.organization_id);

-- A table's sessions keep their times and bookings; they stop naming a rule
-- (product_sessions_rule_scope_fk), and the rules go. The next
-- sessions-materialize run regenerates each table's seatings from its
-- location's hours: unbooked sessions the hours do not give are cancelled,
-- booked ones are left as they are.
UPDATE product_sessions SET availability_rule_id = NULL
 WHERE availability_rule_id IN (SELECT r.id FROM product_availability_rules r
   JOIN products p ON p.organization_id = r.organization_id AND p.id = r.product_id WHERE p.kind = 'table');
DELETE FROM product_availability_rules
 WHERE product_id IN (SELECT id FROM products WHERE kind = 'table' AND organization_id = product_availability_rules.organization_id);

-- Must return 0: every table product is seated every interval, and nothing else is.
SELECT COUNT(*) FROM product_booking_configs c
  JOIN products p ON p.organization_id = c.organization_id AND p.id = c.product_id
 WHERE (p.kind = 'table') <> (c.seating_interval_minutes IS NOT NULL);

-- Must return 0: a table has no weekly rules.
SELECT COUNT(*) FROM product_availability_rules r
  JOIN products p ON p.organization_id = r.organization_id AND p.id = r.product_id WHERE p.kind = 'table';

-- Must return 0: a table's location has opening hours to seat it through.
SELECT COUNT(*) FROM product_locations pl
  JOIN products p ON p.organization_id = pl.organization_id AND p.id = pl.product_id AND p.kind = 'table'
  JOIN business_locations l ON l.organization_id = pl.organization_id AND l.id = pl.location_id
 WHERE l.opening_hours IS NULL;

-- stage: booked-record-schema
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text,
	`request_id` text,
	`product_id` text NOT NULL,
	`product_variant_id` text NOT NULL,
	`product_session_id` text,
	`location_id` text,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`timezone` text NOT NULL,
	`party_size` integer NOT NULL,
	`adults` integer,
	`children` integer,
	`infants` integer,
	`party_size_is_minimum` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`cancelled_at` text,
	`cancellation_reason` text,
	`no_show_at` text,
	`answers` text DEFAULT '[]' NOT NULL,
	`private_notes` text,
	`policy_json` text NOT NULL,
	`total_minor` integer,
	`currency` text,
	`idempotency_key` text,
	`version` integer DEFAULT 1 NOT NULL,
	`channel` text DEFAULT 'direct' NOT NULL,
	`owner` text DEFAULT 'app' NOT NULL,
	`provider` text,
	`external_booking_id` text,
	`channel_booking_id` text,
	`revision_id` text,
	`provider_updated_at` text,
	`overbooked` integer DEFAULT 0 NOT NULL,
	`booked_product_id` text,
	`received_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`product_id`,`product_session_id`) REFERENCES `product_sessions`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`product_id`,`product_variant_id`) REFERENCES `product_variants`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`booked_product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`request_id`) REFERENCES `requests`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bookings_policy_check" CHECK(json_valid(policy_json) AND json_type(policy_json) = 'object'),
	CONSTRAINT "bookings_answers_check" CHECK(json_valid(answers) AND json_type(answers) = 'array'),
	CONSTRAINT "bookings_status_check" CHECK(status IN ('pending', 'confirmed', 'cancelled') AND (status = 'cancelled' OR cancelled_at IS NULL)),
	CONSTRAINT "bookings_instants_check" CHECK((cancelled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at, '+0 days') IS cancelled_at) AND (no_show_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', no_show_at, '+0 days') IS no_show_at) AND (received_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', received_at, '+0 days') IS received_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at),
	CONSTRAINT "bookings_window_check" CHECK((strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+0 days') IS starts_at OR (product_session_id IS NULL AND date(starts_at, '+0 days') IS starts_at))
		AND (strftime('%Y-%m-%dT%H:%M:%fZ', ends_at, '+0 days') IS ends_at OR (product_session_id IS NULL AND date(ends_at, '+0 days') IS ends_at))
		AND (length(starts_at) = 10 OR length(ends_at) = 10 OR ends_at > starts_at) AND substr(ends_at, 1, 10) >= substr(starts_at, 1, 10)
		AND timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'),
	CONSTRAINT "bookings_party_size_check" CHECK(party_size > 0 AND party_size_is_minimum IN (0, 1)
		AND ((adults IS NULL AND children IS NULL AND infants IS NULL) OR (adults >= 1 AND children >= 0 AND infants >= 0 AND adults + children = party_size))),
	CONSTRAINT "bookings_money_check" CHECK((total_minor IS NULL) = (currency IS NULL) AND (total_minor IS NULL OR (total_minor >= 0 AND length(currency) = 3 AND currency = upper(currency))) AND (product_session_id IS NOT NULL OR total_minor IS NOT NULL)),
	CONSTRAINT "bookings_channel_check" CHECK(channel IN ('airbnb', 'vrbo', 'booking_com', 'direct') AND (provider IS NULL OR provider = 'channex')),
	CONSTRAINT "bookings_owner_check" CHECK(owner IN ('app', 'channel') AND (owner = 'channel') = (provider IS NOT NULL AND external_booking_id IS NOT NULL)),
	CONSTRAINT "bookings_overbooked_check" CHECK(overbooked IN (0, 1) AND (overbooked = 0 OR owner = 'channel')),
	CONSTRAINT "bookings_booked_product_check" CHECK(booked_product_id IS NULL OR (booked_product_id <> product_id AND product_session_id IS NULL)),
	CONSTRAINT "bookings_version_check" CHECK(version >= 1)
);

CREATE UNIQUE INDEX `bookings_request_unique` ON `bookings` (`request_id`) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX `bookings_idempotency_unique` ON `bookings` (`organization_id`,`idempotency_key`) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX `bookings_provider_booking_unique` ON `bookings` (`provider`,`external_booking_id`) WHERE external_booking_id IS NOT NULL;
CREATE UNIQUE INDEX `bookings_channel_reservation_unique` ON `bookings` (`organization_id`,`channel`,`channel_booking_id`) WHERE channel_booking_id IS NOT NULL;
CREATE INDEX `bookings_session_status_idx` ON `bookings` (`product_session_id`,`status`);
CREATE INDEX `bookings_org_starts_idx` ON `bookings` (`organization_id`,`starts_at`,`status`);
CREATE INDEX `bookings_product_window_idx` ON `bookings` (`product_id`,`starts_at`,`ends_at`);
CREATE INDEX `bookings_org_created_idx` ON `bookings` (`created_at`);
CREATE INDEX `bookings_org_user_idx` ON `bookings` (`organization_id`,`user_id`);
CREATE UNIQUE INDEX `bookings_org_id_unique` ON `bookings` (`organization_id`,`id`);
CREATE UNIQUE INDEX `bookings_org_product_id_unique` ON `bookings` (`organization_id`,`product_id`,`id`);
CREATE TABLE `google_calendar_event_links` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`integration_revision` text NOT NULL,
	`account_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`event_id` text NOT NULL,
	`booking_id` text NOT NULL,
	`request_id` text,
	`booking_revision` text NOT NULL,
	`synced_revision` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "google_calendar_state_check" CHECK(state IN ('pending', 'synced', 'cleanup', 'deleted', 'error'))
);

CREATE UNIQUE INDEX `google_calendar_subject_unique` ON `google_calendar_event_links` (`organization_id`,`integration_revision`,`booking_id`) WHERE state <> 'deleted';
CREATE UNIQUE INDEX `google_calendar_provider_unique` ON `google_calendar_event_links` (`calendar_id`,`event_id`);
CREATE TABLE `offline_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`booking_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`method` text NOT NULL,
	`paid_on` text NOT NULL,
	`reference` text,
	`note` text,
	`idempotency_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "offline_payments_amount_check" CHECK(amount_minor <> 0 AND length(currency) = 3 AND currency = upper(currency)),
	CONSTRAINT "offline_payments_method_check" CHECK(method IN ('cash', 'bank_transfer', 'card_external', 'other')),
	CONSTRAINT "offline_payments_paid_on_check" CHECK(date(paid_on, '+0 days') IS paid_on),
	CONSTRAINT "offline_payments_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);

CREATE INDEX `offline_payments_booking_idx` ON `offline_payments` (`booking_id`,`paid_on`);
CREATE UNIQUE INDEX `offline_payments_idempotency_unique` ON `offline_payments` (`organization_id`,`idempotency_key`);
CREATE TABLE `payment_checkout_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text,
	`variant_id` text,
	`price_id` text,
	`session_id` text,
	`location_id` text,
	`timezone` text,
	`buyer_user_id` text,
	`request_id` text,
	`payment_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`converted_booking_id` text,
	FOREIGN KEY (`buyer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_holds_quantity_check" CHECK(quantity > 0 AND amount > 0),
	CONSTRAINT "payment_holds_subject_check" CHECK((product_id IS NOT NULL AND variant_id IS NOT NULL AND price_id IS NOT NULL AND session_id IS NOT NULL) OR (product_id IS NOT NULL AND variant_id IS NULL AND price_id IS NULL AND session_id IS NULL AND location_id IS NOT NULL AND timezone IS NOT NULL AND date(starts_at, '+0 days') IS starts_at AND date(ends_at, '+0 days') IS ends_at AND ends_at > starts_at))
);

CREATE UNIQUE INDEX `payment_checkout_holds_payment_id_unique` ON `payment_checkout_holds` (`payment_id`);
CREATE INDEX `payment_holds_capacity_idx` ON `payment_checkout_holds` (`session_id`,`status`,`expires_at`);
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`organization_id` text,
	`location_id` text,
	`user_id` text,
	`review_id` text,
	`archived_at` text,
	`archived_by_user_id` text,
	`blocked_at` text,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `business_locations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`archived_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requests_instants_check" CHECK((archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', archived_at, '+0 days') IS archived_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "requests_payload_check" CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
	CONSTRAINT "requests_guest_payload_check" CHECK((
    (json_type(payload_json, '$.participant') IS NULL AND json_type(payload_json, '$.guest.name') IS 'text'
      AND (json_type(payload_json, '$.guest.email') IS 'text' OR json_type(payload_json, '$.guest.email') IS 'null')
      AND (json_type(payload_json, '$.guest.phone') IS 'text' OR json_type(payload_json, '$.guest.phone') IS 'null')
      AND (kind = 'booking' OR json_type(payload_json, '$.guest.email') IS 'text' OR json_type(payload_json, '$.guest.phone') IS 'text'))
    OR (kind = 'booking' AND json_type(payload_json, '$.participant') IS 'object'
      AND json_extract(payload_json, '$.participant.kind') IS 'channel'
      AND json_type(payload_json, '$.participant.title') IS 'text' AND trim(json_extract(payload_json, '$.participant.title')) <> ''
      AND json_type(payload_json, '$.guest') IS 'object'
      AND (json_type(payload_json, '$.guest.name') IS 'text' OR json_type(payload_json, '$.guest.name') IS 'null')
      AND (json_type(payload_json, '$.guest.email') IS 'text' OR json_type(payload_json, '$.guest.email') IS 'null')
      AND (json_type(payload_json, '$.guest.phone') IS 'text' OR json_type(payload_json, '$.guest.phone') IS 'null'))
  )),
	CONSTRAINT "requests_message_payload_check" CHECK(kind <> 'contact' OR json_type(payload_json, '$.message') IS 'text'),
	CONSTRAINT "requests_scope_check" CHECK(organization_id IS NOT NULL)
);

CREATE UNIQUE INDEX `requests_scope_id_unique` ON `requests` (`organization_id`,`id`);
CREATE INDEX `requests_org_kind_idx` ON `requests` (`kind`,`location_id`,`updated_at`);
CREATE INDEX `requests_org_user_idx` ON `requests` (`organization_id`,`user_id`);
CREATE INDEX `requests_org_archive_activity_idx` ON `requests` (`organization_id`,`archived_at`,`updated_at`);
CREATE INDEX `requests_org_created_idx` ON `requests` (`organization_id`,`created_at`);
CREATE INDEX `requests_guest_email_idx` ON `requests` (lower(payload_json ->> '$.guest.email'));
CREATE TABLE `review_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`location_id` text,
	`booking_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token` text,
	`expires_at` text NOT NULL,
	`first_sent_at` text,
	`reminder_sent_at` text,
	`submitted_at` text,
	`clicked_at` text,
	`revoked_at` text,
	`send_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `business_locations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_requests_instants_check" CHECK((expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at) AND (first_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', first_sent_at, '+0 days') IS first_sent_at) AND (reminder_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', reminder_sent_at, '+0 days') IS reminder_sent_at) AND (submitted_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', submitted_at, '+0 days') IS submitted_at) AND (clicked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', clicked_at, '+0 days') IS clicked_at) AND (revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at, '+0 days') IS revoked_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at))
);

CREATE UNIQUE INDEX `review_requests_token_hash_unique` ON `review_requests` (`token_hash`);
CREATE UNIQUE INDEX `idx_review_requests_active_booking_unique` ON `review_requests` (`booking_id`) WHERE revoked_at IS NULL AND submitted_at IS NULL;
CREATE INDEX `idx_review_requests_send_due` ON `review_requests` (`organization_id`,`first_sent_at`,`reminder_sent_at`,`submitted_at`,`expires_at`);
CREATE INDEX `review_requests_organization_id_idx` ON `review_requests` (`organization_id`);
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`location_id` text,
	`booking_id` text,
	`review_request_id` text,
	`user_id` text,
	`product_id` text,
	`author_name` text,
	`rating` integer NOT NULL,
	`title` text,
	`content` text,
	`private_feedback` text,
	`google_review_id` text,
	`google_review_metadata` text,
	`owner_reply` text,
	`owner_reply_at` text,
	`helpful_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text DEFAULT 'direct' NOT NULL,
	`entered_by_user_id` text,
	`collection_method` text,
	`original_review_date` text,
	`original_reference` text,
	`publication_authorized` integer DEFAULT 0 NOT NULL,
	`ip_hash` text,
	`user_agent` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `business_locations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_request_id`) REFERENCES `review_requests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`entered_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reviews_instants_check" CHECK((owner_reply_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', owner_reply_at, '+0 days') IS owner_reply_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "reviews_google_review_metadata_check" CHECK(google_review_metadata IS NULL OR (json_valid(google_review_metadata) AND json_type(google_review_metadata) IS 'object')),
	CONSTRAINT "reviews_rating_check" CHECK(rating BETWEEN 1 AND 5),
	CONSTRAINT "reviews_product_scope_check" CHECK(product_id IS NULL OR organization_id IS NOT NULL),
	CONSTRAINT "reviews_owner_entered_provenance_check" CHECK(source != 'owner_entered' OR (organization_id IS NOT NULL AND location_id IS NULL AND entered_by_user_id IS NOT NULL AND collection_method IS NOT NULL AND publication_authorized = 1))
);

CREATE UNIQUE INDEX `reviews_google_review_scope_unique` ON `reviews` (`organization_id`,`location_id`,`google_review_id`);
CREATE INDEX `idx_reviews_request_id` ON `reviews` (`review_request_id`);
CREATE INDEX `reviews_booking_idx` ON `reviews` (`booking_id`);
CREATE INDEX `reviews_org_user_idx` ON `reviews` (`organization_id`,`user_id`);
CREATE INDEX `idx_reviews_location_status` ON `reviews` (`location_id`,`status`,`created_at`);
CREATE INDEX `idx_reviews_org_status` ON `reviews` (`status`,`created_at`) WHERE location_id IS NULL;
CREATE INDEX `idx_reviews_product_status_created` ON `reviews` (`product_id`,`status`,`created_at`);
CREATE INDEX `reviews_organization_id_idx` ON `reviews` (`organization_id`);
CREATE TABLE `scheduled_guest_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`booking_id` text NOT NULL,
	`request_id` text,
	`template_id` text,
	`template_title` text NOT NULL,
	`template_version` integer NOT NULL,
	`body` text NOT NULL,
	`due_at` text,
	`timezone` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`error_code` text,
	`error_field` text,
	`entry_id` text,
	`started_at` text,
	`sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `activity_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`request_id`) REFERENCES `requests`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`template_id`) REFERENCES `message_templates`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scheduled_guest_messages_status_check" CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled', 'skipped')),
	CONSTRAINT "scheduled_guest_messages_due_check" CHECK(due_at IS NOT NULL OR status IN ('failed', 'skipped')),
	CONSTRAINT "scheduled_guest_messages_error_check" CHECK(status NOT IN ('failed', 'needs_review') OR (length(trim(reason)) > 0 AND length(trim(error_code)) > 0 AND length(trim(error_field)) > 0)),
	CONSTRAINT "scheduled_guest_messages_sent_check" CHECK(status <> 'sent' OR (entry_id IS NOT NULL AND sent_at IS NOT NULL)),
	CONSTRAINT "scheduled_guest_messages_sending_check" CHECK(status <> 'sending' OR started_at IS NOT NULL),
	CONSTRAINT "scheduled_guest_messages_text_check" CHECK(length(trim(template_title)) BETWEEN 1 AND 100 AND length(trim(body)) BETWEEN 1 AND 5000 AND template_version >= 1),
	CONSTRAINT "scheduled_guest_messages_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at) AND (started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 days') IS started_at) AND (sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sent_at, '+0 days') IS sent_at))
);

CREATE UNIQUE INDEX `scheduled_guest_messages_template_booking_unique` ON `scheduled_guest_messages` (`template_id`,`booking_id`);
CREATE UNIQUE INDEX `scheduled_guest_messages_check_in_unique` ON `scheduled_guest_messages` (`booking_id`) WHERE template_id IS NULL AND template_title = 'Check-in instructions';
CREATE INDEX `scheduled_guest_messages_booking_idx` ON `scheduled_guest_messages` (`booking_id`);
CREATE INDEX `scheduled_guest_messages_due_idx` ON `scheduled_guest_messages` (`status`,`due_at`);
CREATE INDEX `scheduled_guest_messages_org_created_idx` ON `scheduled_guest_messages` (`organization_id`,`created_at`,`id`);
CREATE TABLE `stay_nights` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`date` text NOT NULL,
	`booking_id` text,
	`hold_id` text,
	`calendar_link_id` text,
	PRIMARY KEY(`product_id`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`hold_id`) REFERENCES `payment_checkout_holds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`calendar_link_id`) REFERENCES `stay_calendar_links`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stay_nights_date_check" CHECK(date(date, '+0 days') IS date),
	CONSTRAINT "stay_nights_claimant_check" CHECK((booking_id IS NOT NULL) + (hold_id IS NOT NULL) + (calendar_link_id IS NOT NULL) = 1)
);

CREATE INDEX `stay_nights_booking_idx` ON `stay_nights` (`booking_id`);
CREATE INDEX `stay_nights_hold_idx` ON `stay_nights` (`hold_id`);
CREATE INDEX `stay_nights_calendar_link_idx` ON `stay_nights` (`calendar_link_id`);
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`product_id` text,
	`location_id` text,
	`opportunity_id` text,
	`title` text,
	`notes` text,
	`assigned_member_id` text,
	`starts_at` text,
	`due_at` text,
	`timezone` text NOT NULL,
	`status` text NOT NULL,
	`outcome_note` text,
	`closed_at` text,
	`closed_by_user_id` text,
	`dedupe_key` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`closed_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`opportunity_id`) REFERENCES `opportunities`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_kind_check" CHECK(kind IN ('turnover', 'guest_reply', 'message_delivery', 'booking_review', 'booking_change', 'opportunity', 'custom', 'stay_ready', 'consultation_prep', 'consultation_follow_up')
    AND (subject_type IS NULL) = (subject_id IS NULL)
    AND (subject_type IS NULL OR subject_type IN ('request', 'scheduled_guest_message', 'booking', 'article', 'post', 'product'))
    AND (kind <> 'custom' OR subject_type IS NULL)
    AND ((kind = 'opportunity') = (opportunity_id IS NOT NULL))),
	CONSTRAINT "tasks_text_check" CHECK((title IS NULL OR length(trim(title)) BETWEEN 1 AND 200) AND (kind NOT IN ('custom', 'opportunity') OR title IS NOT NULL)
    AND (notes IS NULL OR length(trim(notes)) BETWEEN 1 AND 5000) AND (outcome_note IS NULL OR length(trim(outcome_note)) BETWEEN 1 AND 5000)
    AND length(trim(dedupe_key)) > 0 AND timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'),
	CONSTRAINT "tasks_window_check" CHECK(starts_at IS NULL OR due_at IS NULL OR starts_at <= due_at),
	CONSTRAINT "tasks_status_check" CHECK(status IN ('open', 'done', 'skipped', 'cancelled') AND (status = 'open') = (closed_at IS NULL) AND (status <> 'open' OR closed_by_user_id IS NULL) AND version >= 1),
	CONSTRAINT "tasks_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (starts_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+0 days') IS starts_at) AND (due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at) AND (closed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', closed_at, '+0 days') IS closed_at))
);

CREATE UNIQUE INDEX `tasks_dedupe_key_unique` ON `tasks` (`dedupe_key`);
CREATE UNIQUE INDEX `tasks_opportunity_unique` ON `tasks` (`opportunity_id`) WHERE opportunity_id IS NOT NULL;
CREATE INDEX `tasks_status_due_idx` ON `tasks` (`organization_id`,`status`,`due_at`);
CREATE INDEX `tasks_member_status_due_idx` ON `tasks` (`organization_id`,`assigned_member_id`,`status`,`due_at`);
CREATE INDEX `tasks_subject_idx` ON `tasks` (`subject_type`,`subject_id`);
CREATE TABLE `team_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`booking_id` text,
	`location_id` text,
	`created_by_user_id` text,
	`name` text,
	`is_group` integer DEFAULT 0 NOT NULL,
	`participants_key` text NOT NULL,
	`last_message_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "team_threads_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', last_message_at, '+0 days') IS last_message_at AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);

CREATE UNIQUE INDEX `team_threads_participants_unique` ON `team_threads` (`organization_id`,`participants_key`);
CREATE INDEX `team_threads_org_activity_idx` ON `team_threads` (`organization_id`,`last_message_at`);
CREATE INDEX `team_threads_org_booking_idx` ON `team_threads` (`organization_id`,`booking_id`);
CREATE INDEX `team_threads_org_location_idx` ON `team_threads` (`organization_id`,`location_id`);
CREATE UNIQUE INDEX `team_threads_org_id_unique` ON `team_threads` (`organization_id`,`id`);

-- stage: stays
-- Stays → bookings: the data move for the combined migration.
--
-- Production at the time of writing (krabiclaw-production-v26, read 2026-11-10):
-- 32 stays (31 without a user, 12 without a conversation, 4 with notes, 1 with
-- a frozen cancellation policy), 1340 stay_nights, 1 stay_payment, 4 payments
-- with subject_type 'stay', 25 tasks with subject_type 'stay'.
--
-- Preconditions, which the combined migration provides:
--   * PRAGMA foreign_keys = OFF and PRAGMA legacy_alter_table = ON.
--   * These tables are renamed with an `old_` prefix and recreated under their
--     names from server/db/schema.ts: bookings, stays (dropped, kept only as
--     old_stays), stay_nights, stay_payments (dropped, kept only as
--     old_stay_payments; offline_payments is new), requests, tasks,
--     scheduled_guest_messages, team_threads, review_requests, reviews,
--     google_calendar_event_links, payment_checkout_holds.
--   * stay_windows(stay_id, starts_at, ends_at) is filled by
--     data-move-stays-windows.mjs (beside this file): each stay's check-in and
--     checkout day at its home's check-in/checkout time in the home's timezone,
--     as a UTC instant, or the day alone where the home has no time. SQLite has
--     no timezone database, so the instants are computed there, not here.
-- Every id is preserved. Each "must return 0" query is checked before the
-- old tables are dropped; a non-zero answer stops the move.

-- 1. Who each stay's guest and conversation are. A stay without a user gets an
--    anonymous Better Auth user carrying the guest's name (Better Auth's own
--    anonymous shape: isAnonymous, an anon-…@customers.krabiclaw.local email);
--    a stay without a conversation gets one.
CREATE TEMP TABLE stay_moves AS
  SELECT s.id AS stay_id,
         COALESCE(s.user_id, 'v27-stay-user:' || s.id) AS user_id, s.user_id IS NULL AS new_user,
         COALESCE(s.request_id, 'v27-stay-conversation:' || s.id) AS request_id, s.request_id IS NULL AS new_request,
         nullif(trim(coalesce(s.guest_name, '') || ' ' || coalesce(s.guest_surname, '')), '') AS guest_name,
         CASE WHEN s.owner = 'channel' THEN channels.title || ' reservation ' || COALESCE(s.channel_booking_id, s.external_booking_id) END AS participant_title,
         c.location_id, l.timezone,
         (SELECT v.id FROM product_variants v WHERE v.organization_id = s.organization_id AND v.product_id = s.product_id) AS variant_id
    FROM old_stays s
    JOIN product_stay_configs c ON c.organization_id = s.organization_id AND c.product_id = s.product_id
    JOIN business_locations l ON l.organization_id = c.organization_id AND l.id = c.location_id
    LEFT JOIN stay_channels channels ON channels.channel = s.channel;

-- must return 0: every stay has its home, one variant, a guest or channel reservation, and its window.
SELECT (SELECT COUNT(*) FROM old_stays) - (SELECT COUNT(*) FROM stay_moves)
     + (SELECT COUNT(*) FROM stay_moves WHERE variant_id IS NULL OR (guest_name IS NULL AND participant_title IS NULL))
     + (SELECT COUNT(*) FROM old_stays s WHERE (SELECT COUNT(*) FROM product_variants v WHERE v.organization_id = s.organization_id AND v.product_id = s.product_id) <> 1)
     + (SELECT COUNT(*) FROM stay_moves m WHERE NOT EXISTS (SELECT 1 FROM stay_windows w WHERE w.stay_id = m.stay_id));

INSERT INTO user (id, name, email, emailVerified, isAnonymous, createdAt, updatedAt)
  SELECT m.user_id, coalesce(m.guest_name, m.participant_title), 'anon-' || lower(hex(CAST(s.id AS BLOB))) || '@customers.krabiclaw.local', 0, 1,
         CAST(strftime('%s', s.created_at) AS INTEGER), CAST(strftime('%s', s.created_at) AS INTEGER)
    FROM stay_moves m JOIN old_stays s ON s.id = m.stay_id WHERE m.new_user;

-- 2. Conversations. 'stay' threads become 'booking' threads with the booking
--    thread's fields; a booking thread's answers and "or more" move to the
--    booking (step 3) and leave the thread. A stay's thread belongs to the
--    stay's guest account.
INSERT INTO requests (id, kind, organization_id, location_id, user_id, review_id, archived_at, archived_by_user_id, blocked_at, payload_json, created_at, updated_at)
  SELECT r.id, CASE r.kind WHEN 'stay' THEN 'booking' ELSE r.kind END, r.organization_id, r.location_id,
         COALESCE(r.user_id, (SELECT m.user_id FROM old_stays s JOIN stay_moves m ON m.stay_id = s.id WHERE s.request_id = r.id)),
         r.review_id, r.archived_at, r.archived_by_user_id, r.blocked_at,
         CASE r.kind
           WHEN 'stay' THEN json_set(r.payload_json, '$.notes', json('null'), '$.ip_hash', json('null'),
             '$.cancellation', json_object('token_hash', json('null'), 'expires_at', json('null'), 'used_at', json('null')))
           WHEN 'booking' THEN json_remove(r.payload_json, '$.answers', '$.party_size_is_minimum')
           ELSE r.payload_json END,
         r.created_at, r.updated_at
    FROM old_requests r;

INSERT INTO requests (id, kind, organization_id, location_id, user_id, review_id, payload_json, created_at, updated_at)
  SELECT m.request_id, 'booking', s.organization_id, m.location_id, m.user_id, NULL,
         CASE WHEN m.guest_name IS NULL THEN json_set(p.payload_json, '$.participant', json_object('kind', 'channel', 'title', m.participant_title))
              ELSE p.payload_json END,
         s.created_at, s.created_at
    FROM stay_moves m JOIN old_stays s ON s.id = m.stay_id
    JOIN (
      SELECT m.stay_id, json_object('guest', json_object('name', m.guest_name, 'email', nullif(trim(s.guest_email), ''), 'phone', nullif(trim(s.guest_phone), '')),
        'notes', json('null'), 'ip_hash', json('null'), 'cancellation', json_object('token_hash', json('null'), 'expires_at', json('null'), 'used_at', json('null'))) AS payload_json
        FROM stay_moves m JOIN old_stays s ON s.id = m.stay_id WHERE m.new_request
    ) p ON p.stay_id = m.stay_id;

-- The conversation's first entry, as bookingConversationQueries writes it.
INSERT INTO activity_entries (id, request_id, kind, scope_kind, actor_kind, actor_user_id, channel, payload_json, dedupe_key, sequence, occurred_at, created_at)
  SELECT 'v27-stay-opening:' || s.id, m.request_id, 'submission', 'request', 'system', NULL, 'system',
         json_object('kind', 'booking', 'booking_id', m.stay_id), 'request:' || m.request_id || ':submission', 1, s.created_at, s.created_at
    FROM stay_moves m JOIN old_stays s ON s.id = m.stay_id WHERE m.new_request;

-- 3. Bookings: the slot bookings with their session's window, then the stays.
INSERT INTO bookings (id, organization_id, user_id, request_id, product_id, product_variant_id, product_session_id, location_id, starts_at, ends_at, timezone,
    party_size, party_size_is_minimum, status, cancelled_at, cancellation_reason, no_show_at, answers, policy_json, version, channel, owner, overbooked, received_at, created_at, updated_at)
  SELECT b.id, b.organization_id, b.user_id, b.request_id, b.product_id, b.product_variant_id, b.product_session_id, ps.location_id, ps.starts_at, ps.ends_at, ps.timezone,
         b.party_size, COALESCE(json_extract(r.payload_json, '$.party_size_is_minimum'), 0), b.status, b.cancelled_at, b.cancellation_reason, b.no_show_at,
         COALESCE(json_extract(r.payload_json, '$.answers'), '[]'), json_set(b.policy_json, '$.cancellation', json('null')), 1, 'direct', 'app', 0, b.created_at, b.created_at, b.updated_at
    FROM old_bookings b
    JOIN product_sessions ps ON ps.organization_id = b.organization_id AND ps.id = b.product_session_id
    LEFT JOIN old_requests r ON r.id = b.request_id;

-- A stay's frozen terms are the cancellation policy it was booked under; it
-- froze no guest terms or payment terms (the payments row is its payment).
-- Its host note is private_notes; a site checkout's note was the guest's, and
-- the guest's note is their message in the conversation.
INSERT INTO bookings (id, organization_id, user_id, request_id, product_id, product_variant_id, product_session_id, location_id, starts_at, ends_at, timezone,
    party_size, adults, children, infants, party_size_is_minimum, status, cancelled_at, cancellation_reason, no_show_at, answers, private_notes, policy_json,
    total_minor, currency, idempotency_key, version, channel, owner, provider, external_booking_id, channel_booking_id, revision_id, provider_updated_at,
    overbooked, booked_product_id, received_at, created_at, updated_at)
  SELECT s.id, s.organization_id, m.user_id, m.request_id, s.product_id, m.variant_id, NULL, m.location_id, w.starts_at, w.ends_at, m.timezone,
         s.adults + s.children, s.adults, s.children, s.infants, 0, s.status, s.cancelled_at, s.cancellation_reason, s.no_show_at, s.answers,
         CASE WHEN s.idempotency_key LIKE 'checkout:%' THEN NULL ELSE nullif(trim(s.notes), '') END,
         json_object('advance_notice_minutes', json('null'), 'party_size_min', json('null'), 'party_size_max', json('null'), 'minimum_guest_age', json('null'),
           'accessibility_contact_required', json('false'), 'payment', json('null'), 'cancellation', s.cancellation_policy),
         s.total_minor, s.currency, s.idempotency_key, s.version, s.channel, s.owner, s.provider, s.external_booking_id, s.channel_booking_id, s.revision_id, s.provider_updated_at,
         s.overbooked, s.booked_product_id, s.booking_received_at, s.created_at, s.updated_at
    FROM old_stays s JOIN stay_moves m ON m.stay_id = s.id JOIN stay_windows w ON w.stay_id = s.id;

-- must return 0: no stay id collides with a slot booking id.
SELECT COUNT(*) FROM old_stays s JOIN old_bookings b ON b.id = s.id;

-- 4. The night claims name the booking; offline payments name it.
INSERT INTO stay_nights (organization_id, product_id, date, booking_id, hold_id, calendar_link_id)
  SELECT organization_id, product_id, date, stay_id, hold_id, calendar_link_id FROM old_stay_nights;

INSERT INTO offline_payments (id, organization_id, booking_id, amount_minor, currency, method, paid_on, reference, note, idempotency_key, created_at, created_by)
  SELECT id, organization_id, stay_id, amount_minor, currency, method, paid_on, reference, note, idempotency_key, created_at, created_by FROM old_stay_payments;

-- 5. Every reference is the booking's id.
UPDATE payments SET subject_type = 'booking' WHERE subject_type = 'stay';

-- A session checkout freezes the guest's answers with its purchase now; one
-- started before took them from its conversation.
UPDATE payments SET price_snapshot_json = json_set(price_snapshot_json, '$.answers',
    json(COALESCE((SELECT json_extract(r.payload_json, '$.answers') FROM old_payment_checkout_holds h JOIN old_requests r ON r.id = h.request_id WHERE h.payment_id = payments.id), '[]')))
  WHERE json_type(price_snapshot_json, '$.session_id') = 'text' AND json_type(price_snapshot_json, '$.answers') IS NULL;

INSERT INTO payment_checkout_holds (id, organization_id, product_id, variant_id, price_id, session_id, location_id, timezone, buyer_user_id, request_id, payment_id,
    quantity, amount, currency, starts_at, ends_at, status, expires_at, created_at, converted_booking_id)
  SELECT id, organization_id, product_id, variant_id, price_id, session_id, location_id, timezone, buyer_user_id, request_id, payment_id,
         quantity, amount, currency, starts_at, ends_at, status, expires_at, created_at, COALESCE(converted_booking_id, converted_stay_id)
    FROM old_payment_checkout_holds;

INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, opportunity_id, title, notes, assigned_member_id, starts_at, due_at,
    timezone, status, outcome_note, closed_at, closed_by_user_id, dedupe_key, version, created_by_user_id, created_at, updated_at)
  SELECT id, organization_id, kind, CASE subject_type WHEN 'stay' THEN 'booking' ELSE subject_type END, subject_id, product_id, location_id, opportunity_id, title, notes,
         assigned_member_id, starts_at, due_at, timezone, status, outcome_note, closed_at, closed_by_user_id, dedupe_key, version, created_by_user_id, created_at, updated_at
    FROM old_tasks;

-- must return 0: every message names a booking and its product.
SELECT COUNT(*) FROM old_scheduled_guest_messages m WHERE m.product_id IS NULL OR NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = m.subject_id AND b.organization_id = m.organization_id);

INSERT INTO scheduled_guest_messages (id, organization_id, product_id, booking_id, request_id, template_id, template_title, template_version, body, due_at, timezone,
    status, reason, error_code, error_field, entry_id, started_at, sent_at, created_at, updated_at)
  SELECT id, organization_id, product_id, subject_id, request_id, template_id, template_title, template_version, body, due_at, timezone,
         status, reason, error_code, error_field, entry_id, started_at, sent_at, created_at, updated_at
    FROM old_scheduled_guest_messages;

INSERT INTO team_threads (id, organization_id, booking_id, location_id, created_by_user_id, name, is_group, participants_key, last_message_at, created_at)
  SELECT id, organization_id, subject_id, location_id, created_by_user_id, name, is_group, participants_key, last_message_at, created_at FROM old_team_threads;

-- Reviews named the conversation (booking_id held the request id, booking_type its kind); they name the booking now.
-- must return 0: every review request's conversation has its booking.
SELECT COUNT(*) FROM old_review_requests rr WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.request_id = rr.booking_id AND b.organization_id = rr.organization_id);

INSERT INTO review_requests (id, organization_id, location_id, booking_id, token_hash, token, expires_at, first_sent_at, reminder_sent_at, submitted_at, clicked_at,
    revoked_at, send_count, last_error, user_id, created_at, updated_at)
  SELECT rr.id, rr.organization_id, rr.location_id, b.id, rr.token_hash, rr.token, rr.expires_at, rr.first_sent_at, rr.reminder_sent_at, rr.submitted_at, rr.clicked_at,
         rr.revoked_at, rr.send_count, rr.last_error, rr.user_id, rr.created_at, rr.updated_at
    FROM old_review_requests rr JOIN bookings b ON b.request_id = rr.booking_id AND b.organization_id = rr.organization_id;

-- must return 0: every review that named a conversation finds its booking.
SELECT COUNT(*) FROM old_reviews v WHERE v.booking_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.request_id = v.booking_id AND b.organization_id = v.organization_id);

INSERT INTO reviews (id, organization_id, location_id, booking_id, review_request_id, user_id, product_id, author_name, rating, title, content, private_feedback,
    google_review_id, google_review_metadata, owner_reply, owner_reply_at, helpful_count, status, source, entered_by_user_id, collection_method,
    original_review_date, original_reference, publication_authorized, ip_hash, user_agent, created_at, updated_at)
  SELECT v.id, v.organization_id, v.location_id, (SELECT b.id FROM bookings b WHERE b.request_id = v.booking_id AND b.organization_id = v.organization_id),
         v.review_request_id, v.user_id, v.product_id, v.author_name, v.rating, v.title, v.content, v.private_feedback,
         v.google_review_id, v.google_review_metadata, v.owner_reply, v.owner_reply_at, v.helpful_count, v.status, v.source, v.entered_by_user_id, v.collection_method,
         v.original_review_date, v.original_reference, v.publication_authorized, v.ip_hash, v.user_agent, v.created_at, v.updated_at
    FROM old_reviews v;

INSERT INTO google_calendar_event_links (id, organization_id, integration_revision, account_id, calendar_id, event_id, booking_id, request_id, booking_revision,
    synced_revision, state, last_error, last_synced_at, created_at, updated_at)
  SELECT id, organization_id, integration_revision, account_id, calendar_id, event_id, operational_id, request_id, booking_revision,
         synced_revision, state, last_error, last_synced_at, created_at, updated_at
    FROM old_google_calendar_event_links;

-- D3: the team's notes were ledger entries on the conversation (each note's
-- latest revision); they become the booking's one private note, in the order
-- they were written, and leave the ledger.
UPDATE bookings SET private_notes = (
    SELECT group_concat(body, char(10) || char(10)) FROM (
      SELECT latest.body FROM (
        SELECT body, COALESCE(json_extract(payload_json, '$.noteId'), id) AS note_id,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(json_extract(payload_json, '$.noteId'), id) ORDER BY sequence DESC) AS revision,
          MIN(sequence) OVER (PARTITION BY COALESCE(json_extract(payload_json, '$.noteId'), id)) AS first_sequence
        FROM activity_entries WHERE request_id = bookings.request_id AND event_name IN ('internal_note.added', 'internal_note.updated') AND body IS NOT NULL
      ) latest WHERE latest.revision = 1 ORDER BY latest.first_sequence))
  WHERE private_notes IS NULL AND EXISTS (SELECT 1 FROM activity_entries WHERE request_id = bookings.request_id AND event_name = 'internal_note.added');
-- must return 0: no stay already carried a host note and ledger notes both.
SELECT COUNT(*) FROM bookings b WHERE b.private_notes IS NOT NULL AND b.product_session_id IS NULL AND EXISTS (SELECT 1 FROM activity_entries WHERE request_id = b.request_id AND event_name = 'internal_note.added');
DELETE FROM activity_entries WHERE event_name IN ('internal_note.added', 'internal_note.updated');

-- must return no rows: the moved rows hold together.

DROP TABLE old_bookings;
DROP TABLE old_stays;
DROP TABLE old_stay_nights;
DROP TABLE old_stay_payments;
DROP TABLE old_requests;
DROP TABLE old_tasks;
DROP TABLE old_scheduled_guest_messages;
DROP TABLE old_team_threads;
DROP TABLE old_review_requests;
DROP TABLE old_reviews;
DROP TABLE old_google_calendar_event_links;
DROP TABLE old_payment_checkout_holds;
DROP TABLE stay_moves;

-- stage: conversations
-- Conversations: the data move for the combined migration.
--
-- requests, the conversation entries of activity_entries, team_threads,
-- team_messages and team_thread_members become conversations,
-- conversation_participants and messages (server/db/schema.ts). Ids are kept:
-- a conversation keeps its request's or team thread's id, a message keeps its
-- entry's or team message's id, so reply-to addresses already mailed still
-- name their message. activity_entries keeps only the audit log.
--
-- Preconditions, which the combined migration provides (after the stays move):
--   * PRAGMA foreign_keys = OFF and PRAGMA legacy_alter_table = ON.
--   * These tables are renamed with an `old_` prefix and recreated under their
--     names from server/db/schema.ts: activity_entries, bookings,
--     channel_threads, content_reports, guest_thread_deliveries,
--     media_placements, payment_checkout_holds, scheduled_guest_messages,
--     send_later_messages, tasks. requests, team_threads, team_messages and
--     team_thread_members are renamed to old_* and not recreated;
--     conversations, conversation_participants and messages are new.
--   * Every booking conversation already carries its opening message
--     (scripts/backfill-opening-messages.ts ran in production before this epoch).
-- Each "must return 0" query is checked before the old tables are dropped; a
-- non-zero answer stops the move. "report:" queries are read and recorded.

-- 1. Which conversation entries become messages, and as whom.
--    Kept: a guest's, a member's and KrabiClaw's words (kind message), the
--    first message (submission: a contact's words, or a booking's when it has
--    any) and KrabiClaw's events about the booking (kind operation).
--    Not messages: calendar sync notes, the booking/reservation/inquiry
--    "created" records, archive and unarchive (participant state, step 4),
--    internal notes (already bookings.private_notes), an empty booking
--    submission, and Airbnb's echo of a reply we sent (the reply is the message).
CREATE TEMP TABLE entry_moves AS
  SELECT e.id, e.request_id AS conversation_id, r.organization_id,
         ROW_NUMBER() OVER (PARTITION BY e.request_id ORDER BY e.sequence, e.occurred_at, e.id) AS sequence,
         CASE
           WHEN e.kind = 'submission' AND r.kind = 'contact' THEN 'guest'
           WHEN e.kind = 'submission' THEN CASE e.actor_kind WHEN 'guest' THEN 'guest' ELSE 'krabiclaw' END
           WHEN e.kind = 'operation' THEN 'krabiclaw'
           WHEN e.actor_kind = 'guest' THEN 'guest'
           WHEN e.actor_kind = 'member' THEN 'member'
           ELSE 'krabiclaw'
         END AS author_kind,
         -- A guest's own words are their account's (every guest has one), so they are never unread to them.
         CASE WHEN e.actor_kind = 'guest' OR (e.kind = 'submission' AND r.kind = 'contact') THEN COALESCE(e.actor_user_id, r.user_id) ELSE e.actor_user_id END AS author_user_id,
         CASE WHEN e.channel = 'system' THEN NULL ELSE e.channel END AS channel,
         CASE WHEN e.kind = 'submission' AND r.kind = 'contact' THEN COALESCE(NULLIF(trim(e.body), ''), json_extract(r.payload_json, '$.message')) ELSE e.body END AS body,
         CASE WHEN e.kind = 'submission' THEN 'thread.submission' ELSE e.event_name END AS event_name,
         e.payload_json, e.dedupe_key, e.occurred_at, e.created_at
    FROM old_activity_entries e JOIN old_requests r ON r.id = e.request_id
   WHERE e.kind IN ('submission', 'message', 'operation')
     AND (e.event_name IS NULL OR (e.event_name NOT GLOB 'calendar_sync.*' AND e.event_name NOT GLOB 'internal_note.*'
       AND e.event_name NOT IN ('booking.created', 'reservation.created', 'channel.inquiry_received', 'thread.archived', 'thread.unarchived')))
     AND NOT (e.kind = 'submission' AND r.kind = 'booking' AND trim(COALESCE(e.body, '')) = ''
       AND NOT EXISTS (SELECT 1 FROM old_media_placements mp WHERE mp.owner_type = 'activity_entry' AND mp.owner_id = e.id AND mp.status = 'active'))
     AND NOT (e.kind = 'message' AND e.event_name = 'channel.message_mirrored' AND e.actor_kind = 'member'
       AND EXISTS (SELECT 1 FROM old_guest_thread_deliveries d JOIN old_activity_entries reply ON reply.id = d.entry_id
         WHERE d.provider = 'channex' AND d.provider_message_id = json_extract(e.payload_json, '$.provider_message_id') AND reply.request_id = e.request_id));

-- must return 0: every conversation entry has its conversation, and none is
-- both kept and an internal note (those moved to bookings.private_notes).
SELECT (SELECT COUNT(*) FROM old_activity_entries e WHERE e.request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM old_requests r WHERE r.id = e.request_id))
     + (SELECT COUNT(*) FROM entry_moves WHERE event_name GLOB 'internal_note.*');

-- 2. Conversations. A guest's keeps its request's id, contact, provenance and
--    cancellation token; its booking is the booking that named it. A contact's
--    words leave the payload: they are its first message. A team thread keeps
--    its id, name, group flag and roster key.
-- must return 0: a request names at most one booking, and a booking one request.
SELECT (SELECT COUNT(*) FROM (SELECT request_id FROM old_bookings WHERE request_id IS NOT NULL GROUP BY request_id HAVING COUNT(*) > 1));

INSERT INTO conversations (id, organization_id, kind, location_id, booking_id, user_id, name, is_group, participants_key, created_by_user_id, blocked_at, payload_json, last_message_at, created_at)
  SELECT r.id, r.organization_id, r.kind, r.location_id,
         (SELECT b.id FROM old_bookings b WHERE b.request_id = r.id AND b.organization_id = r.organization_id),
         r.user_id, NULL, 0, NULL, NULL, r.blocked_at,
         CASE r.kind WHEN 'contact' THEN json_remove(r.payload_json, '$.message', '$.notes') ELSE json_remove(r.payload_json, '$.notes') END,
         max(r.updated_at, COALESCE((SELECT MAX(m.occurred_at) FROM entry_moves m WHERE m.conversation_id = r.id), r.updated_at)),
         r.created_at
    FROM old_requests r;

INSERT INTO conversations (id, organization_id, kind, location_id, booking_id, user_id, name, is_group, participants_key, created_by_user_id, blocked_at, payload_json, last_message_at, created_at)
  SELECT t.id, t.organization_id, 'team', t.location_id, t.booking_id, NULL, t.name, t.is_group, t.participants_key, t.created_by_user_id, NULL, '{}', t.last_message_at, t.created_at
    FROM old_team_threads t;

-- 3. Messages: the kept entries, then each team message as its sender's, or
--    KrabiClaw's when it was automatic, keyed as the team writer keys them.
INSERT INTO messages (id, organization_id, conversation_id, sequence, author_kind, author_user_id, channel, body, event_name, payload_json, dedupe_key, occurred_at, created_at)
  SELECT id, organization_id, conversation_id, sequence, author_kind, author_user_id, channel, body, event_name, payload_json, dedupe_key, occurred_at, created_at
    FROM entry_moves;

-- A booking guest's note lived on the conversation when no guest_note message
-- was written for it: it becomes their message, after the conversation's others.
INSERT INTO messages (id, organization_id, conversation_id, sequence, author_kind, author_user_id, channel, body, event_name, payload_json, dedupe_key, occurred_at, created_at)
  SELECT lower(hex(randomblob(16))), r.organization_id, r.id,
         COALESCE((SELECT MAX(m.sequence) FROM messages m WHERE m.conversation_id = r.id), 0) + 1,
         'guest', r.user_id, 'web', trim(json_extract(r.payload_json, '$.notes')), 'thread.guest_note', '{}',
         'conversation:' || r.id || ':guest-note', r.created_at, r.created_at
    FROM old_requests r
   WHERE r.kind = 'booking' AND trim(COALESCE(json_extract(r.payload_json, '$.notes'), '')) <> ''
     AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = r.id AND m.event_name = 'thread.guest_note');

INSERT INTO messages (id, organization_id, conversation_id, sequence, author_kind, author_user_id, channel, body, event_name, payload_json, dedupe_key, occurred_at, created_at)
  SELECT m.id, m.organization_id, m.thread_id,
         ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.created_at, m.id),
         CASE WHEN m.automatic THEN 'krabiclaw' ELSE 'member' END, m.sender_user_id, NULL, m.body, NULL,
         CASE WHEN m.automatic THEN json_object('key', m.idempotency_key) ELSE json_object('request_hash', m.request_hash) END,
         'team:' || m.thread_id || ':' || m.idempotency_key, m.created_at, m.created_at
    FROM old_team_messages m;

-- 4. Read positions and archives, so nothing becomes newly unread. A message
--    from someone else after a person's position is unread (conversations.ts
--    unreadSql); before this move unread was an unacknowledged alert.
--    Team: a seat read through its last_read_at; a non-automatic message from
--    someone else after it (the old unread) stays unread, KrabiClaw's
--    automatic ones (which never counted) are read.
CREATE TEMP TABLE team_reads AS
  SELECT s.thread_id, s.organization_id, mb.userId AS user_id, s.created_at,
         (SELECT MIN(t.created_at) FROM old_team_messages t WHERE t.thread_id = s.thread_id AND t.automatic = 0
            AND t.sender_user_id IS NOT mb.userId AND (s.last_read_at IS NULL OR t.created_at > s.last_read_at)) AS first_unread_at
    FROM old_team_thread_members s JOIN member mb ON mb.id = s.member_id AND mb.organizationId = s.organization_id;

INSERT INTO conversation_participants (conversation_id, organization_id, user_id, last_read_message_id, archived_at, created_at)
  SELECT tr.thread_id, tr.organization_id, tr.user_id,
         (SELECT m.id FROM messages m WHERE m.conversation_id = tr.thread_id
            AND (tr.first_unread_at IS NULL OR m.occurred_at < tr.first_unread_at) ORDER BY m.sequence DESC LIMIT 1),
         NULL, tr.created_at
    FROM team_reads tr;

--    A guest conversation, for every member of its organization: read through
--    its newest message, unless an alert about one of its messages was
--    unacknowledged by them, when it is read up to the first such message.
--    The archive was everyone's, and stays so for each of them (D2 makes the
--    next archive per person).
CREATE TEMP TABLE member_reads AS
  SELECT c.id AS conversation_id, c.organization_id, mb.userId AS user_id,
         (SELECT MIN(em.sequence) FROM old_activity_entries n
            JOIN entry_moves em ON em.id = n.parent_id
           WHERE n.kind = 'notification' AND em.conversation_id = c.id
             AND (n.target_user_id IS NULL OR n.target_user_id = mb.userId)
             AND (n.event_name IN ('new_contact_msg', 'channel_inquiry') OR n.event_name GLOB 'submission_reply_*')
             AND NOT EXISTS (SELECT 1 FROM old_activity_entries a WHERE a.kind = 'acknowledgement' AND a.parent_id = n.id AND a.actor_user_id = mb.userId)) AS first_unread,
         r.archived_at
    FROM conversations c JOIN old_requests r ON r.id = c.id
    JOIN member mb ON mb.organizationId = c.organization_id
   WHERE c.kind IN ('contact', 'booking') AND c.user_id IS NOT mb.userId;

INSERT INTO conversation_participants (conversation_id, organization_id, user_id, last_read_message_id, archived_at, created_at)
  SELECT mr.conversation_id, mr.organization_id, mr.user_id,
         (SELECT m.id FROM messages m WHERE m.conversation_id = mr.conversation_id
            AND (mr.first_unread IS NULL OR m.sequence < mr.first_unread) ORDER BY m.sequence DESC LIMIT 1),
         mr.archived_at, max(c.created_at, COALESCE(mr.archived_at, c.created_at))
    FROM member_reads mr JOIN conversations c ON c.id = mr.conversation_id;

--    The guest: read through their conversation, unless a member's reply, a
--    scheduled message or a change request they had not acknowledged is waiting
--    (the old buyer unread), when it is read up to the first of those.
CREATE TEMP TABLE guest_reads AS
  SELECT c.id AS conversation_id, c.organization_id, c.user_id,
         (SELECT MIN(em.sequence) FROM entry_moves em JOIN old_activity_entries e ON e.id = em.id
           WHERE em.conversation_id = c.id AND (e.actor_user_id IS NULL OR e.actor_user_id <> c.user_id)
             AND ((e.kind = 'message' AND ((e.actor_kind = 'member' AND e.event_name = 'thread.member_reply') OR (e.actor_kind = 'system' AND e.event_name = 'thread.scheduled_message')))
               OR (e.kind = 'operation' AND e.event_name = 'booking_change.requested'))
             AND NOT EXISTS (SELECT 1 FROM old_activity_entries a WHERE a.kind = 'acknowledgement' AND a.parent_id = e.id AND a.actor_user_id = c.user_id)) AS first_unread
    FROM conversations c WHERE c.kind IN ('contact', 'booking') AND c.user_id IS NOT NULL;

INSERT INTO conversation_participants (conversation_id, organization_id, user_id, last_read_message_id, archived_at, created_at)
  SELECT gr.conversation_id, gr.organization_id, gr.user_id,
         (SELECT m.id FROM messages m WHERE m.conversation_id = gr.conversation_id
            AND (gr.first_unread IS NULL OR m.sequence < gr.first_unread) ORDER BY m.sequence DESC LIMIT 1),
         NULL, c.created_at
    FROM guest_reads gr JOIN conversations c ON c.id = gr.conversation_id;

-- 5. The audit log keeps its audit rows. An alert about no conversation
--    message and no task (a payout, a domain, a subscription) becomes the audit
--    row its sends are recorded on, under the alert's id.
INSERT INTO activity_entries (id, organization_id, location_id, actor_kind, actor_user_id, body, event_name, payload_json, dedupe_key, occurred_at, created_at)
  SELECT e.id, e.organization_id, e.location_id, CASE e.actor_kind WHEN 'member' THEN 'member' WHEN 'cloudflare' THEN 'cloudflare' ELSE 'system' END,
         e.actor_user_id, e.body, COALESCE(e.event_name, 'organization.changed'), e.payload_json, e.dedupe_key, e.occurred_at, e.created_at
    FROM old_activity_entries e WHERE e.kind = 'audit' AND e.organization_id IS NOT NULL
      AND e.dedupe_key NOT GLOB 'team-message:*';

-- Where each old send is now recorded.
CREATE TEMP TABLE delivery_anchors AS
  SELECT d.id AS delivery_id, e.id AS entry_id, e.kind, e.organization_id,
         CASE
           WHEN EXISTS (SELECT 1 FROM messages m WHERE m.id = e.id) THEN e.id
           WHEN e.kind = 'notification' AND EXISTS (SELECT 1 FROM messages m WHERE m.id = e.parent_id) THEN e.parent_id
           WHEN e.kind = 'audit' AND e.dedupe_key GLOB 'team-message:*' AND EXISTS (SELECT 1 FROM messages m WHERE m.id = substr(e.dedupe_key, 14)) THEN substr(e.dedupe_key, 14)
           -- A dropped entry's sends (an empty booking submission's acknowledgement) are its conversation's first message's.
           WHEN e.request_id IS NOT NULL THEN (SELECT m.id FROM messages m WHERE m.conversation_id = e.request_id ORDER BY m.sequence LIMIT 1)
           WHEN e.kind = 'notification' AND parent.request_id IS NOT NULL THEN (SELECT m.id FROM messages m WHERE m.conversation_id = parent.request_id ORDER BY m.sequence LIMIT 1)
         END AS message_id,
         CASE WHEN e.kind = 'notification' AND json_extract(e.payload_json, '$.task_id') IN (SELECT id FROM old_tasks) THEN json_extract(e.payload_json, '$.task_id') END AS task_id
    FROM old_guest_thread_deliveries d JOIN old_activity_entries e ON e.id = d.entry_id
    LEFT JOIN old_activity_entries parent ON parent.id = e.parent_id;

INSERT INTO activity_entries (id, organization_id, location_id, actor_kind, actor_user_id, body, event_name, payload_json, dedupe_key, occurred_at, created_at)
  SELECT n.id, n.organization_id, n.location_id, 'system', NULL, n.body, 'owner.alerted',
         json_object('entityType', 'alert', 'entityId', n.id, 'actorType', 'system', 'metadata', json_object('template', n.event_name, 'payload', json(n.payload_json))),
         'alert:' || n.dedupe_key, n.occurred_at, n.created_at
    FROM old_activity_entries n
   WHERE n.organization_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM activity_entries a WHERE a.id = n.id)
     AND n.id IN (SELECT entry_id FROM delivery_anchors WHERE message_id IS NULL AND task_id IS NULL);

-- report: sends of a personal alert about no organization (a buyer's own
-- receipt mail); they have nothing to be recorded on and are not kept.
SELECT COUNT(*) AS personal_sends_dropped FROM delivery_anchors WHERE message_id IS NULL AND task_id IS NULL AND organization_id IS NULL;

-- 6. Sends. A task's start alert is keyed by its task and day, as cleaner jobs
--    look for it (notifications.ts taskStartingSent).
INSERT INTO guest_thread_deliveries (id, message_id, activity_entry_id, task_id, channel, provider, purpose, status, provider_message_id, email_json, email_message_id, error, non_delivery_confirmed, created_at, updated_at)
  SELECT CASE WHEN a.message_id IS NULL AND a.task_id IS NOT NULL AND e.dedupe_key GLOB 'notification:task-starting:*'
              THEN a.task_id || ':owner_alert:' || d.channel || ':task_starting:' || substr(e.dedupe_key, length('notification:task-starting:' || a.task_id || ':') + 1, 10) || ':' || d.id
              ELSE d.id END,
         a.message_id,
         CASE WHEN a.message_id IS NULL AND a.task_id IS NULL THEN (SELECT id FROM activity_entries WHERE id = a.entry_id) END,
         CASE WHEN a.message_id IS NULL THEN a.task_id END,
         d.channel, d.provider, d.purpose, d.status, d.provider_message_id, d.email_json, d.email_message_id, d.error, d.non_delivery_confirmed, d.created_at, d.updated_at
    FROM old_guest_thread_deliveries d JOIN delivery_anchors a ON a.delivery_id = d.id JOIN old_activity_entries e ON e.id = d.entry_id
   WHERE a.message_id IS NOT NULL OR a.task_id IS NOT NULL OR EXISTS (SELECT 1 FROM activity_entries x WHERE x.id = a.entry_id);

-- 7. The tables that named a request or an entry name the conversation or the message.
INSERT INTO bookings (id, organization_id, user_id, product_id, product_variant_id, product_session_id, location_id, starts_at, ends_at, timezone, party_size, adults, children, infants, party_size_is_minimum, status, cancelled_at, cancellation_reason, no_show_at, answers, private_notes, policy_json, total_minor, currency, idempotency_key, version, channel, owner, provider, external_booking_id, channel_booking_id, revision_id, provider_updated_at, overbooked, booked_product_id, received_at, created_at, updated_at)
  SELECT id, organization_id, user_id, product_id, product_variant_id, product_session_id, location_id, starts_at, ends_at, timezone, party_size, adults, children, infants, party_size_is_minimum, status, cancelled_at, cancellation_reason, no_show_at, answers, private_notes, policy_json, total_minor, currency, idempotency_key, version, channel, owner, provider, external_booking_id, channel_booking_id, revision_id, provider_updated_at, overbooked, booked_product_id, received_at, created_at, updated_at
    FROM old_bookings;

INSERT INTO channel_threads (provider, external_thread_id, organization_id, product_id, conversation_id, external_booking_id, provider_updated_at, moved_from_thread_id, created_at, updated_at)
  SELECT provider, external_thread_id, organization_id, product_id, request_id, external_booking_id, provider_updated_at, moved_from_thread_id, created_at, updated_at FROM old_channel_threads;

INSERT INTO content_reports (id, organization_id, reporter_user_id, subject, conversation_id, message_id, author_user_id, reason, excerpt, blocked, status, resolved_by_user_id, resolved_at, created_at)
  SELECT id, organization_id, reporter_user_id, CASE subject WHEN 'guest_thread' THEN 'conversation' ELSE 'message' END,
         request_id, CASE WHEN team_message_id IN (SELECT id FROM messages) THEN team_message_id END,
         author_user_id, reason, excerpt, blocked, status, resolved_by_user_id, resolved_at, created_at
    FROM old_content_reports;

-- A message's photos are placed on the message; a dropped entry's go with it.
INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, status, presentation_json, created_at, updated_at)
  SELECT id, organization_id, CASE WHEN owner_type IN ('activity_entry', 'team_message') THEN 'message' ELSE owner_type END,
         owner_id, slot, asset_id, sort_order, status, presentation_json, created_at, updated_at
    FROM old_media_placements
   WHERE owner_type NOT IN ('activity_entry', 'team_message') OR owner_id IN (SELECT id FROM messages);

INSERT INTO payment_checkout_holds (id, organization_id, product_id, variant_id, price_id, session_id, location_id, timezone, buyer_user_id, conversation_id, payment_id, quantity, amount, currency, starts_at, ends_at, status, expires_at, created_at, converted_booking_id)
  SELECT id, organization_id, product_id, variant_id, price_id, session_id, location_id, timezone, buyer_user_id, request_id, payment_id, quantity, amount, currency, starts_at, ends_at, status, expires_at, created_at, converted_booking_id FROM old_payment_checkout_holds;

INSERT INTO scheduled_guest_messages (id, organization_id, product_id, booking_id, template_id, template_title, template_version, body, due_at, timezone, status, reason, error_code, error_field, message_id, started_at, sent_at, created_at, updated_at)
  SELECT id, organization_id, product_id, booking_id, template_id, template_title, template_version, body, due_at, timezone, status, reason, error_code, error_field, entry_id, started_at, sent_at, created_at, updated_at FROM old_scheduled_guest_messages;

-- Send later → the one outbox: the outbox part of the combined migration's data move.
--
-- scheduled_guest_messages is the one outbox. A member's send-later reply is a
-- row with author_user_id set and no product, booking, template, title,
-- version or timezone (scheduled_guest_messages_kind_check); an automatic
-- message keeps author_user_id NULL. send_later_messages is dropped.
--
-- Insert after the automatic outbox rows in data-move-conversations.sql,
-- replacing its INSERT INTO send_later_messages. The old tables are still
-- present; conversations and messages have been copied with their IDs.
-- The final outbox inherits an automatic message's conversation from its
-- booking. The member reply has its own conversation, including inquiries.
-- Every ID is preserved: Inbox Retry reuses the send-later:<id> send key.
-- A nonzero check stops the move before the old tables are dropped.

-- must return 0: no automatic message fails the outbox's stricter error check
-- (a failed or needs-review row names its reason, code and field).
SELECT COUNT(*) FROM old_scheduled_guest_messages
 WHERE status IN ('failed', 'needs_review') AND NOT (coalesce(length(trim(reason)), 0) > 0 AND coalesce(length(trim(error_code)), 0) > 0 AND coalesce(length(trim(error_field)), 0) > 0);

-- must return 0: no send-later id collides with an automatic message's.
SELECT COUNT(*) FROM old_send_later_messages l JOIN old_scheduled_guest_messages m ON m.id = l.id;

-- must return 0: every reply's conversation and author still exist.
SELECT COUNT(*) FROM old_send_later_messages l
 WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = l.request_id AND c.organization_id = l.organization_id)
    OR NOT EXISTS (SELECT 1 FROM user u WHERE u.id = l.user_id);

-- Every reply, in every status, as its author's outbox row. version was only
-- the edit guard of the deleted edit route; the outbox guards on updated_at.
INSERT INTO scheduled_guest_messages (id, organization_id, product_id, booking_id, conversation_id, author_user_id, template_id, template_title, template_version,
    body, due_at, timezone, status, reason, error_code, error_field, message_id, started_at, sent_at, created_at, updated_at)
  SELECT id, organization_id, NULL, NULL, request_id, user_id, NULL, NULL, NULL,
         body, due_at, NULL, status, reason, error_code, error_field, entry_id, started_at, sent_at, created_at, updated_at
    FROM old_send_later_messages;

-- must return 0: the outbox holds every automatic message and every reply, once.
SELECT (SELECT COUNT(*) FROM old_scheduled_guest_messages) + (SELECT COUNT(*) FROM old_send_later_messages) - (SELECT COUNT(*) FROM scheduled_guest_messages);

-- must return 0: every reply kept its conversation, author, text, time, status and outcome.
SELECT COUNT(*) FROM old_send_later_messages l
 WHERE NOT EXISTS (SELECT 1 FROM scheduled_guest_messages m WHERE m.id = l.id AND m.organization_id = l.organization_id AND m.conversation_id = l.request_id
   AND m.author_user_id = l.user_id AND m.booking_id IS NULL AND m.body = l.body AND m.due_at = l.due_at AND m.status = l.status
   AND m.message_id IS l.entry_id AND m.reason IS l.reason AND m.error_code IS l.error_code AND m.error_field IS l.error_field
   AND m.started_at IS l.started_at AND m.sent_at IS l.sent_at AND m.created_at = l.created_at AND m.updated_at = l.updated_at);

-- must return 0: every automatic message stayed the business's.
SELECT COUNT(*) FROM scheduled_guest_messages m JOIN old_scheduled_guest_messages o ON o.id = m.id WHERE m.author_user_id IS NOT NULL OR m.booking_id IS NULL;



INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, location_id, opportunity_id, title, notes, assigned_member_id, starts_at, due_at, timezone, status, outcome_note, closed_at, closed_by_user_id, dedupe_key, version, created_by_user_id, created_at, updated_at)
  SELECT id, organization_id, kind, CASE subject_type WHEN 'request' THEN 'conversation' ELSE subject_type END, subject_id, product_id, location_id, opportunity_id, title, notes, assigned_member_id, starts_at, due_at, timezone, status, outcome_note, closed_at, closed_by_user_id, dedupe_key, version, created_by_user_id, created_at, updated_at FROM old_tasks;

-- must return 0: every request, team thread, kept entry and team message moved
-- with its id; every sent scheduled message and send-later reply names a
-- message; every send that had a conversation, task or organization is kept;
-- every conversation's messages are numbered from 1 without gaps; every
-- booking that named a conversation is named by it.
SELECT (SELECT COUNT(*) FROM old_requests) + (SELECT COUNT(*) FROM old_team_threads) - (SELECT COUNT(*) FROM conversations)
     + (SELECT COUNT(*) FROM entry_moves WHERE id NOT IN (SELECT id FROM messages))
     + (SELECT COUNT(*) FROM old_team_messages WHERE id NOT IN (SELECT id FROM messages))
     + (SELECT COUNT(*) FROM scheduled_guest_messages WHERE message_id IS NOT NULL AND message_id NOT IN (SELECT id FROM messages))
     + abs((SELECT COUNT(*) FROM delivery_anchors WHERE message_id IS NOT NULL OR task_id IS NOT NULL OR organization_id IS NOT NULL) - (SELECT COUNT(*) FROM guest_thread_deliveries))
     + (SELECT COUNT(*) FROM (SELECT conversation_id FROM messages GROUP BY conversation_id HAVING MAX(sequence) <> COUNT(*)))
     + (SELECT COUNT(*) FROM old_bookings b WHERE b.request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = b.request_id AND c.booking_id = b.id));

-- must return 0: no conversation that was read is unread now. A member's
-- conversation is unread only where an alert of theirs was unacknowledged; a
-- team seat only where a teammate's message came after its last read.
SELECT (SELECT COUNT(*) FROM conversation_participants p JOIN member_reads mr ON mr.conversation_id = p.conversation_id AND mr.user_id = p.user_id
         WHERE mr.first_unread IS NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = p.conversation_id AND m.author_user_id IS NOT p.user_id
           AND m.sequence > COALESCE((SELECT r.sequence FROM messages r WHERE r.id = p.last_read_message_id), 0)))
     + (SELECT COUNT(*) FROM conversation_participants p JOIN team_reads tr ON tr.thread_id = p.conversation_id AND tr.user_id = p.user_id
         WHERE tr.first_unread_at IS NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = p.conversation_id AND m.author_user_id IS NOT p.user_id
           AND m.sequence > COALESCE((SELECT r.sequence FROM messages r WHERE r.id = p.last_read_message_id), 0)));

DROP TABLE old_requests;
DROP TABLE old_team_threads;
DROP TABLE old_team_messages;
DROP TABLE old_team_thread_members;
DROP TABLE old_activity_entries;
DROP TABLE old_guest_thread_deliveries;
DROP TABLE old_bookings;
DROP TABLE old_channel_threads;
DROP TABLE old_content_reports;
DROP TABLE old_media_placements;
DROP TABLE old_payment_checkout_holds;
DROP TABLE old_scheduled_guest_messages;
DROP TABLE old_send_later_messages;
DROP TABLE old_tasks;
DROP TABLE entry_moves;
DROP TABLE team_reads;
DROP TABLE member_reads;
DROP TABLE guest_reads;
DROP TABLE delivery_anchors;

-- Every reference resolves once the old tables are gone.

-- stage: prices
-- Move dated and weekend prices from v26 to prices on the home's sole variant.
-- Run after copying existing prices and variants and before dropping the v26
-- source tables. The booking-config copy takes only the weekday minimums:
-- NULLIF(json_remove(old_product_stay_configs.calendar_rules, '$.weekend_price_minor'), '{}').
-- The product_nights copy below preserves every restriction and source.
-- Table deposits already enter prices in data-move-reservations.sql.

-- Every rate must have one variant and a valid amount.
SELECT COUNT(*) FROM (
  SELECT organization_id, product_id, price_minor AS amount FROM old_product_nights WHERE price_minor IS NOT NULL
  UNION ALL
  SELECT organization_id, product_id, json_extract(calendar_rules, '$.weekend_price_minor') FROM old_product_stay_configs
   WHERE json_type(calendar_rules, '$.weekend_price_minor') IS NOT NULL
) r
WHERE typeof(r.amount) <> 'integer' OR r.amount < 0 OR r.amount > 9007199254740991
   OR (SELECT COUNT(*) FROM product_variants v WHERE v.organization_id = r.organization_id AND v.product_id = r.product_id) <> 1;

INSERT INTO prices (id, organization_id, product_variant_id, stay_date, currency, unit_amount, source, created_at, updated_at, created_by, updated_by)
SELECT 'night-rate:' || v.id || ':' || n.date, n.organization_id, v.id, n.date, o.default_currency,
       n.price_minor, n.source, n.updated_at, n.updated_at, n.updated_by, n.updated_by
  FROM old_product_nights n
  JOIN product_variants v ON v.organization_id = n.organization_id AND v.product_id = n.product_id
  JOIN organization o ON o.id = n.organization_id
 WHERE n.price_minor IS NOT NULL;

INSERT INTO prices (id, organization_id, product_variant_id, weekend, currency, unit_amount, created_at, updated_at, created_by, updated_by)
SELECT 'weekend-rate:' || v.id, c.organization_id, v.id, 1, o.default_currency,
       json_extract(c.calendar_rules, '$.weekend_price_minor'), c.created_at, c.updated_at, c.created_by, c.updated_by
  FROM old_product_stay_configs c
  JOIN product_variants v ON v.organization_id = c.organization_id AND v.product_id = c.product_id
  JOIN organization o ON o.id = c.organization_id
 WHERE json_type(c.calendar_rules, '$.weekend_price_minor') IS NOT NULL;

INSERT INTO product_nights (organization_id, product_id, date, closed, min_stay_arrival, max_stay, closed_to_arrival, closed_to_departure, source, updated_at, updated_by)
SELECT organization_id, product_id, date, closed, min_stay_arrival, max_stay, closed_to_arrival, closed_to_departure, source, updated_at, updated_by
  FROM old_product_nights;

-- A zero result confirms each stored rate and its currency, including zero rates.
SELECT
  (SELECT COUNT(*) FROM old_product_nights n WHERE n.price_minor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM product_variants v JOIN prices p ON p.organization_id = v.organization_id AND p.product_variant_id = v.id
    JOIN organization o ON o.id = n.organization_id
    WHERE v.organization_id = n.organization_id AND v.product_id = n.product_id AND p.stay_date = n.date
      AND p.unit_amount = n.price_minor AND p.currency = o.default_currency))
  + (SELECT COUNT(*) FROM old_product_stay_configs c WHERE json_type(c.calendar_rules, '$.weekend_price_minor') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM product_variants v JOIN prices p ON p.organization_id = v.organization_id AND p.product_variant_id = v.id
    JOIN organization o ON o.id = c.organization_id
    WHERE v.organization_id = c.organization_id AND v.product_id = c.product_id AND p.weekend = 1
      AND p.unit_amount = json_extract(c.calendar_rules, '$.weekend_price_minor') AND p.currency = o.default_currency));

-- stage: usage-and-calendar
-- Usage and Google Calendar setup consolidation.
-- Run with the v26 source tables under their old_ names. Copy normal
-- organization_integrations selections first. All checks must return zero.

-- The pending creation attempt and an already selected Calendar can coexist
-- in v26. A two-row overlap needs the provider state resolved before copying.
SELECT COUNT(*) FROM old_google_calendar_setup s JOIN organization_integrations i
  ON i.organization_id = s.organization_id AND i.provider = 'google_calendar';

INSERT INTO organization_integrations (id, organization_id, provider, account_id, status, revision, created_at, updated_at)
SELECT 'calendar-setup:' || organization_id, organization_id, 'google_calendar', account_id, 'setting_up',
       'calendar-setup:' || organization_id, started_at, started_at
  FROM old_google_calendar_setup;

-- Copy the activity events and the Stripe-meter events once, preserving their
-- idempotency keys, original quantities and delivery state.
SELECT COUNT(*) FROM old_usage_events u JOIN old_payment_usage_events p ON p.id = u.id;

INSERT INTO usage_events (id, organization_id, resource, source, provider, channel, session_id, quantity, unit,
    metadata_json, idempotency_key, created_at)
SELECT id, organization_id, resource, source, provider, channel, session_id, quantity, unit, metadata_json, idempotency_key, created_at
  FROM old_usage_events;

INSERT INTO usage_events (id, organization_id, resource, source, provider, quantity, unit, idempotency_key, created_at,
    payment_id, billing_basis_json, provider_occurred_at, delivery_at, error)
SELECT id, organization_id, kind, 'payments', 'stripe', amount, currency, source_id, created_at,
       payment_id, billing_basis_json, provider_occurred_at, delivery_at, error
  FROM old_payment_usage_events;

SELECT (SELECT COUNT(*) FROM old_usage_events) + (SELECT COUNT(*) FROM old_payment_usage_events) - (SELECT COUNT(*) FROM usage_events);
SELECT COUNT(*) FROM old_payment_usage_events p WHERE NOT EXISTS (
  SELECT 1 FROM usage_events u WHERE u.id = p.id AND u.organization_id = p.organization_id AND u.resource = p.kind
    AND u.quantity = p.amount AND u.unit = p.currency AND u.idempotency_key = p.source_id AND u.payment_id IS p.payment_id
    AND u.billing_basis_json IS p.billing_basis_json AND u.provider_occurred_at = p.provider_occurred_at
    AND u.delivery_at IS p.delivery_at AND u.error IS p.error);

-- stage: media-reviews-localizations
-- Transfer photo room membership, accessibility evidence and localized
-- resources after the canonical owners, assets, documents and locales exist.
-- The review copy omits reviews.review_request_id. Run the review check
-- against the old relation and the submitted requests after booking IDs move.

INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, created_at, updated_at)
SELECT 'stay-room-photo:' || m.room_id || ':' || m.asset_id, m.organization_id, 'stay_photo_room', m.room_id, 'photo', m.asset_id,
       row_number() OVER (PARTITION BY m.organization_id, m.room_id ORDER BY m.asset_id) - 1, a.created_at, a.created_at
  FROM old_product_stay_photo_room_memberships m JOIN media_assets a ON a.id = m.asset_id AND a.organization_id = m.organization_id;

INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, created_at, updated_at)
SELECT 'stay-room-proof:' || m.room_id || ':' || m.feature_code || ':' || m.asset_id, m.organization_id, 'stay_room_accessibility', m.room_id, m.feature_code, m.asset_id,
       row_number() OVER (PARTITION BY m.organization_id, m.room_id, m.feature_code ORDER BY m.asset_id) - 1, a.created_at, a.created_at
  FROM old_product_stay_room_accessibility_photos m JOIN media_assets a ON a.id = m.asset_id AND a.organization_id = m.organization_id;

INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, created_at, updated_at)
SELECT 'stay-home-proof:' || m.product_id || ':' || m.feature_code || ':' || m.asset_id, m.organization_id, 'stay_home_accessibility', m.product_id, m.feature_code, m.asset_id,
       row_number() OVER (PARTITION BY m.organization_id, m.product_id, m.feature_code ORDER BY m.asset_id) - 1, a.created_at, a.created_at
  FROM old_product_stay_accessibility_photos m JOIN media_assets a ON a.id = m.asset_id AND a.organization_id = m.organization_id;

SELECT
  (SELECT COUNT(*) FROM old_product_stay_photo_room_memberships) +
  (SELECT COUNT(*) FROM old_product_stay_room_accessibility_photos) +
  (SELECT COUNT(*) FROM old_product_stay_accessibility_photos) -
  (SELECT COUNT(*) FROM media_placements WHERE owner_type IN ('stay_photo_room', 'stay_room_accessibility', 'stay_home_accessibility'));

SELECT COUNT(*) FROM old_reviews o JOIN reviews r ON r.id = o.id
 WHERE o.review_request_id IS NOT (
   SELECT rr.id FROM review_requests rr WHERE rr.organization_id = r.organization_id AND rr.booking_id = r.booking_id
     AND rr.submitted_at IS NOT NULL AND r.source = 'direct');

INSERT INTO content_documents (id, organization_id, kind, row_role, resource_type, resource_id, locale,
    metadata_json, path, created_at, created_by, updated_at, updated_by)
SELECT id, organization_id, 'resource', 'representation', resource_type, resource_id, locale,
       values_json, route_path, created_at, created_by_user_id, updated_at, updated_by_user_id
  FROM old_resource_localizations;

SELECT COUNT(*) FROM old_resource_localizations l WHERE NOT EXISTS (
  SELECT 1 FROM content_documents d WHERE d.id = l.id AND d.organization_id = l.organization_id
    AND d.kind = 'resource' AND d.row_role = 'representation' AND d.resource_type = l.resource_type
    AND d.resource_id = l.resource_id AND d.locale = l.locale AND d.metadata_json = l.values_json AND d.path IS l.route_path
    AND d.created_at = l.created_at AND d.updated_at = l.updated_at AND d.created_by = l.created_by_user_id AND d.updated_by = l.updated_by_user_id);

-- stage: payloads
-- Run after the conversation move. Preserve message IDs, sequence, author and delivery anchors.
UPDATE messages
   SET payload_json = json_remove(
       json_set(payload_json, '$.booking_id', json_extract(payload_json, '$.operational_booking_id')),
       '$.operational_booking_id')
 WHERE json_type(payload_json, '$.operational_booking_id') = 'text';

UPDATE messages
   SET payload_json = json_remove(
       json_set(payload_json,
         '$.updated_at', json_extract(payload_json, '$.updatedAt'),
         '$.after.product_session_id', json_extract(payload_json, '$.after.sessionId'),
         '$.after.party_size', json_extract(payload_json, '$.after.partySize')),
       '$.after.sessionId', '$.after.partySize', '$.before.operationalUpdatedAt', '$.updatedAt')
 WHERE event_name IN ('booking_change.requested', 'booking_change.moved')
   AND json_type(payload_json, '$.after.sessionId') = 'text'
   AND json_type(payload_json, '$.after.partySize') = 'integer';

-- Convert schedule keys without changing the trigger, offering IDs, or due time.
INSERT INTO message_templates (id, organization_id, title, body, schedule_json, schedule_enabled_at, version, created_at, updated_at)
SELECT id, organization_id, title, body, CASE
       WHEN schedule_json IS NULL THEN NULL
       WHEN json_extract(schedule_json, '$.trigger') = 'booking_received' THEN
         json_object('trigger', 'booking_received', 'delay_minutes', json_extract(schedule_json, '$.delayMinutes'),
           'product_ids', schedule_json -> '$.productIds')
       WHEN json_type(schedule_json, '$.offsetHours') = 'integer' THEN
         json_object('trigger', json_extract(schedule_json, '$.trigger'), 'offset_hours', json_extract(schedule_json, '$.offsetHours'),
           'product_ids', schedule_json -> '$.productIds')
       ELSE
         json_object('trigger', json_extract(schedule_json, '$.trigger'), 'offset_days', json_extract(schedule_json, '$.offsetDays'),
           'local_time', json_extract(schedule_json, '$.localTime'), 'product_ids', schedule_json -> '$.productIds')
       END, schedule_enabled_at, version, created_at, updated_at
  FROM old_message_templates;

-- stage: sessions
-- Former providers could publish the same occurrence as separate slots. A
-- slot now belongs to the offering at that instant. Pick the oldest ID to
-- keep the choice stable between initial load and final delta.
CREATE TEMP TABLE duplicate_session_ids AS
WITH ranked AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY product_id, location_id, starts_at ORDER BY created_at, id
         ) AS retained_id
    FROM old_product_sessions
)
SELECT id, retained_id FROM ranked WHERE id <> retained_id;

-- Combining different windows or capacities would change an offering.
SELECT count(*) FROM duplicate_session_ids d
  JOIN old_product_sessions old ON old.id = d.id
  JOIN old_product_sessions keep ON keep.id = d.retained_id
 WHERE old.organization_id <> keep.organization_id OR old.ends_at <> keep.ends_at
    OR old.timezone <> keep.timezone OR old.status <> keep.status
    OR old.capacity IS NOT keep.capacity;

UPDATE bookings
   SET product_session_id = (SELECT retained_id FROM duplicate_session_ids WHERE id = bookings.product_session_id)
 WHERE product_session_id IN (SELECT id FROM duplicate_session_ids);

UPDATE payment_checkout_holds
   SET session_id = (SELECT retained_id FROM duplicate_session_ids WHERE id = payment_checkout_holds.session_id)
 WHERE session_id IN (SELECT id FROM duplicate_session_ids);

UPDATE payments
   SET price_snapshot_json = json_set(price_snapshot_json, '$.session_id',
     (SELECT retained_id FROM duplicate_session_ids WHERE id = json_extract(payments.price_snapshot_json, '$.session_id')))
 WHERE json_extract(price_snapshot_json, '$.session_id') IN (SELECT id FROM duplicate_session_ids);

UPDATE messages
   SET payload_json = json_set(payload_json, '$.before.sessionId',
     (SELECT retained_id FROM duplicate_session_ids WHERE id = json_extract(messages.payload_json, '$.before.sessionId')))
 WHERE event_name IN ('booking_change.requested', 'booking_change.moved')
   AND json_extract(payload_json, '$.before.sessionId') IN (SELECT id FROM duplicate_session_ids);

UPDATE messages
   SET payload_json = json_set(payload_json, '$.after.product_session_id',
     (SELECT retained_id FROM duplicate_session_ids WHERE id = json_extract(messages.payload_json, '$.after.product_session_id')))
 WHERE event_name IN ('booking_change.requested', 'booking_change.moved')
   AND json_extract(payload_json, '$.after.product_session_id') IN (SELECT id FROM duplicate_session_ids);

-- Refuse to combine active commitments beyond the retained slot's capacity.
SELECT count(*) FROM old_product_sessions s
 WHERE s.id IN (SELECT retained_id FROM duplicate_session_ids) AND s.capacity IS NOT NULL
   AND s.ends_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   AND s.capacity <
       (SELECT coalesce(sum(b.party_size), 0) FROM bookings b
         WHERE b.product_session_id = s.id AND b.status IN ('pending', 'confirmed'))
       + (SELECT coalesce(sum(h.quantity), 0) FROM payment_checkout_holds h
          WHERE h.session_id = s.id AND h.status = 'active' AND h.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

DELETE FROM old_product_sessions WHERE id IN (SELECT id FROM duplicate_session_ids);
DROP TABLE duplicate_session_ids;
