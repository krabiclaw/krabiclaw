ALTER TABLE `location_reservation_configs` ADD `questions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `product_booking_configs` ADD `questions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD `questions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `stays` ADD `answers` text DEFAULT '[]' NOT NULL;