-- Preserve provider delivery receipts and conversation links while D1 rebuilds their parent.
CREATE TABLE `__saved_channel_night_pushes` AS SELECT rowid, `organization_id`, `product_id`, `provider`, `date`, `state`, `detail`, `sent_json`, `updated_at` FROM `channel_night_pushes`;--> statement-breakpoint
DROP TABLE `channel_night_pushes`;--> statement-breakpoint
CREATE TABLE `__saved_channel_threads` AS SELECT rowid, `provider`, `external_thread_id`, `organization_id`, `product_id`, `conversation_id`, `external_booking_id`, `provider_updated_at`, `moved_from_thread_id`, `created_at`, `updated_at` FROM `channel_threads`;--> statement-breakpoint
DROP TABLE `channel_threads`;--> statement-breakpoint
CREATE TABLE `__new_product_channel_mappings` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`provider` text NOT NULL,
	`listing_id` text,
	`channel_id` text,
	`property_id` text,
	`room_type_id` text,
	`rate_plan_id` text,
	`import_stage` text NOT NULL,
	`import_property` text,
	`import_calendar` text,
	`import_content` text,
	`import_written` text,
	`enabled` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`product_id`, `provider`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_channel_mappings_provider_check" CHECK(provider = 'channex'),
	CONSTRAINT "product_channel_mappings_stage_check" CHECK(import_stage IN ('property', 'room', 'rate', 'inventory', 'verify_inventory', 'content', 'draft', 'mapping', 'activate', 'reservations', 'messages', 'complete')),
	CONSTRAINT "product_channel_mappings_airbnb_ids_check" CHECK((listing_id IS NULL) = (channel_id IS NULL) AND (listing_id IS NOT NULL OR import_stage IN ('property', 'room', 'rate', 'inventory', 'verify_inventory', 'complete'))),
	CONSTRAINT "product_channel_mappings_ids_check" CHECK((import_stage = 'property' OR property_id IS NOT NULL) AND (import_stage IN ('property', 'room') OR room_type_id IS NOT NULL) AND (import_stage IN ('property', 'room', 'rate') OR rate_plan_id IS NOT NULL)),
	CONSTRAINT "product_channel_mappings_calendar_check" CHECK(import_calendar IS NULL OR (json_valid(import_calendar) AND json_type(import_calendar) = 'array')),
	CONSTRAINT "product_channel_mappings_property_json_check" CHECK(import_property IS NULL OR (json_valid(import_property) AND json_type(import_property) = 'object')),
	CONSTRAINT "product_channel_mappings_content_json_check" CHECK(import_content IS NULL OR (json_valid(import_content) AND json_type(import_content) = 'object')),
	CONSTRAINT "product_channel_mappings_enabled_check" CHECK(enabled IN (0, 1) AND (enabled = 0 OR import_stage IN ('draft', 'mapping', 'activate', 'reservations', 'messages', 'complete'))),
	CONSTRAINT "product_channel_mappings_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
INSERT INTO `__new_product_channel_mappings`("organization_id", "product_id", "provider", "listing_id", "channel_id", "property_id", "room_type_id", "rate_plan_id", "import_stage", "import_property", "import_calendar", "import_content", "import_written", "enabled", "created_at", "updated_at") SELECT "organization_id", "product_id", "provider", "listing_id", "channel_id", "property_id", "room_type_id", "rate_plan_id", "import_stage", "import_property", "import_calendar", "import_content", "import_written", "enabled", "created_at", "updated_at" FROM `product_channel_mappings`;--> statement-breakpoint
DROP TABLE `product_channel_mappings`;--> statement-breakpoint
ALTER TABLE `__new_product_channel_mappings` RENAME TO `product_channel_mappings`;--> statement-breakpoint
CREATE UNIQUE INDEX `product_channel_mappings_listing_unique` ON `product_channel_mappings` (`provider`,`listing_id`);--> statement-breakpoint
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
