ALTER TABLE `channel_threads` ADD `moved_from_thread_id` text;--> statement-breakpoint
ALTER TABLE `product_channel_mappings` ADD `delivery_lease` text;--> statement-breakpoint
ALTER TABLE `product_channel_mappings` ADD `delivery_lease_until` text;--> statement-breakpoint
CREATE UNIQUE INDEX `stays_channel_reservation_unique` ON `stays` (`organization_id`,`channel`,`channel_booking_id`) WHERE channel_booking_id IS NOT NULL;