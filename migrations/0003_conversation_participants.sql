CREATE TABLE `conversation_guest_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`inviter_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`accepted_user_id` text,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`accepted_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`conversation_id`) REFERENCES `conversations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_guest_invites_token_hash_unique` ON `conversation_guest_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `conversation_guest_invites_conversation_idx` ON `conversation_guest_invites` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `listing_message_members` (
	`organization_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`member_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`organization_id`, `listing_id`, `member_id`),
	FOREIGN KEY (`organization_id`,`listing_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`,`organization_id`) REFERENCES `member`(`id`,`organizationId`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `listing_message_members_member_idx` ON `listing_message_members` (`member_id`,`organization_id`);--> statement-breakpoint
ALTER TABLE `conversation_participants` ADD `role` text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_participants` ADD `host_listing_id` text REFERENCES products(id) ON DELETE CASCADE;