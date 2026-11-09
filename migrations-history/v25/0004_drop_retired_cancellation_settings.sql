PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_location_reservation_configs` (
	`duration_minutes` integer,
	`location_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`slot_capacity` integer,
	`advance_notice_minutes` integer,
	`minimum_guest_age` integer,
	`deposit_required` integer DEFAULT 0 NOT NULL,
	`deposit_amount` integer,
	`deposit_currency` text,
	`deposit_tax_behavior` text,
	`deposit_trigger_party_size` integer,
	`accessibility_contact_required` integer DEFAULT 0 NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "location_reservation_configs_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "location_reservation_configs_booleans_check" CHECK(deposit_required IN (0, 1) AND accessibility_contact_required IN (0, 1)),
	CONSTRAINT "location_reservation_configs_duration_check" CHECK(duration_minutes IS NULL OR duration_minutes > 0),
	CONSTRAINT "location_reservation_configs_slot_capacity_check" CHECK(slot_capacity IS NULL OR slot_capacity >= 0),
	CONSTRAINT "location_reservation_configs_minutes_check" CHECK(advance_notice_minutes IS NULL OR advance_notice_minutes >= 0),
	CONSTRAINT "location_reservation_configs_party_check" CHECK(deposit_trigger_party_size IS NULL OR deposit_trigger_party_size > 0),
	CONSTRAINT "location_reservation_configs_deposit_check" CHECK((deposit_amount IS NULL OR deposit_amount > 0) AND (deposit_currency IS NULL OR (length(deposit_currency) = 3 AND deposit_currency = upper(deposit_currency))) AND (deposit_tax_behavior IS NULL OR deposit_tax_behavior IN ('inclusive', 'exclusive'))),
	CONSTRAINT "location_reservation_configs_age_check" CHECK(minimum_guest_age IS NULL OR minimum_guest_age >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_location_reservation_configs`("duration_minutes", "location_id", "organization_id", "slot_capacity", "advance_notice_minutes", "minimum_guest_age", "deposit_required", "deposit_amount", "deposit_currency", "deposit_tax_behavior", "deposit_trigger_party_size", "accessibility_contact_required", "questions", "created_at", "updated_at", "created_by", "updated_by") SELECT "duration_minutes", "location_id", "organization_id", "slot_capacity", "advance_notice_minutes", "minimum_guest_age", "deposit_required", "deposit_amount", "deposit_currency", "deposit_tax_behavior", "deposit_trigger_party_size", "accessibility_contact_required", "questions", "created_at", "updated_at", "created_by", "updated_by" FROM `location_reservation_configs`;--> statement-breakpoint
DROP TABLE `location_reservation_configs`;--> statement-breakpoint
ALTER TABLE `__new_location_reservation_configs` RENAME TO `location_reservation_configs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `location_reservation_configs_org_location_unique` ON `location_reservation_configs` (`organization_id`,`location_id`);--> statement-breakpoint
CREATE TABLE `__new_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`location_id` text NOT NULL,
	`user_id` text,
	`request_id` text,
	`timezone` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`party_size` integer NOT NULL,
	`policy_json` text,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`cancelled_at` text,
	`cancellation_reason` text,
	`no_show_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`request_id`) REFERENCES `requests`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reservations_status_check" CHECK(status IN ('confirmed', 'cancelled')),
	CONSTRAINT "reservations_policy_check" CHECK(policy_json IS NULL OR (json_valid(policy_json) AND json_type(policy_json) = 'object') IS 1),
	CONSTRAINT "reservations_instants_check" CHECK((strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+0 days') IS starts_at) AND (strftime('%Y-%m-%dT%H:%M:%fZ', ends_at, '+0 days') IS ends_at) AND (cancelled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at, '+0 days') IS cancelled_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "reservations_interval_check" CHECK(ends_at > starts_at),
	CONSTRAINT "reservations_party_size_check" CHECK(party_size > 0),
	CONSTRAINT "reservations_timezone_check" CHECK(timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*')
);
--> statement-breakpoint
INSERT INTO `__new_reservations`("id", "organization_id", "location_id", "user_id", "request_id", "timezone", "starts_at", "ends_at", "party_size", "policy_json", "status", "cancelled_at", "cancellation_reason", "no_show_at", "created_at", "updated_at") SELECT "id", "organization_id", "location_id", "user_id", "request_id", "timezone", "starts_at", "ends_at", "party_size", "policy_json", "status", "cancelled_at", "cancellation_reason", "no_show_at", "created_at", "updated_at" FROM `reservations`;--> statement-breakpoint
DROP TABLE `reservations`;--> statement-breakpoint
ALTER TABLE `__new_reservations` RENAME TO `reservations`;--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_request_unique` ON `reservations` (`request_id`) WHERE request_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `reservations_location_start_idx` ON `reservations` (`location_id`,`starts_at`,`status`);--> statement-breakpoint
CREATE INDEX `reservations_org_created_idx` ON `reservations` (`created_at`);--> statement-breakpoint
CREATE INDEX `reservations_org_user_idx` ON `reservations` (`organization_id`,`user_id`);