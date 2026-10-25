CREATE TABLE `content_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`reporter_user_id` text,
	`subject` text NOT NULL,
	`request_id` text,
	`team_message_id` text,
	`author_user_id` text,
	`reason` text NOT NULL,
	`excerpt` text NOT NULL,
	`blocked` integer NOT NULL,
	`status` text NOT NULL,
	`resolved_by_user_id` text,
	`resolved_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reporter_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_message_id`) REFERENCES `team_messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "content_reports_subject_check" CHECK((subject = 'guest_thread' AND team_message_id IS NULL) OR (subject = 'team_message' AND request_id IS NULL AND blocked = 0)),
	CONSTRAINT "content_reports_reason_check" CHECK(length(reason) BETWEEN 1 AND 1000 AND reason = trim(reason)),
	CONSTRAINT "content_reports_resolution_check" CHECK((status = 'open') = (resolved_at IS NULL)),
	CONSTRAINT "content_reports_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND (resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at, '+0 days') IS resolved_at))
);
--> statement-breakpoint
CREATE INDEX `content_reports_status_created_idx` ON `content_reports` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `content_reports_request_idx` ON `content_reports` (`request_id`);--> statement-breakpoint
CREATE INDEX `content_reports_team_message_idx` ON `content_reports` (`team_message_id`);--> statement-breakpoint
ALTER TABLE `requests` ADD `blocked_at` text;