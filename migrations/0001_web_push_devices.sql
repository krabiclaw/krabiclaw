PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_device_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`environment` text,
	`p256dh` text,
	`auth` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "device_tokens_kind_check" CHECK((kind = 'apns' AND length(token) > 0 AND length(token) % 2 = 0 AND token NOT GLOB '*[^0123456789abcdef]*' AND environment IN ('sandbox', 'production') AND p256dh IS NULL AND auth IS NULL) OR (kind = 'web' AND token LIKE 'https://%' AND environment IS NULL AND length(p256dh) > 0 AND length(auth) > 0)),
	CONSTRAINT "device_tokens_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at),
	CONSTRAINT "device_tokens_updated_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
INSERT INTO `__new_device_tokens`("token", "kind", "user_id", "session_id", "environment", "p256dh", "auth", "created_at", "updated_at") SELECT "token", 'apns', "user_id", "session_id", "environment", NULL, NULL, "created_at", "updated_at" FROM `device_tokens`;--> statement-breakpoint
DROP TABLE `device_tokens`;--> statement-breakpoint
ALTER TABLE `__new_device_tokens` RENAME TO `device_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `device_tokens_user_idx` ON `device_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `device_tokens_session_idx` ON `device_tokens` (`session_id`);--> statement-breakpoint
CREATE TABLE `__new_guest_thread_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_message_id` text,
	`email_json` text,
	`email_message_id` text,
	`error` text,
	`non_delivery_confirmed` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `activity_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "guest_thread_deliveries_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "guest_thread_deliveries_provider_check" CHECK((channel = 'email' AND provider IN ('resend', 'log_only')) OR (channel = 'whatsapp' AND provider IN ('meta', 'log_only')) OR (channel = 'airbnb' AND provider = 'channex') OR (channel = 'push' AND provider IN ('apns', 'web_push')))
);
--> statement-breakpoint
INSERT INTO `__new_guest_thread_deliveries`("id", "entry_id", "channel", "provider", "purpose", "status", "provider_message_id", "email_json", "email_message_id", "error", "non_delivery_confirmed", "created_at", "updated_at") SELECT "id", "entry_id", "channel", "provider", "purpose", "status", "provider_message_id", "email_json", "email_message_id", "error", "non_delivery_confirmed", "created_at", "updated_at" FROM `guest_thread_deliveries`;--> statement-breakpoint
DROP TABLE `guest_thread_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_guest_thread_deliveries` RENAME TO `guest_thread_deliveries`;--> statement-breakpoint
CREATE UNIQUE INDEX `guest_thread_deliveries_provider_message_unique` ON `guest_thread_deliveries` (`provider`,`provider_message_id`) WHERE provider_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `guest_thread_deliveries_entry_status_idx` ON `guest_thread_deliveries` (`entry_id`,`status`);