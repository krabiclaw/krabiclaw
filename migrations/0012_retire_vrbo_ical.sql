-- Keep booking and checkout claims. Vrbo iCal claims retire with their links.
CREATE TABLE `__new_stay_nights` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`date` text NOT NULL,
	`booking_id` text,
	`hold_id` text,
	PRIMARY KEY(`product_id`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`hold_id`) REFERENCES `payment_checkout_holds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stay_nights_date_check" CHECK(date(date, '+0 days') IS date),
	CONSTRAINT "stay_nights_claimant_check" CHECK((booking_id IS NOT NULL) + (hold_id IS NOT NULL) = 1)
);
--> statement-breakpoint
INSERT INTO `__new_stay_nights`("organization_id", "product_id", "date", "booking_id", "hold_id") SELECT "organization_id", "product_id", "date", "booking_id", "hold_id" FROM `stay_nights` WHERE `calendar_link_id` IS NULL;--> statement-breakpoint
DROP TABLE `stay_nights`;--> statement-breakpoint
ALTER TABLE `__new_stay_nights` RENAME TO `stay_nights`;--> statement-breakpoint
DROP TABLE `stay_calendar_links`;--> statement-breakpoint
CREATE INDEX `stay_nights_booking_idx` ON `stay_nights` (`booking_id`);--> statement-breakpoint
CREATE INDEX `stay_nights_hold_idx` ON `stay_nights` (`hold_id`);
