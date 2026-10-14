PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_organization_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`target_id` text NOT NULL,
	`target_name` text NOT NULL,
	`measurement_id` text,
	`verified` integer,
	`verification_token` text,
	`status` text,
	`last_error` text,
	`revision` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organization_integrations_provider_check" CHECK(provider IN ('facebook', 'instagram', 'discord', 'google_analytics', 'google_ads', 'google_search_console', 'google_calendar')),
	CONSTRAINT "organization_integrations_values_check" CHECK(trim(account_id) <> '' AND trim(target_id) <> '' AND trim(target_name) <> '' AND trim(revision) <> ''),
	CONSTRAINT "organization_integrations_measurement_check" CHECK((provider = 'google_analytics') = (measurement_id IS NOT NULL)),
	CONSTRAINT "organization_integrations_verification_check" CHECK((provider = 'google_search_console') = (verified IS NOT NULL) AND (verification_token IS NULL OR provider = 'google_search_console') AND (verified IS NULL OR verified IN (0, 1))),
	CONSTRAINT "organization_integrations_calendar_check" CHECK((provider = 'google_calendar') = (status IS NOT NULL) AND (status IS NULL OR status IN ('active', 'disabled', 'error')) AND (provider = 'google_calendar' OR (status IS NULL AND last_error IS NULL))),
	CONSTRAINT "organization_integrations_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
INSERT INTO `__new_organization_integrations`("id", "organization_id", "provider", "account_id", "target_id", "target_name", "measurement_id", "verified", "verification_token", "status", "last_error", "revision", "created_at", "updated_at") SELECT "id", "organization_id", "provider", "account_id", "target_id", "target_name", "measurement_id", "verified", "verification_token", "status", "last_error", "revision", "created_at", "updated_at" FROM `organization_integrations`;--> statement-breakpoint
DROP TABLE `organization_integrations`;--> statement-breakpoint
ALTER TABLE `__new_organization_integrations` RENAME TO `organization_integrations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `organization_integrations_account_idx` ON `organization_integrations` (`provider`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_integrations_provider_unique` ON `organization_integrations` (`organization_id`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_integrations_target_unique` ON `organization_integrations` (`provider`,`target_id`);