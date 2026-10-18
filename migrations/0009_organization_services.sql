CREATE TABLE `organization_services` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`service` text NOT NULL,
	`terms_version` text NOT NULL,
	`agreed_by_user_id` text,
	`agreed_at` text NOT NULL,
	`ended_by_user_id` text,
	`ended_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agreed_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ended_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_services_current_unique` ON `organization_services` (`organization_id`,`service`) WHERE ended_at IS NULL;