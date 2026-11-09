PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`assigned_team_id` text,
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
	FOREIGN KEY (`organization_id`,`assigned_team_id`) REFERENCES `team`(`organizationId`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_kind_check" CHECK(kind IN ('turnover', 'guest_reply', 'message_delivery', 'booking_review', 'booking_change', 'opportunity', 'custom')
    AND (subject_type IS NULL) = (subject_id IS NULL)
    AND (subject_type IS NULL OR subject_type IN ('stay', 'request', 'scheduled_guest_message', 'booking', 'reservation', 'article', 'post', 'product'))
    AND (kind <> 'custom' OR subject_type IS NULL)
    AND ((kind = 'opportunity') = (opportunity_id IS NOT NULL))),
	CONSTRAINT "tasks_text_check" CHECK((title IS NULL OR length(trim(title)) BETWEEN 1 AND 200) AND (kind NOT IN ('custom', 'opportunity') OR title IS NOT NULL)
    AND (notes IS NULL OR length(trim(notes)) BETWEEN 1 AND 5000) AND (outcome_note IS NULL OR length(trim(outcome_note)) BETWEEN 1 AND 5000)
    AND length(trim(dedupe_key)) > 0 AND timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'),
	CONSTRAINT "tasks_assignee_check" CHECK(assigned_member_id IS NULL OR assigned_team_id IS NULL),
	CONSTRAINT "tasks_window_check" CHECK(starts_at IS NULL OR due_at IS NULL OR starts_at <= due_at),
	CONSTRAINT "tasks_status_check" CHECK(status IN ('open', 'done', 'skipped', 'cancelled') AND (status = 'open') = (closed_at IS NULL) AND (status <> 'open' OR closed_by_user_id IS NULL) AND version >= 1),
	CONSTRAINT "tasks_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (starts_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+0 days') IS starts_at) AND (due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at) AND (closed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', closed_at, '+0 days') IS closed_at))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "organization_id", "kind", "subject_type", "subject_id", "product_id", "location_id", "opportunity_id", "title", "notes", "assigned_member_id", "assigned_team_id", "starts_at", "due_at", "timezone", "status", "outcome_note", "closed_at", "closed_by_user_id", "dedupe_key", "version", "created_by_user_id", "created_at", "updated_at") SELECT "id", "organization_id", "kind", "subject_type", "subject_id", "product_id", "location_id", "opportunity_id", "title", "notes", "assigned_member_id", "assigned_team_id", "starts_at", "due_at", "timezone", "status", "outcome_note", "closed_at", "closed_by_user_id", "dedupe_key", "version", "created_by_user_id", "created_at", "updated_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_dedupe_key_unique` ON `tasks` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_opportunity_unique` ON `tasks` (`opportunity_id`) WHERE opportunity_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `tasks_status_due_idx` ON `tasks` (`organization_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_member_status_due_idx` ON `tasks` (`organization_id`,`assigned_member_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_team_status_due_idx` ON `tasks` (`organization_id`,`assigned_team_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_subject_idx` ON `tasks` (`subject_type`,`subject_id`);