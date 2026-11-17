CREATE INDEX `idx_mcp_tool_call_events_diagnostic_retention` ON `mcp_tool_call_events` (`created_at`) WHERE json_extract(arguments_summary_json, '$._diagnostic') = 1;--> statement-breakpoint
CREATE INDEX `stripe_ga4_subscription_intents_retention_idx` ON `stripe_ga4_subscription_intents` (`consumed_at`) WHERE status = 'consumed';--> statement-breakpoint
-- Review eligibility now reads the original booking conversation event.
-- Verify the old stamp and its transcript agree before deploying that reader.
CREATE TABLE __historical_no_show_check (
  history_matches INTEGER NOT NULL CONSTRAINT historical_no_show_transcript_check CHECK (history_matches = 1)
);--> statement-breakpoint
INSERT INTO __historical_no_show_check (history_matches)
SELECT 0
FROM bookings b
LEFT JOIN conversations c ON c.organization_id = b.organization_id AND c.booking_id = b.id AND c.kind = 'booking'
LEFT JOIN messages m ON m.organization_id = c.organization_id AND m.conversation_id = c.id
  AND m.event_name IN ('booking.no_show', 'stay.no_show', 'reservation.no_show')
WHERE b.no_show_at IS NOT m.occurred_at
LIMIT 1;--> statement-breakpoint
DROP TABLE __historical_no_show_check;
