-- The previous release retired checkout and calendar claims. Rebuild their
-- child table before dropping stay_calendar_links so no FK action can run.
CREATE TABLE `__new_stay_nights` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`date` text NOT NULL,
	`booking_id` text NOT NULL,
	PRIMARY KEY(`product_id`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stay_nights_date_check" CHECK(date(date, '+0 days') IS date)
);
--> statement-breakpoint
INSERT INTO `__new_stay_nights`("organization_id", "product_id", "date", "booking_id")
SELECT "organization_id", "product_id", "date", "booking_id" FROM `stay_nights`
WHERE "booking_id" IS NOT NULL;--> statement-breakpoint
DROP TABLE `stay_nights`;--> statement-breakpoint
ALTER TABLE `__new_stay_nights` RENAME TO `stay_nights`;--> statement-breakpoint
CREATE INDEX `stay_nights_booking_idx` ON `stay_nights` (`booking_id`);--> statement-breakpoint
DROP TABLE `stay_calendar_links`;--> statement-breakpoint
DROP INDEX `payment_holds_capacity_idx`;
