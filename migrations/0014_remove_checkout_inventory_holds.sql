-- Recompute the channel inventory previously published for retiring checkout claims.
UPDATE `channel_night_pushes`
SET `state` = 'pending', `detail` = NULL, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
  SELECT 1 FROM `stay_nights` n WHERE n.organization_id = channel_night_pushes.organization_id
    AND n.product_id = channel_night_pushes.product_id AND n.date = channel_night_pushes.date AND n.booking_id IS NULL
);--> statement-breakpoint
-- Keep booking claims. Checkout records no longer claim inventory.
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
INSERT INTO `__new_stay_nights`("organization_id", "product_id", "date", "booking_id") SELECT "organization_id", "product_id", "date", "booking_id" FROM `stay_nights` WHERE `booking_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `stay_nights`;--> statement-breakpoint
ALTER TABLE `__new_stay_nights` RENAME TO `stay_nights`;--> statement-breakpoint
CREATE INDEX `stay_nights_booking_idx` ON `stay_nights` (`booking_id`);--> statement-breakpoint
DROP INDEX `payment_holds_capacity_idx`;
