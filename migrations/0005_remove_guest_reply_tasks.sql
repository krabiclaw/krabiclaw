-- Tasks about replies are retired. Keep every delivery attached to work that remains.
DELETE FROM `media_placements` WHERE owner_type = 'task'
  AND EXISTS (SELECT 1 FROM `tasks` t WHERE t.organization_id = media_placements.organization_id AND t.id = media_placements.owner_id AND t.kind = 'guest_reply');
--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`product_id` text,
	`location_id` text,
	`opportunity_id` text,
	`title` text,
	`notes` text,
	`assigned_member_id` text,
	`starts_at` text,
	`due_at` text,
	`timezone` text NOT NULL,
	`status` text NOT NULL,
	`outcome_note` text,
	`closed_at` text,
	`closed_by_user_id` text,
	`dedupe_key` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`closed_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`opportunity_id`) REFERENCES `opportunities`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_kind_check" CHECK(kind IN ('turnover', 'message_delivery', 'booking_review', 'booking_change', 'opportunity', 'custom', 'stay_ready', 'consultation_prep', 'consultation_follow_up')
    AND (subject_type IS NULL) = (subject_id IS NULL)
    AND (subject_type IS NULL OR subject_type IN ('conversation', 'scheduled_guest_message', 'booking', 'product_session', 'article', 'post', 'product'))
    AND (kind <> 'custom' OR subject_type IS NULL)
    AND ((kind = 'opportunity') = (opportunity_id IS NOT NULL))),
	CONSTRAINT "tasks_text_check" CHECK((title IS NULL OR length(trim(title)) BETWEEN 1 AND 200) AND (kind NOT IN ('custom', 'opportunity') OR title IS NOT NULL)
    AND (notes IS NULL OR length(trim(notes)) BETWEEN 1 AND 5000) AND (outcome_note IS NULL OR length(trim(outcome_note)) BETWEEN 1 AND 5000)
    AND length(trim(dedupe_key)) > 0 AND timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'),
	CONSTRAINT "tasks_window_check" CHECK(starts_at IS NULL OR due_at IS NULL OR starts_at <= due_at),
	CONSTRAINT "tasks_status_check" CHECK(status IN ('open', 'done', 'skipped', 'cancelled') AND (status = 'open') = (closed_at IS NULL) AND (status <> 'open' OR closed_by_user_id IS NULL) AND version >= 1),
	CONSTRAINT "tasks_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (starts_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+0 days') IS starts_at) AND (due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at) AND (closed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', closed_at, '+0 days') IS closed_at))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "organization_id", "kind", "subject_type", "subject_id", "product_id", "location_id", "opportunity_id", "title", "notes", "assigned_member_id", "starts_at", "due_at", "timezone", "status", "outcome_note", "closed_at", "closed_by_user_id", "dedupe_key", "version", "created_by_user_id", "created_at", "updated_at") SELECT "id", "organization_id", "kind", "subject_type", "subject_id", "product_id", "location_id", "opportunity_id", "title", "notes", "assigned_member_id", "starts_at", "due_at", "timezone", "status", "outcome_note", "closed_at", "closed_by_user_id", "dedupe_key", "version", "created_by_user_id", "created_at", "updated_at" FROM `tasks` WHERE kind <> 'guest_reply';--> statement-breakpoint
CREATE TABLE `__saved_guest_thread_deliveries` AS
SELECT d.* FROM `guest_thread_deliveries` d
WHERE NOT EXISTS (SELECT 1 FROM `tasks` t WHERE t.id = d.task_id AND t.kind = 'guest_reply');--> statement-breakpoint
DROP TABLE `guest_thread_deliveries`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE TABLE `guest_thread_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`activity_entry_id` text,
	`task_id` text,
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
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`activity_entry_id`) REFERENCES `activity_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "guest_thread_deliveries_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "guest_thread_deliveries_subject_check" CHECK((message_id IS NOT NULL) + (activity_entry_id IS NOT NULL) + (task_id IS NOT NULL) = 1),
	CONSTRAINT "guest_thread_deliveries_provider_check" CHECK((channel = 'email' AND provider IN ('resend', 'log_only')) OR (channel = 'whatsapp' AND provider IN ('meta', 'log_only')) OR (channel = 'airbnb' AND provider = 'channex') OR (channel = 'push' AND provider IN ('apns', 'web_push')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_thread_deliveries_provider_message_unique` ON `guest_thread_deliveries` (`provider`,`provider_message_id`) WHERE provider_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `guest_thread_deliveries_message_status_idx` ON `guest_thread_deliveries` (`message_id`,`status`);--> statement-breakpoint
CREATE INDEX `guest_thread_deliveries_activity_idx` ON `guest_thread_deliveries` (`activity_entry_id`);--> statement-breakpoint
CREATE INDEX `guest_thread_deliveries_task_idx` ON `guest_thread_deliveries` (`task_id`);--> statement-breakpoint
INSERT INTO `guest_thread_deliveries` SELECT * FROM `__saved_guest_thread_deliveries`;--> statement-breakpoint
DROP TABLE `__saved_guest_thread_deliveries`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_dedupe_key_unique` ON `tasks` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_opportunity_unique` ON `tasks` (`opportunity_id`) WHERE opportunity_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `tasks_status_due_idx` ON `tasks` (`organization_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_member_status_due_idx` ON `tasks` (`organization_id`,`assigned_member_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_subject_idx` ON `tasks` (`subject_type`,`subject_id`);