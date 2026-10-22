CREATE TABLE `product_stay_accessibility` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`feature_code` text NOT NULL,
	`available` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `product_id`, `feature_code`),
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_stay_accessibility_feature_check" CHECK(feature_code IN ('disabled_parking_spot', 'path_to_entrance_lit_at_night', 'home_step_free_access', 'home_wide_doorway', 'pool_hoist', 'ceiling_hoist')),
	CONSTRAINT "product_stay_accessibility_available_check" CHECK(available IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `product_stay_accessibility_photos` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`feature_code` text NOT NULL,
	`asset_id` text NOT NULL,
	PRIMARY KEY(`organization_id`, `product_id`, `feature_code`, `asset_id`),
	FOREIGN KEY (`organization_id`,`product_id`,`feature_code`) REFERENCES `product_stay_accessibility`(`organization_id`,`product_id`,`feature_code`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`asset_id`) REFERENCES `media_assets`(`organization_id`,`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `product_stay_accessibility_photos_asset_idx` ON `product_stay_accessibility_photos` (`organization_id`,`asset_id`);