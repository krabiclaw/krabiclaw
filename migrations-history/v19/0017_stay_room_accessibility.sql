CREATE TABLE `product_stay_room_accessibility` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`room_id` text NOT NULL,
	`feature_code` text NOT NULL,
	`available` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `product_id`, `room_id`, `feature_code`),
	FOREIGN KEY (`organization_id`,`product_id`,`room_id`) REFERENCES `product_stay_photo_rooms`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_stay_room_accessibility_feature_check" CHECK(feature_code IN ('step_free_access', 'wide_doorway')),
	CONSTRAINT "product_stay_room_accessibility_available_check" CHECK(available IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `product_stay_room_accessibility_photos` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`room_id` text NOT NULL,
	`feature_code` text NOT NULL,
	`asset_id` text NOT NULL,
	PRIMARY KEY(`organization_id`, `product_id`, `room_id`, `feature_code`, `asset_id`),
	FOREIGN KEY (`organization_id`,`product_id`,`room_id`,`feature_code`) REFERENCES `product_stay_room_accessibility`(`organization_id`,`product_id`,`room_id`,`feature_code`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`asset_id`) REFERENCES `media_assets`(`organization_id`,`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `product_stay_room_accessibility_photos_asset_idx` ON `product_stay_room_accessibility_photos` (`organization_id`,`asset_id`);