PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_broadcasts` (
	`id` text PRIMARY KEY NOT NULL,
	`content_document_id` text NOT NULL,
	`category` text NOT NULL,
	`provider_broadcast_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`content_document_id`) REFERENCES `content_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "broadcasts_category_check" CHECK(category IN ('account_security', 'reservations_bookings', 'messages', 'reviews', 'review_requests', 'organization_and_billing', 'product_news')),
	CONSTRAINT "broadcasts_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);
--> statement-breakpoint
INSERT INTO `__new_broadcasts`("id", "content_document_id", "category", "provider_broadcast_id", "created_at") SELECT "id", "content_document_id", CASE WHEN "category" IN ('guest_messages', 'team_messages') THEN 'messages' ELSE "category" END, "provider_broadcast_id", "created_at" FROM `broadcasts`;--> statement-breakpoint
DROP TABLE `broadcasts`;--> statement-breakpoint
ALTER TABLE `__new_broadcasts` RENAME TO `broadcasts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `broadcasts_content_document_id_unique` ON `broadcasts` (`content_document_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `broadcasts_provider_broadcast_id_unique` ON `broadcasts` (`provider_broadcast_id`) WHERE provider_broadcast_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_user_notification_preferences` (
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`email_enabled` integer NOT NULL,
	`whatsapp_enabled` integer NOT NULL,
	`push_enabled` integer NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `category`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_notification_preferences_category_check" CHECK(category IN ('account_security', 'reservations_bookings', 'messages', 'reviews', 'review_requests', 'organization_and_billing', 'product_news')),
	CONSTRAINT "user_notification_preferences_updated_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at),
	CONSTRAINT "user_notification_preferences_account_security_check" CHECK(category != 'account_security' OR email_enabled = 1)
);
--> statement-breakpoint
INSERT INTO `__new_user_notification_preferences`("user_id", "category", "email_enabled", "whatsapp_enabled", "push_enabled", "updated_at") SELECT p.user_id,
  CASE WHEN p.category IN ('guest_messages', 'team_messages') THEN 'messages' ELSE p.category END,
  CASE WHEN p.category = 'team_messages' THEN 1 ELSE p.email_enabled END,
  CASE WHEN p.category = 'team_messages' THEN 1 ELSE p.whatsapp_enabled END,
  p.push_enabled, p.updated_at
FROM user_notification_preferences p
WHERE p.category <> 'team_messages' OR NOT EXISTS (
  SELECT 1 FROM user_notification_preferences guest
  WHERE guest.user_id = p.user_id AND guest.category = 'guest_messages'
);--> statement-breakpoint
DROP TABLE `user_notification_preferences`;--> statement-breakpoint
ALTER TABLE `__new_user_notification_preferences` RENAME TO `user_notification_preferences`;