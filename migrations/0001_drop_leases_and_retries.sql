PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_airbnb_sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`product_id` text,
	`action` text NOT NULL,
	`details` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`requested_by` text,
	`last_error_code` text,
	`last_error` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "airbnb_sync_jobs_action_check" CHECK(action IN ('sync', 'stop')),
	CONSTRAINT "airbnb_sync_jobs_state_check" CHECK(state IN ('pending', 'done', 'failed')),
	CONSTRAINT "airbnb_sync_jobs_error_check" CHECK(state <> 'failed' OR (last_error_code IS NOT NULL AND last_error IS NOT NULL)),
	CONSTRAINT "airbnb_sync_jobs_details_check" CHECK(details IS NULL OR (action = 'sync' AND json_valid(details) AND json_type(details) = 'object'))
);
--> statement-breakpoint
INSERT INTO `__new_airbnb_sync_jobs`("id", "organization_id", "listing_id", "product_id", "action", "details", "state", "requested_by", "last_error_code", "last_error", "completed_at", "created_at", "updated_at") SELECT "id", "organization_id", "listing_id", "product_id", "action", "details", "state", "requested_by", "last_error_code", "last_error", "completed_at", "created_at", "updated_at" FROM `airbnb_sync_jobs`;--> statement-breakpoint
DROP TABLE `airbnb_sync_jobs`;--> statement-breakpoint
ALTER TABLE `__new_airbnb_sync_jobs` RENAME TO `airbnb_sync_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `airbnb_sync_jobs_listing_unique` ON `airbnb_sync_jobs` (`organization_id`,`listing_id`);--> statement-breakpoint
CREATE TABLE `__new_channel_night_pushes` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`provider` text NOT NULL,
	`date` text NOT NULL,
	`state` text NOT NULL,
	`detail` text,
	`sent_json` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`product_id`, `provider`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`,`provider`) REFERENCES `product_channel_mappings`(`product_id`,`provider`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_night_pushes_provider_check" CHECK(provider = 'channex'),
	CONSTRAINT "channel_night_pushes_state_check" CHECK(state IN ('pending', 'pushed', 'needs_review')),
	CONSTRAINT "channel_night_pushes_detail_check" CHECK(state <> 'needs_review' OR detail IS NOT NULL),
	CONSTRAINT "channel_night_pushes_date_check" CHECK(date(date) IS date),
	CONSTRAINT "channel_night_pushes_updated_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
INSERT INTO `__new_channel_night_pushes`("organization_id", "product_id", "provider", "date", "state", "detail", "sent_json", "updated_at") SELECT "organization_id", "product_id", "provider", "date", "state", "detail", "sent_json", "updated_at" FROM `channel_night_pushes`;--> statement-breakpoint
DROP TABLE `channel_night_pushes`;--> statement-breakpoint
ALTER TABLE `__new_channel_night_pushes` RENAME TO `channel_night_pushes`;--> statement-breakpoint
CREATE INDEX `channel_night_pushes_state_idx` ON `channel_night_pushes` (`organization_id`,`state`);--> statement-breakpoint
CREATE TABLE `__new_public_resource_cache_invalidations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`processed_at` text,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "public_resource_cache_invalidations_instants_check" CHECK((processed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', processed_at, '+0 days') IS processed_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at))
);
--> statement-breakpoint
INSERT INTO `__new_public_resource_cache_invalidations`("id", "organization_id", "reason", "status", "processed_at", "last_error", "created_at") SELECT "id", "organization_id", "reason", "status", "processed_at", "last_error", "created_at" FROM `public_resource_cache_invalidations`;--> statement-breakpoint
DROP TABLE `public_resource_cache_invalidations`;--> statement-breakpoint
ALTER TABLE `__new_public_resource_cache_invalidations` RENAME TO `public_resource_cache_invalidations`;--> statement-breakpoint
CREATE INDEX `public_resource_cache_invalidations_status_idx` ON `public_resource_cache_invalidations` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `public_resource_cache_invalidations_org_idx` ON `public_resource_cache_invalidations` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `__new_stripe_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`stripe_event_id` text NOT NULL,
	`event_type` text,
	`processor` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "stripe_webhook_events_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)),
	CONSTRAINT "stripe_webhook_events_payload_check" CHECK(payload IS NULL OR (json_valid(payload)))
);
--> statement-breakpoint
INSERT INTO `__new_stripe_webhook_events`("id", "stripe_event_id", "event_type", "processor", "status", "payload", "error", "created_at") SELECT "id", "stripe_event_id", "event_type", "processor", "status", "payload", "error", "created_at" FROM `stripe_webhook_events`;--> statement-breakpoint
DROP TABLE `stripe_webhook_events`;--> statement-breakpoint
ALTER TABLE `__new_stripe_webhook_events` RENAME TO `stripe_webhook_events`;--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_webhook_events_stripe_event_id_unique` ON `stripe_webhook_events` (`stripe_event_id`);--> statement-breakpoint
DROP INDEX `google_calendar_cleanup_due_idx`;--> statement-breakpoint
ALTER TABLE `google_calendar_cleanup_jobs` DROP COLUMN `attempts`;--> statement-breakpoint
ALTER TABLE `google_calendar_cleanup_jobs` DROP COLUMN `next_attempt_at`;--> statement-breakpoint
ALTER TABLE `google_calendar_cleanup_jobs` DROP COLUMN `lease_token`;--> statement-breakpoint
ALTER TABLE `google_calendar_cleanup_jobs` DROP COLUMN `lease_until`;--> statement-breakpoint
DROP INDEX `google_calendar_due_idx`;--> statement-breakpoint
ALTER TABLE `google_calendar_event_links` DROP COLUMN `attempts`;--> statement-breakpoint
ALTER TABLE `google_calendar_event_links` DROP COLUMN `next_attempt_at`;--> statement-breakpoint
ALTER TABLE `google_calendar_event_links` DROP COLUMN `lease_token`;--> statement-breakpoint
ALTER TABLE `google_calendar_event_links` DROP COLUMN `lease_until`;--> statement-breakpoint
ALTER TABLE `payment_usage_events` DROP COLUMN `dead_letter_at`;--> statement-breakpoint
ALTER TABLE `product_channel_mappings` DROP COLUMN `delivery_lease`;--> statement-breakpoint
ALTER TABLE `product_channel_mappings` DROP COLUMN `delivery_lease_until`;