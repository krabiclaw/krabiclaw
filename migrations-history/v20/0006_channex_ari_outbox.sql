PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_channel_night_pushes` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`provider` text NOT NULL,
	`date` text NOT NULL,
	`state` text NOT NULL,
	`detail` text,
	`sent_json` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`product_id`, `provider`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`,`provider`) REFERENCES `product_channel_mappings`(`product_id`,`provider`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_night_pushes_provider_check" CHECK(provider = 'channex'),
	CONSTRAINT "channel_night_pushes_state_check" CHECK(state IN ('pending', 'pushed', 'needs_review')),
	CONSTRAINT "channel_night_pushes_detail_check" CHECK(state <> 'needs_review' OR detail IS NOT NULL),
	CONSTRAINT "channel_night_pushes_date_check" CHECK(date(date) IS date),
	CONSTRAINT "channel_night_pushes_updated_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at),
	CONSTRAINT "channel_night_pushes_attempts_check" CHECK(attempts >= 0),
	CONSTRAINT "channel_night_pushes_retry_check" CHECK(retry_at IS NULL OR (state = 'pending' AND strftime('%Y-%m-%dT%H:%M:%fZ', retry_at, '+0 days') IS retry_at))
);
--> statement-breakpoint
INSERT INTO `__new_channel_night_pushes`("organization_id", "product_id", "provider", "date", "state", "detail", "updated_at") SELECT "organization_id", "product_id", "provider", "date", "state", "detail", "updated_at" FROM `channel_night_pushes`;--> statement-breakpoint
DROP TABLE `channel_night_pushes`;--> statement-breakpoint
ALTER TABLE `__new_channel_night_pushes` RENAME TO `channel_night_pushes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `channel_night_pushes_state_idx` ON `channel_night_pushes` (`organization_id`,`state`);--> statement-breakpoint
CREATE INDEX `channel_night_pushes_due_idx` ON `channel_night_pushes` (`state`,`retry_at`);