PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_notification_preferences` (
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`email_enabled` integer NOT NULL,
	`whatsapp_enabled` integer NOT NULL,
	`push_enabled` integer NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `category`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_notification_preferences_category_check" CHECK(category IN ('account_security', 'reservations_bookings', 'guest_messages', 'team_messages', 'reviews', 'review_requests', 'organization_and_billing', 'product_news')),
	CONSTRAINT "user_notification_preferences_updated_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at),
	CONSTRAINT "user_notification_preferences_account_security_check" CHECK(category != 'account_security' OR email_enabled = 1)
);
--> statement-breakpoint
INSERT INTO `__new_user_notification_preferences`("user_id", "category", "email_enabled", "whatsapp_enabled", "push_enabled", "updated_at") SELECT "user_id", "category", "email_enabled", "whatsapp_enabled", "push_enabled", "updated_at" FROM `user_notification_preferences`;--> statement-breakpoint
DROP TABLE `user_notification_preferences`;--> statement-breakpoint
ALTER TABLE `__new_user_notification_preferences` RENAME TO `user_notification_preferences`;--> statement-breakpoint
PRAGMA foreign_keys=ON;