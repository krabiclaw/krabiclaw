PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_analytics_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`organization_id` text NOT NULL,
	`date` text NOT NULL,
	`key` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "analytics_summaries_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "analytics_summaries_payload_check" CHECK(json_valid(payload_json) AND json_type(payload_json) IS 'object'),
	CONSTRAINT "analytics_summaries_scope_check" CHECK((kind = 'session' AND date = ''
    AND json_type(payload_json, '$.visitor_id') IS 'text' AND json_type(payload_json, '$.started_at') IS 'text'
    AND json_type(payload_json, '$.last_seen_at') IS 'text' AND json_type(payload_json, '$.landing_path') IS 'text'
    AND json_type(payload_json, '$.attribution.source') IS 'text' AND json_type(payload_json, '$.attribution.medium') IS 'text'
    AND json_type(payload_json, '$.duration_seconds') IS 'integer' AND (payload_json ->> '$.duration_seconds') >= 0)
    OR (kind != 'session' AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND json_type(payload_json, '$.page_views') IS 'integer' AND (payload_json ->> '$.page_views') >= 0)),
	CONSTRAINT "analytics_summaries_day_metrics_check" CHECK(kind != 'organization_day' OR key = ''),
	CONSTRAINT "analytics_summaries_dimension_key_check" CHECK(kind != 'dimension_day' OR (json_valid(key) AND json_type(key) IS 'array' AND json_array_length(key) = 3
    AND json_type(key, '$[0]') IS 'text' AND (key ->> '$[0]') IN ('country', 'city', 'device', 'referrer', 'visit_source', 'product')
    AND json_type(key, '$[1]') IS 'text' AND json_type(key, '$[2]') IS 'text'))
);
--> statement-breakpoint
INSERT INTO `__new_analytics_summaries`("id", "kind", "organization_id", "date", "key", "payload_json", "created_at", "updated_at") SELECT "id", "kind", "organization_id", "date", "key", "payload_json", "created_at", "updated_at" FROM `analytics_summaries`;--> statement-breakpoint
DROP TABLE `analytics_summaries`;--> statement-breakpoint
ALTER TABLE `__new_analytics_summaries` RENAME TO `analytics_summaries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_summaries_grain_unique` ON `analytics_summaries` (`organization_id`,`kind`,`date`,`key`);--> statement-breakpoint
CREATE INDEX `analytics_summaries_session_started_idx` ON `analytics_summaries` (`organization_id`,(payload_json ->> '$.started_at')) WHERE kind = 'session';--> statement-breakpoint
CREATE INDEX `analytics_summaries_session_seen_idx` ON `analytics_summaries` (`organization_id`,(payload_json ->> '$.last_seen_at')) WHERE kind = 'session';--> statement-breakpoint
CREATE INDEX `analytics_summaries_session_visitor_idx` ON `analytics_summaries` (`organization_id`,(payload_json ->> '$.visitor_id'),(payload_json ->> '$.started_at')) WHERE kind = 'session';--> statement-breakpoint
ALTER TABLE `bookings` ADD `website_source` text;--> statement-breakpoint
UPDATE `bookings` SET `website_source` = 'Not recorded' WHERE `owner` = 'app' AND `channel` = 'direct' AND EXISTS (SELECT 1 FROM `conversations` c WHERE c.`booking_id` = `bookings`.`id` AND c.`organization_id` = `bookings`.`organization_id` AND json_extract(c.`payload_json`, '$.provenance.source') = 'website') OR (`owner` = 'app' AND `channel` = 'direct' AND `product_session_id` IS NULL AND `idempotency_key` LIKE 'checkout:%');
