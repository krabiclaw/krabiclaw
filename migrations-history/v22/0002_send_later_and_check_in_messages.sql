CREATE TABLE `send_later_messages` (
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
	CONSTRAINT "send_later_messages_error_check" CHECK(status NOT IN ('failed', 'needs_review') OR (length(trim(reason)) > 0 AND length(trim(error_code)) > 0 AND length(trim(error_field)) > 0)),
	CONSTRAINT "send_later_messages_sent_check" CHECK(status <> 'sent' OR (entry_id IS NOT NULL AND sent_at IS NOT NULL)),
	CONSTRAINT "send_later_messages_sending_check" CHECK(status <> 'sending' OR started_at IS NOT NULL),
	CONSTRAINT "send_later_messages_text_check" CHECK(length(trim(body)) BETWEEN 1 AND 5000 AND version >= 1),
	CONSTRAINT "send_later_messages_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at AND (started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 days') IS started_at) AND (sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sent_at, '+0 days') IS sent_at))
);
--> statement-breakpoint
CREATE INDEX `send_later_messages_due_idx` ON `send_later_messages` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `send_later_messages_author_idx` ON `send_later_messages` (`organization_id`,`user_id`,`due_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_guest_messages_check_in_stay_unique` ON `scheduled_guest_messages` (`stay_id`) WHERE template_id IS NULL AND template_title = 'Check-in instructions';