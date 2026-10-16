-- The cancellation policy a guest booked a stay under. In place: rebuilding stays would cascade-delete its nights, payments and thread links on D1.
ALTER TABLE `stays` ADD COLUMN `cancellation_policy` text
  CONSTRAINT "stays_cancellation_policy_check" CHECK(cancellation_policy IS NULL OR cancellation_policy IN ('flexible', 'moderate', 'limited', 'firm', 'strict', 'long_term_firm', 'long_term_strict'));
