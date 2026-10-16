CREATE TABLE `guest_thread_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_user_id` text,
	`expires_at` text NOT NULL,
	`claimed_at` text,
	`claimed_user_id` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`claimed_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "guest_thread_invites_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at AND (claimed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+0 days') IS claimed_at) AND (revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at, '+0 days') IS revoked_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at),
	CONSTRAINT "guest_thread_invites_state_check" CHECK((claimed_at IS NULL OR revoked_at IS NULL) AND (claimed_user_id IS NULL OR claimed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_thread_invites_token_hash_unique` ON `guest_thread_invites` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `guest_thread_invites_open_request_unique` ON `guest_thread_invites` (`request_id`) WHERE claimed_at IS NULL AND revoked_at IS NULL;