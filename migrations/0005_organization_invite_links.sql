CREATE TABLE `organization_invite_links` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`inviter_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`used_by_user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "organization_invite_links_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at AND (used_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', used_at, '+0 days') IS used_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at),
	CONSTRAINT "organization_invite_links_role_check" CHECK(role IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invite_links_token_hash_unique` ON `organization_invite_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `organization_invite_links_organization_id_idx` ON `organization_invite_links` (`organization_id`);