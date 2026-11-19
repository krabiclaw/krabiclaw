ALTER TABLE `bookings` ADD `actual_check_out_date` text;
--> statement-breakpoint
CREATE TABLE `channex_groups` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channex_groups_group_id_unique` ON `channex_groups` (`group_id`);--> statement-breakpoint
INSERT INTO channex_groups (organization_id, group_id) SELECT organization_id, group_id FROM channex_connections WHERE group_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_channex_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`status` text NOT NULL,
	`setup_property_id` text,
	`state_hash` text,
	`authorization_url` text,
	`authorization_user_id` text,
	`authorization_title` text,
	`authorization_expires_at` text,
	`channel_id` text,
	`connected_at` text,
	`disconnect_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`authorization_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "channex_connections_status_check" CHECK(status IN ('not_connected', 'authorizing', 'connected', 'disconnecting')),
	CONSTRAINT "channex_connections_connected_check" CHECK(status <> 'connected' OR (channel_id IS NOT NULL AND connected_at IS NOT NULL)),
	CONSTRAINT "channex_connections_authorizing_check" CHECK(status <> 'authorizing' OR (authorization_url IS NOT NULL AND state_hash IS NOT NULL AND authorization_expires_at IS NOT NULL AND authorization_title IS NOT NULL)),
	CONSTRAINT "channex_connections_instants_check" CHECK((authorization_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', authorization_expires_at, '+0 days') IS authorization_expires_at) AND (connected_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', connected_at, '+0 days') IS connected_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
INSERT INTO `__new_channex_connections`("id", "organization_id", "status", "setup_property_id", "state_hash", "authorization_url", "authorization_user_id", "authorization_title", "authorization_expires_at", "channel_id", "connected_at", "disconnect_error", "created_at", "updated_at") SELECT lower(hex(randomblob(16))), "organization_id", "status", "setup_property_id", "state_hash", "authorization_url", "authorization_user_id", "authorization_title", "authorization_expires_at", "channel_id", "connected_at", "disconnect_error", "created_at", "updated_at" FROM `channex_connections` WHERE channel_id IS NOT NULL OR authorization_url IS NOT NULL OR setup_property_id IS NOT NULL;--> statement-breakpoint
DROP TABLE `channex_connections`;--> statement-breakpoint
ALTER TABLE `__new_channex_connections` RENAME TO `channex_connections`;--> statement-breakpoint
CREATE INDEX `channex_connections_org_idx` ON `channex_connections` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channex_connections_signup_unique` ON `channex_connections` (`organization_id`) WHERE channel_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `channex_connections_channel_unique` ON `channex_connections` (`channel_id`) WHERE channel_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `product_airbnb_listings` (
	`listing_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`rate_plan_id` text,
	`import_stage` text NOT NULL,
	`import_content` text,
	`import_written` text,
	`enabled` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_airbnb_listings_stage_check" CHECK(import_stage IN ('property', 'content', 'draft', 'mapping', 'activate', 'reservations', 'messages', 'complete')),
	CONSTRAINT "product_airbnb_listings_enabled_check" CHECK(enabled IN (0, 1) AND (enabled = 0 OR import_stage IN ('mapping', 'activate', 'reservations', 'messages', 'complete'))),
	CONSTRAINT "product_airbnb_listings_content_check" CHECK(import_content IS NULL OR (json_valid(import_content) AND json_type(import_content) = 'object')),
	CONSTRAINT "product_airbnb_listings_written_check" CHECK(import_written IS NULL OR (json_valid(import_written) AND json_type(import_written) = 'object'))
);
--> statement-breakpoint
CREATE INDEX `product_airbnb_listings_home_idx` ON `product_airbnb_listings` (`organization_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `product_airbnb_listings_channel_idx` ON `product_airbnb_listings` (`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_airbnb_listings_rate_plan_unique` ON `product_airbnb_listings` (`rate_plan_id`) WHERE rate_plan_id IS NOT NULL;--> statement-breakpoint
INSERT INTO product_airbnb_listings
  (listing_id, organization_id, product_id, channel_id, import_stage, import_content, import_written, enabled, created_at, updated_at)
SELECT listing_id, organization_id, product_id, channel_id,
  CASE WHEN import_stage IN ('room', 'rate', 'inventory', 'verify_inventory') THEN 'property' ELSE import_stage END,
  import_content, import_written, CASE WHEN import_stage IN ('reservations', 'messages', 'complete') THEN enabled ELSE 0 END, created_at, updated_at
FROM product_channel_mappings WHERE listing_id IS NOT NULL;--> statement-breakpoint
-- Preserve provider delivery receipts and conversation links while D1 rebuilds their parent.
CREATE TABLE `__saved_channel_night_pushes` AS SELECT rowid, `organization_id`, `product_id`, `provider`, `date`, `state`, `detail`, `sent_json`, `updated_at` FROM `channel_night_pushes`;--> statement-breakpoint
DROP TABLE `channel_night_pushes`;--> statement-breakpoint
CREATE TABLE `__saved_channel_threads` AS SELECT rowid, `provider`, `external_thread_id`, `organization_id`, `product_id`, `conversation_id`, `external_booking_id`, `provider_updated_at`, `moved_from_thread_id`, `created_at`, `updated_at` FROM `channel_threads`;--> statement-breakpoint
DROP TABLE `channel_threads`;--> statement-breakpoint

CREATE TABLE `__new_product_channel_mappings` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`provider` text NOT NULL,
	`property_id` text,
	`room_type_id` text,
	`rate_plan_id` text,
	`import_stage` text NOT NULL,
	`import_property` text,
	`enabled` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`product_id`, `provider`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_channel_mappings_provider_check" CHECK(provider = 'channex'),
	CONSTRAINT "product_channel_mappings_stage_check" CHECK(import_stage IN ('property', 'room', 'rate', 'inventory', 'verify_inventory', 'complete')),
	CONSTRAINT "product_channel_mappings_ids_check" CHECK((import_stage = 'property' OR property_id IS NOT NULL) AND (import_stage IN ('property', 'room') OR room_type_id IS NOT NULL) AND (import_stage IN ('property', 'room', 'rate') OR rate_plan_id IS NOT NULL)),
	CONSTRAINT "product_channel_mappings_property_json_check" CHECK(import_property IS NULL OR (json_valid(import_property) AND json_type(import_property) = 'object')),
	CONSTRAINT "product_channel_mappings_enabled_check" CHECK(enabled IN (0, 1) AND (enabled = 0 OR import_stage = 'complete')),
	CONSTRAINT "product_channel_mappings_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
INSERT INTO `__new_product_channel_mappings`("organization_id", "product_id", "provider", "property_id", "room_type_id", "rate_plan_id", "import_stage", "import_property", "enabled", "created_at", "updated_at") SELECT "organization_id", "product_id", "provider", "property_id", "room_type_id", "rate_plan_id",
  CASE WHEN import_stage IN ('property', 'room', 'rate', 'inventory', 'verify_inventory') THEN import_stage ELSE 'complete' END,
  "import_property", "enabled", "created_at", "updated_at" FROM `product_channel_mappings`;--> statement-breakpoint
DROP TABLE `product_channel_mappings`;--> statement-breakpoint
ALTER TABLE `__new_product_channel_mappings` RENAME TO `product_channel_mappings`;--> statement-breakpoint
CREATE UNIQUE INDEX `product_channel_mappings_property_unique` ON `product_channel_mappings` (`provider`,`property_id`) WHERE property_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_channel_mappings_room_type_unique` ON `product_channel_mappings` (`provider`,`room_type_id`) WHERE room_type_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_channel_mappings_rate_plan_unique` ON `product_channel_mappings` (`provider`,`rate_plan_id`) WHERE rate_plan_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `product_channel_mappings_org_idx` ON `product_channel_mappings` (`organization_id`);--> statement-breakpoint
CREATE TABLE `channel_night_pushes` (
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
);--> statement-breakpoint
INSERT INTO `channel_night_pushes` (rowid, `organization_id`, `product_id`, `provider`, `date`, `state`, `detail`, `sent_json`, `updated_at`) SELECT rowid, `organization_id`, `product_id`, `provider`, `date`, `state`, `detail`, `sent_json`, `updated_at` FROM `__saved_channel_night_pushes`;--> statement-breakpoint
CREATE INDEX `channel_night_pushes_state_idx` ON `channel_night_pushes` (`organization_id`,`state`);--> statement-breakpoint
DROP TABLE `__saved_channel_night_pushes`;--> statement-breakpoint
CREATE TABLE `channel_threads` (
	`provider` text NOT NULL,
	`external_thread_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`external_booking_id` text,
	`provider_updated_at` text NOT NULL,
	`moved_from_thread_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`provider`, `external_thread_id`),
	FOREIGN KEY (`organization_id`,`conversation_id`) REFERENCES `conversations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`,`provider`) REFERENCES `product_channel_mappings`(`product_id`,`provider`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "channel_threads_provider_check" CHECK(provider = 'channex'),
	CONSTRAINT "channel_threads_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);--> statement-breakpoint
INSERT INTO `channel_threads` (rowid, `provider`, `external_thread_id`, `organization_id`, `product_id`, `conversation_id`, `external_booking_id`, `provider_updated_at`, `moved_from_thread_id`, `created_at`, `updated_at`) SELECT rowid, `provider`, `external_thread_id`, `organization_id`, `product_id`, `conversation_id`, `external_booking_id`, `provider_updated_at`, `moved_from_thread_id`, `created_at`, `updated_at` FROM `__saved_channel_threads`;--> statement-breakpoint
CREATE UNIQUE INDEX `channel_threads_conversation_unique` ON `channel_threads` (`conversation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_threads_booking_unique` ON `channel_threads` (`provider`,`external_booking_id`) WHERE external_booking_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `channel_threads_org_idx` ON `channel_threads` (`organization_id`);--> statement-breakpoint
DROP TABLE `__saved_channel_threads`;

--> statement-breakpoint
-- Existing sync jobs never accepted an explicit destination. Their mapped home remains on the listing.
UPDATE airbnb_sync_jobs SET product_id = NULL WHERE action = 'sync';
