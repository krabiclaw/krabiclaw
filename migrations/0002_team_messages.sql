CREATE TABLE `team_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`sender_user_id` text,
	`body` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`sender_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`thread_id`) REFERENCES `team_threads`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "team_messages_body_check" CHECK(length(body) <= 5000 AND body = trim(body)),
	CONSTRAINT "team_messages_idempotency_check" CHECK(length(idempotency_key) BETWEEN 1 AND 200),
	CONSTRAINT "team_messages_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_messages_thread_idempotency_unique` ON `team_messages` (`thread_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `team_messages_thread_created_idx` ON `team_messages` (`thread_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_messages_org_id_unique` ON `team_messages` (`organization_id`,`id`);--> statement-breakpoint
CREATE TABLE `team_thread_members` (
	`thread_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`member_id` text NOT NULL,
	`last_read_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`thread_id`, `member_id`),
	FOREIGN KEY (`organization_id`,`thread_id`) REFERENCES `team_threads`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`,`organization_id`) REFERENCES `member`(`id`,`organizationId`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "team_thread_members_instants_check" CHECK((last_read_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_read_at, '+0 days') IS last_read_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);
--> statement-breakpoint
CREATE INDEX `team_thread_members_member_idx` ON `team_thread_members` (`member_id`);--> statement-breakpoint
CREATE TABLE `team_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`stay_id` text,
	`created_by_user_id` text,
	`last_message_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`stay_id`) REFERENCES `stays`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "team_threads_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', last_message_at, '+0 days') IS last_message_at AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);
--> statement-breakpoint
CREATE INDEX `team_threads_org_activity_idx` ON `team_threads` (`organization_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `team_threads_org_stay_idx` ON `team_threads` (`organization_id`,`stay_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_threads_org_id_unique` ON `team_threads` (`organization_id`,`id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_broadcasts` (
	`id` text PRIMARY KEY NOT NULL,
	`content_document_id` text NOT NULL,
	`category` text NOT NULL,
	`provider_broadcast_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`content_document_id`) REFERENCES `content_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "broadcasts_category_check" CHECK(category IN ('account_security', 'reservations_bookings', 'guest_messages', 'team_messages', 'reviews', 'review_requests', 'organization_and_billing', 'product_news')),
	CONSTRAINT "broadcasts_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);
--> statement-breakpoint
INSERT INTO `__new_broadcasts`("id", "content_document_id", "category", "provider_broadcast_id", "created_at") SELECT "id", "content_document_id", "category", "provider_broadcast_id", "created_at" FROM `broadcasts`;--> statement-breakpoint
DROP TABLE `broadcasts`;--> statement-breakpoint
ALTER TABLE `__new_broadcasts` RENAME TO `broadcasts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `broadcasts_content_document_id_unique` ON `broadcasts` (`content_document_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `broadcasts_provider_broadcast_id_unique` ON `broadcasts` (`provider_broadcast_id`) WHERE provider_broadcast_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_media_placements` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`slot` text NOT NULL,
	`asset_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`presentation_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`asset_id`) REFERENCES `media_assets`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_placements_presentation_check" CHECK(presentation_json IS NULL OR (json_valid(presentation_json) AND json_extract(presentation_json, '$.shape') IN ('original', 'square', 'circle') AND json_type(presentation_json, '$.focus.x') IN ('integer', 'real') AND json_type(presentation_json, '$.focus.y') IN ('integer', 'real')) IS TRUE),
	CONSTRAINT "media_placements_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "media_placements_owner_type_check" CHECK(owner_type IN ('organization', 'business_location', 'product', 'content_document', 'content_block', 'review', 'review_request', 'activity_entry', 'team_message')),
	CONSTRAINT "media_placements_sort_order_check" CHECK(sort_order >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_media_placements`("id", "organization_id", "owner_type", "owner_id", "slot", "asset_id", "sort_order", "status", "presentation_json", "created_at", "updated_at") SELECT "id", "organization_id", "owner_type", "owner_id", "slot", "asset_id", "sort_order", "status", "presentation_json", "created_at", "updated_at" FROM `media_placements`;--> statement-breakpoint
DROP TABLE `media_placements`;--> statement-breakpoint
ALTER TABLE `__new_media_placements` RENAME TO `media_placements`;--> statement-breakpoint
CREATE INDEX `media_placements_asset_idx` ON `media_placements` (`organization_id`,`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_placements_org_owner_slot_asset_unique` ON `media_placements` (`owner_type`,`owner_id`,`slot`,`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_placements_org_owner_slot_order_unique` ON `media_placements` (`owner_type`,`owner_id`,`slot`,`sort_order`);--> statement-breakpoint
CREATE TABLE `__new_user_notification_preferences` (
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`email_enabled` integer NOT NULL,
	`whatsapp_enabled` integer NOT NULL,
	`push_enabled` integer NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `category`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_notification_preferences_category_check" CHECK(category IN ('account_security', 'reservations_bookings', 'guest_messages', 'team_messages', 'reviews', 'review_requests', 'organization_and_billing', 'product_news')),
	CONSTRAINT "user_notification_preferences_updated_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at),
	CONSTRAINT "user_notification_preferences_account_security_check" CHECK(category != 'account_security' OR email_enabled = 1),
	CONSTRAINT "user_notification_preferences_push_only_check" CHECK(category NOT IN ('team_messages') OR (email_enabled = 0 AND whatsapp_enabled = 0))
);
--> statement-breakpoint
INSERT INTO `__new_user_notification_preferences`("user_id", "category", "email_enabled", "whatsapp_enabled", "push_enabled", "updated_at") SELECT "user_id", "category", "email_enabled", "whatsapp_enabled", "push_enabled", "updated_at" FROM `user_notification_preferences`;--> statement-breakpoint
DROP TABLE `user_notification_preferences`;--> statement-breakpoint
ALTER TABLE `__new_user_notification_preferences` RENAME TO `user_notification_preferences`;