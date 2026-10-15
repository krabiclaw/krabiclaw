CREATE TABLE `channex_connections` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`operation_id` text,
	`pending_step` text,
	`group_id` text,
	`setup_property_id` text,
	`state_hash` text,
	`authorization_url` text,
	`authorization_user_id` text,
	`authorization_title` text,
	`authorization_expires_at` text,
	`channel_id` text,
	`connected_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`authorization_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "channex_connections_status_check" CHECK(status IN ('not_connected', 'authorizing', 'connected', 'disconnecting', 'needs_review')),
	CONSTRAINT "channex_connections_connected_check" CHECK(status <> 'connected' OR (channel_id IS NOT NULL AND group_id IS NOT NULL AND connected_at IS NOT NULL)),
	CONSTRAINT "channex_connections_authorizing_check" CHECK(status <> 'authorizing' OR (authorization_url IS NOT NULL AND state_hash IS NOT NULL AND authorization_expires_at IS NOT NULL AND authorization_title IS NOT NULL)),
	CONSTRAINT "channex_connections_instants_check" CHECK((authorization_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', authorization_expires_at, '+0 days') IS authorization_expires_at) AND (connected_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', connected_at, '+0 days') IS connected_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channex_connections_group_unique` ON `channex_connections` (`group_id`) WHERE group_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `channex_connections_channel_unique` ON `channex_connections` (`channel_id`) WHERE channel_id IS NOT NULL;