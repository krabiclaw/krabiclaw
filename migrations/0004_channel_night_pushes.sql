CREATE TABLE `channel_night_pushes` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`provider` text NOT NULL,
	`date` text NOT NULL,
	`state` text NOT NULL,
	`detail` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`product_id`, `provider`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`,`provider`) REFERENCES `product_channel_mappings`(`product_id`,`provider`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_night_pushes_provider_check" CHECK(provider = 'channex'),
	CONSTRAINT "channel_night_pushes_state_check" CHECK(state IN ('pending', 'pushed', 'needs_review')),
	CONSTRAINT "channel_night_pushes_detail_check" CHECK(state <> 'needs_review' OR detail IS NOT NULL),
	CONSTRAINT "channel_night_pushes_date_check" CHECK(date(date) IS date),
	CONSTRAINT "channel_night_pushes_updated_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
CREATE INDEX `channel_night_pushes_state_idx` ON `channel_night_pushes` (`organization_id`,`state`);