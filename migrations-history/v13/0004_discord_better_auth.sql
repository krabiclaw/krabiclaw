-- Discord connects through Better Auth's Discord provider (#1304), like
-- Facebook and Instagram: a linked account plus the channel the owner chose.
-- This removes 0003's webhook columns (webhook_id, guild_id, credential),
-- makes account_id required again, and restores post_publications' required
-- provider_app_id and its uniqueness on it; discord stays an allowed provider
-- and channel. Neither table is referenced, so the rebuilds cascade nothing.
-- Staging and production held no Discord or NULL-account rows when generated.
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
	CONSTRAINT "organization_integrations_provider_check" CHECK(provider IN ('facebook', 'instagram', 'discord', 'google_analytics', 'google_search_console', 'google_calendar')),
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
CREATE UNIQUE INDEX `organization_integrations_target_unique` ON `organization_integrations` (`provider`,`target_id`);--> statement-breakpoint
CREATE TABLE `__new_post_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`post_id` text,
	`post_row_role` text DEFAULT 'root' NOT NULL,
	`post_kind` text DEFAULT 'social_post' NOT NULL,
	`channel` text NOT NULL,
	`provider_app_id` text NOT NULL,
	`provider_subject_id` text NOT NULL,
	`provider_target_id` text NOT NULL,
	`state` text NOT NULL,
	`provider_post_id` text,
	`provider_permalink` text,
	`provider_handles_json` text DEFAULT '{}' NOT NULL,
	`payload_hash` text NOT NULL,
	`attempt_id` text,
	`error_code` text,
	`error_message` text,
	`published_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`post_id`,`post_row_role`,`post_kind`) REFERENCES `content_documents`(`organization_id`,`id`,`row_role`,`kind`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "post_publications_instants_check" CHECK((published_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 days') IS published_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "post_publications_constants_check" CHECK(post_row_role = 'root' AND post_kind = 'social_post'),
	CONSTRAINT "post_publications_channel_check" CHECK(channel IN ('facebook', 'instagram', 'discord')),
	CONSTRAINT "post_publications_state_check" CHECK(state IN ('preparing', 'publishing', 'published', 'failed', 'unknown', 'removed')),
	CONSTRAINT "post_publications_identity_check" CHECK(length(trim(provider_app_id)) > 0 AND length(trim(provider_subject_id)) > 0 AND length(trim(provider_target_id)) > 0 AND (provider_post_id IS NULL OR length(trim(provider_post_id)) > 0)),
	CONSTRAINT "post_publications_handles_check" CHECK(json_valid(provider_handles_json) AND json_type(provider_handles_json) IS 'object'),
	CONSTRAINT "post_publications_permalink_check" CHECK(provider_permalink IS NULL OR provider_permalink LIKE 'https://%'),
	CONSTRAINT "post_publications_published_check" CHECK(state NOT IN ('published', 'removed') OR (published_at IS NOT NULL AND (provider_post_id IS NOT NULL OR (channel = 'instagram' AND json_type(provider_handles_json, '$.container_id') IS 'text')))),
	CONSTRAINT "post_publications_failed_check" CHECK((state IN ('failed', 'unknown')) = (error_code IS NOT NULL)),
	CONSTRAINT "post_publications_attempt_check" CHECK(attempt_id IS NULL OR state IN ('preparing', 'publishing'))
);
--> statement-breakpoint
INSERT INTO `__new_post_publications`("id", "organization_id", "post_id", "post_row_role", "post_kind", "channel", "provider_app_id", "provider_subject_id", "provider_target_id", "state", "provider_post_id", "provider_permalink", "provider_handles_json", "payload_hash", "attempt_id", "error_code", "error_message", "published_at", "created_at", "updated_at") SELECT "id", "organization_id", "post_id", "post_row_role", "post_kind", "channel", "provider_app_id", "provider_subject_id", "provider_target_id", "state", "provider_post_id", "provider_permalink", "provider_handles_json", "payload_hash", "attempt_id", "error_code", "error_message", "published_at", "created_at", "updated_at" FROM `post_publications`;--> statement-breakpoint
DROP TABLE `post_publications`;--> statement-breakpoint
ALTER TABLE `__new_post_publications` RENAME TO `post_publications`;--> statement-breakpoint
CREATE UNIQUE INDEX `post_publications_post_channel_unique` ON `post_publications` (`organization_id`,`post_id`,`channel`) WHERE post_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `post_publications_provider_post_unique` ON `post_publications` (`organization_id`,`channel`,`provider_app_id`,`provider_post_id`) WHERE provider_post_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `post_publications_subject_idx` ON `post_publications` (`channel`,`provider_app_id`,`provider_subject_id`);--> statement-breakpoint
CREATE INDEX `post_publications_target_state_idx` ON `post_publications` (`organization_id`,`channel`,`provider_target_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `post_publications_org_id_unique` ON `post_publications` (`organization_id`,`id`);