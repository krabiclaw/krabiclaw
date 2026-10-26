CREATE TABLE `google_calendar_sync` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`integration_revision` text NOT NULL,
	`channel_id` text NOT NULL,
	`channel_token` text NOT NULL,
	`resource_id` text,
	`channel_expires_at` text,
	`sync_token` text,
	`reschedules` integer DEFAULT 1 NOT NULL,
	`last_pulled_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_calendar_sync_channel_unique` ON `google_calendar_sync` (`channel_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_channel_sync_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`product_id` text,
	`provider` text NOT NULL,
	`direction` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`task_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_sync_log_provider_check" CHECK(provider IN ('channex', 'google_calendar')),
	CONSTRAINT "channel_sync_log_direction_check" CHECK(direction IN ('inbound', 'outbound')),
	CONSTRAINT "channel_sync_log_kind_check" CHECK(kind IN ('booking_revision', 'availability', 'restrictions', 'calendar_event')),
	CONSTRAINT "channel_sync_log_status_check" CHECK(status IN ('applied', 'acknowledged', 'ignored_disconnected', 'failed', 'needs_review', 'pushed')),
	CONSTRAINT "channel_sync_log_failed_check" CHECK(status NOT IN ('failed', 'needs_review') OR detail IS NOT NULL),
	CONSTRAINT "channel_sync_log_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);
--> statement-breakpoint
INSERT INTO `__new_channel_sync_log`("id", "organization_id", "product_id", "provider", "direction", "kind", "external_id", "status", "detail", "task_id", "created_at") SELECT "id", "organization_id", "product_id", "provider", "direction", "kind", "external_id", "status", "detail", "task_id", "created_at" FROM `channel_sync_log`;--> statement-breakpoint
DROP TABLE `channel_sync_log`;--> statement-breakpoint
ALTER TABLE `__new_channel_sync_log` RENAME TO `channel_sync_log`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `channel_sync_log_external_idx` ON `channel_sync_log` (`provider`,`kind`,`external_id`);--> statement-breakpoint
CREATE INDEX `channel_sync_log_product_idx` ON `channel_sync_log` (`product_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `channel_sync_log_org_idx` ON `channel_sync_log` (`organization_id`,`created_at`);