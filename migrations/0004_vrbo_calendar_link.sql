CREATE TABLE `stay_calendar_links` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`channel` text NOT NULL,
	`import_url` text NOT NULL,
	`export_token` text NOT NULL,
	`blocked_json` text DEFAULT '[]' NOT NULL,
	`synced_at` text,
	`sync_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stay_calendar_links_channel_check" CHECK(channel = 'vrbo'),
	CONSTRAINT "stay_calendar_links_import_url_check" CHECK(import_url LIKE 'https://%'),
	CONSTRAINT "stay_calendar_links_blocked_check" CHECK(json_valid(blocked_json) AND json_type(blocked_json) = 'array'),
	CONSTRAINT "stay_calendar_links_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (synced_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', synced_at, '+0 days') IS synced_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stay_calendar_links_home_channel_unique` ON `stay_calendar_links` (`product_id`,`channel`);--> statement-breakpoint
CREATE UNIQUE INDEX `stay_calendar_links_export_token_unique` ON `stay_calendar_links` (`export_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `stay_calendar_links_org_product_id_unique` ON `stay_calendar_links` (`organization_id`,`product_id`,`id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stay_nights` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`date` text NOT NULL,
	`stay_id` text,
	`hold_id` text,
	`calendar_link_id` text,
	PRIMARY KEY(`product_id`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`hold_id`) REFERENCES `payment_checkout_holds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`stay_id`) REFERENCES `stays`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`calendar_link_id`) REFERENCES `stay_calendar_links`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stay_nights_date_check" CHECK(date(date, '+0 days') IS date),
	CONSTRAINT "stay_nights_claimant_check" CHECK((stay_id IS NOT NULL) + (hold_id IS NOT NULL) + (calendar_link_id IS NOT NULL) = 1)
);
--> statement-breakpoint
INSERT INTO `__new_stay_nights`("organization_id", "product_id", "date", "stay_id", "hold_id", "calendar_link_id") SELECT "organization_id", "product_id", "date", "stay_id", "hold_id", NULL FROM `stay_nights`;--> statement-breakpoint
DROP TABLE `stay_nights`;--> statement-breakpoint
ALTER TABLE `__new_stay_nights` RENAME TO `stay_nights`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `stay_nights_stay_idx` ON `stay_nights` (`stay_id`);--> statement-breakpoint
CREATE INDEX `stay_nights_hold_idx` ON `stay_nights` (`hold_id`);--> statement-breakpoint
CREATE INDEX `stay_nights_calendar_link_idx` ON `stay_nights` (`calendar_link_id`);