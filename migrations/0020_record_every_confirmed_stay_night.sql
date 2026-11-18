SELECT CASE WHEN EXISTS (
  SELECT 1 FROM bookings b WHERE b.owner = 'channel' AND b.status = 'confirmed'
  AND NOT EXISTS (SELECT 1 FROM stay_nights n WHERE n.booking_id = b.id)
) THEN json_extract('{}', 'CHANNEL_RESERVATION_NIGHTS_MISSING') ELSE 1 END;--> statement-breakpoint
CREATE TABLE `__new_stay_nights` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`date` text NOT NULL,
	`booking_id` text NOT NULL,
	PRIMARY KEY(`booking_id`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stay_nights_date_check" CHECK(date(date, '+0 days') IS date)
);
--> statement-breakpoint
INSERT INTO `__new_stay_nights`("organization_id", "product_id", "date", "booking_id") SELECT "organization_id", "product_id", "date", "booking_id" FROM `stay_nights`;--> statement-breakpoint
DROP TABLE `stay_nights`;--> statement-breakpoint
ALTER TABLE `__new_stay_nights` RENAME TO `stay_nights`;--> statement-breakpoint
CREATE INDEX `stay_nights_home_date_idx` ON `stay_nights` (`product_id`,`date`);--> statement-breakpoint
CREATE VIEW `occupied_stay_nights` AS 
  SELECT n.organization_id, n.product_id, n.date, n.booking_id FROM stay_nights n
  UNION ALL
  SELECT n.organization_id, b.booked_product_id, n.date, n.booking_id FROM bookings b
  JOIN stay_nights n ON n.organization_id = b.organization_id AND n.booking_id = b.id
  WHERE b.status = 'confirmed' AND b.booked_product_id IS NOT NULL AND b.booked_product_id <> n.product_id
;
--> statement-breakpoint
CREATE TRIGGER stay_nights_app_occupancy_insert
BEFORE INSERT ON stay_nights
WHEN EXISTS (SELECT 1 FROM bookings WHERE id = NEW.booking_id AND owner = 'app')
AND EXISTS (
  SELECT 1 FROM occupied_stay_nights n
  WHERE n.organization_id = NEW.organization_id AND n.product_id = NEW.product_id
    AND n.date = NEW.date AND n.booking_id <> NEW.booking_id
)
BEGIN
  SELECT RAISE(ABORT, 'STAY_NIGHT_OCCUPIED');
END;
