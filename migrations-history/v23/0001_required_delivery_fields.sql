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
	CONSTRAINT "device_tokens_kind_check" CHECK(((kind = 'apns' AND length(token) > 0 AND length(token) % 2 = 0 AND token NOT GLOB '*[^0123456789abcdef]*' AND environment IN ('sandbox', 'production') AND p256dh IS NULL AND auth IS NULL) OR (kind = 'web' AND token LIKE 'https://%' AND environment IS NULL AND length(p256dh) > 0 AND length(auth) > 0)) IS TRUE),
	CONSTRAINT "device_tokens_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at),
	CONSTRAINT "device_tokens_updated_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
INSERT INTO `__new_device_tokens`("token", "kind", "user_id", "session_id", "environment", "p256dh", "auth", "created_at", "updated_at") SELECT "token", "kind", "user_id", "session_id", "environment", "p256dh", "auth", "created_at", "updated_at" FROM `device_tokens`;--> statement-breakpoint
DROP TABLE `device_tokens`;--> statement-breakpoint
ALTER TABLE `__new_device_tokens` RENAME TO `device_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `device_tokens_user_idx` ON `device_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `device_tokens_session_idx` ON `device_tokens` (`session_id`);--> statement-breakpoint
CREATE TABLE `__new_send_later_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`request_id` text NOT NULL,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`due_at` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`error_code` text,
	`error_field` text,
	`entry_id` text,
	`version` integer NOT NULL,
	`started_at` text,
	`sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `activity_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`request_id`) REFERENCES `requests`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "send_later_messages_status_check" CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled')),
	CONSTRAINT "send_later_messages_error_check" CHECK((status NOT IN ('failed', 'needs_review') OR (length(trim(reason)) > 0 AND length(trim(error_code)) > 0 AND length(trim(error_field)) > 0)) IS TRUE),
	CONSTRAINT "send_later_messages_sent_check" CHECK(status <> 'sent' OR (entry_id IS NOT NULL AND sent_at IS NOT NULL)),
	CONSTRAINT "send_later_messages_sending_check" CHECK(status <> 'sending' OR started_at IS NOT NULL),
	CONSTRAINT "send_later_messages_text_check" CHECK(length(trim(body)) BETWEEN 1 AND 5000 AND version >= 1),
	CONSTRAINT "send_later_messages_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at AND (started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 days') IS started_at) AND (sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sent_at, '+0 days') IS sent_at))
);
--> statement-breakpoint
INSERT INTO `__new_send_later_messages`("id", "organization_id", "request_id", "user_id", "body", "due_at", "status", "reason", "error_code", "error_field", "entry_id", "version", "started_at", "sent_at", "created_at", "updated_at") SELECT "id", "organization_id", "request_id", "user_id", "body", "due_at", "status", "reason", "error_code", "error_field", "entry_id", "version", "started_at", "sent_at", "created_at", "updated_at" FROM `send_later_messages`;--> statement-breakpoint
DROP TABLE `send_later_messages`;--> statement-breakpoint
ALTER TABLE `__new_send_later_messages` RENAME TO `send_later_messages`;--> statement-breakpoint
CREATE INDEX `send_later_messages_due_idx` ON `send_later_messages` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `send_later_messages_author_idx` ON `send_later_messages` (`organization_id`,`user_id`,`due_at`);