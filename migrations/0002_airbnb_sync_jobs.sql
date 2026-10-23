CREATE TABLE `airbnb_sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`product_id` text,
	`action` text NOT NULL,
	`details` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`requested_by` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`last_error` text,
	`next_attempt_at` text,
	`lease_token` text,
	`lease_until` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "airbnb_sync_jobs_action_check" CHECK(action IN ('sync', 'stop')),
	CONSTRAINT "airbnb_sync_jobs_state_check" CHECK(state IN ('pending', 'error', 'done', 'failed')),
	CONSTRAINT "airbnb_sync_jobs_error_check" CHECK(state NOT IN ('error', 'failed') OR (last_error_code IS NOT NULL AND last_error IS NOT NULL)),
	CONSTRAINT "airbnb_sync_jobs_lease_check" CHECK((lease_token IS NULL) = (lease_until IS NULL)),
	CONSTRAINT "airbnb_sync_jobs_details_check" CHECK(details IS NULL OR (action = 'sync' AND json_valid(details) AND json_type(details) = 'object'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `airbnb_sync_jobs_listing_unique` ON `airbnb_sync_jobs` (`organization_id`,`listing_id`);--> statement-breakpoint
CREATE INDEX `airbnb_sync_jobs_due_idx` ON `airbnb_sync_jobs` (`state`,`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `product_channel_mappings` ADD `import_written` text;