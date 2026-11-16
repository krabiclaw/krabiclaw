-- A job's reminders and a task's start alert are rows of the one outbox, by task_id (the rows before this have none).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_scheduled_guest_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text,
	`booking_id` text,
	`conversation_id` text,
	`task_id` text,
	`author_user_id` text,
	`template_id` text,
	`template_title` text,
	`template_version` integer,
	`body` text NOT NULL,
	`due_at` text,
	`timezone` text,
	`status` text NOT NULL,
	`reason` text,
	`error_code` text,
	`error_field` text,
	`message_id` text,
	`started_at` text,
	`sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`conversation_id`) REFERENCES `conversations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`template_id`) REFERENCES `message_templates`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scheduled_guest_messages_kind_check" CHECK((task_id IS NULL AND author_user_id IS NULL AND conversation_id IS NULL AND product_id IS NOT NULL AND booking_id IS NOT NULL AND template_title IS NOT NULL AND template_version IS NOT NULL AND timezone IS NOT NULL) OR (task_id IS NULL AND author_user_id IS NOT NULL AND conversation_id IS NOT NULL AND due_at IS NOT NULL AND status <> 'skipped' AND product_id IS NULL AND booking_id IS NULL AND template_id IS NULL AND template_title IS NULL AND template_version IS NULL AND timezone IS NULL) OR (task_id IS NOT NULL AND author_user_id IS NULL AND due_at IS NOT NULL AND status <> 'skipped' AND product_id IS NULL AND booking_id IS NULL AND template_id IS NULL AND template_title IS NULL AND template_version IS NULL AND timezone IS NOT NULL)),
	CONSTRAINT "scheduled_guest_messages_status_check" CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled', 'skipped')),
	CONSTRAINT "scheduled_guest_messages_due_check" CHECK(due_at IS NOT NULL OR status IN ('failed', 'skipped')),
	CONSTRAINT "scheduled_guest_messages_error_check" CHECK((status NOT IN ('failed', 'needs_review') OR (length(trim(reason)) > 0 AND length(trim(error_code)) > 0 AND length(trim(error_field)) > 0)) IS TRUE),
	CONSTRAINT "scheduled_guest_messages_sent_check" CHECK(status <> 'sent' OR (sent_at IS NOT NULL AND (message_id IS NOT NULL OR (task_id IS NOT NULL AND conversation_id IS NULL)))),
	CONSTRAINT "scheduled_guest_messages_sending_check" CHECK(status <> 'sending' OR started_at IS NOT NULL),
	CONSTRAINT "scheduled_guest_messages_text_check" CHECK(length(trim(body)) BETWEEN 1 AND 5000 AND (template_title IS NULL OR length(trim(template_title)) BETWEEN 1 AND 100) AND (template_version IS NULL OR template_version >= 1)),
	CONSTRAINT "scheduled_guest_messages_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at) AND (started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 days') IS started_at) AND (sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sent_at, '+0 days') IS sent_at))
);
--> statement-breakpoint
INSERT INTO `__new_scheduled_guest_messages`("id", "organization_id", "product_id", "booking_id", "conversation_id", "task_id", "author_user_id", "template_id", "template_title", "template_version", "body", "due_at", "timezone", "status", "reason", "error_code", "error_field", "message_id", "started_at", "sent_at", "created_at", "updated_at") SELECT "id", "organization_id", "product_id", "booking_id", "conversation_id", NULL, "author_user_id", "template_id", "template_title", "template_version", "body", "due_at", "timezone", "status", "reason", "error_code", "error_field", "message_id", "started_at", "sent_at", "created_at", "updated_at" FROM `scheduled_guest_messages`;--> statement-breakpoint
DROP TABLE `scheduled_guest_messages`;--> statement-breakpoint
ALTER TABLE `__new_scheduled_guest_messages` RENAME TO `scheduled_guest_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_guest_messages_template_booking_unique` ON `scheduled_guest_messages` (`template_id`,`booking_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_guest_messages_check_in_unique` ON `scheduled_guest_messages` (`booking_id`) WHERE template_id IS NULL AND template_title = 'Check-in instructions';--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_booking_idx` ON `scheduled_guest_messages` (`booking_id`);--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_conversation_idx` ON `scheduled_guest_messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_author_idx` ON `scheduled_guest_messages` (`author_user_id`);--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_due_idx` ON `scheduled_guest_messages` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_org_created_idx` ON `scheduled_guest_messages` (`organization_id`,`created_at`,`id`);