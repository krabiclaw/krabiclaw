CREATE TABLE `product_channel_mappings` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`provider` text NOT NULL,
	`listing_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`property_id` text,
	`room_type_id` text,
	`rate_plan_id` text,
	`import_stage` text NOT NULL,
	`import_property` text,
	`import_calendar` text,
	`enabled` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`product_id`, `provider`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_channel_mappings_provider_check" CHECK(provider = 'channex'),
	CONSTRAINT "product_channel_mappings_stage_check" CHECK(import_stage IN ('property', 'room', 'rate', 'inventory', 'verify_inventory', 'mapping', 'activate', 'reservations', 'complete')),
	CONSTRAINT "product_channel_mappings_ids_check" CHECK((import_stage = 'property' OR property_id IS NOT NULL) AND (import_stage IN ('property', 'room') OR room_type_id IS NOT NULL) AND (import_stage IN ('property', 'room', 'rate') OR rate_plan_id IS NOT NULL)),
	CONSTRAINT "product_channel_mappings_calendar_check" CHECK(import_calendar IS NULL OR (json_valid(import_calendar) AND json_type(import_calendar) = 'array')),
	CONSTRAINT "product_channel_mappings_property_json_check" CHECK(import_property IS NULL OR (json_valid(import_property) AND json_type(import_property) = 'object')),
	CONSTRAINT "product_channel_mappings_enabled_check" CHECK(enabled IN (0, 1) AND (enabled = 0 OR import_stage IN ('reservations', 'complete'))),
	CONSTRAINT "product_channel_mappings_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_channel_mappings_listing_unique` ON `product_channel_mappings` (`provider`,`listing_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_channel_mappings_property_unique` ON `product_channel_mappings` (`provider`,`property_id`) WHERE property_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_channel_mappings_room_type_unique` ON `product_channel_mappings` (`provider`,`room_type_id`) WHERE room_type_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_channel_mappings_rate_plan_unique` ON `product_channel_mappings` (`provider`,`rate_plan_id`) WHERE rate_plan_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `product_channel_mappings_org_idx` ON `product_channel_mappings` (`organization_id`);