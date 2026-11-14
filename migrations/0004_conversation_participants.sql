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
ALTER TABLE `conversation_participants` ADD `role` text;--> statement-breakpoint
ALTER TABLE `conversation_participants` ADD `host_listing_id` text REFERENCES products(id) ON DELETE CASCADE;
--> statement-breakpoint
-- Before this release, team rows were explicit seats and guest-thread rows
-- were read positions. Every active team seat keeps its role and state.
UPDATE conversation_participants AS seat SET role = 'member'
WHERE EXISTS (
	SELECT 1 FROM conversations c JOIN member m ON m.organizationId = c.organization_id AND m.userId = seat.user_id
	WHERE c.id = seat.conversation_id AND c.organization_id = seat.organization_id AND c.kind = 'team'
);
--> statement-breakpoint
-- Use the same guest and owner facts that initialize a new guest conversation.
-- Existing read and archive state stays attached to the account that earned it.
INSERT INTO conversation_participants (conversation_id, organization_id, user_id, role, created_at)
SELECT c.id, c.organization_id, c.user_id, 'guest', c.created_at FROM conversations c
WHERE c.kind IN ('contact', 'booking') AND c.user_id IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM bookings b WHERE b.id = c.booking_id AND b.organization_id = c.organization_id
			AND b.user_id IS NOT c.user_id
	)
UNION ALL
SELECT c.id, c.organization_id, m.userId, 'member', c.created_at FROM conversations c
JOIN member m ON m.organizationId = c.organization_id
WHERE c.kind IN ('contact', 'booking') AND m.userId IS NOT c.user_id
	AND (',' || replace(m.role, ' ', '') || ',') LIKE '%,owner,%'
ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = excluded.role
WHERE conversation_participants.role IS NULL;
