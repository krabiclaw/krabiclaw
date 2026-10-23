CREATE TABLE `product_stay_photo_room_memberships` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`room_id` text NOT NULL,
	PRIMARY KEY(`organization_id`, `product_id`, `asset_id`),
	FOREIGN KEY (`organization_id`,`product_id`,`room_id`) REFERENCES `product_stay_photo_rooms`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`asset_id`) REFERENCES `media_assets`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_stay_photo_room_memberships_room_idx` ON `product_stay_photo_room_memberships` (`organization_id`,`product_id`,`room_id`);--> statement-breakpoint
CREATE INDEX `product_stay_photo_room_memberships_asset_idx` ON `product_stay_photo_room_memberships` (`organization_id`,`asset_id`);--> statement-breakpoint
CREATE TABLE `product_stay_photo_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`type` text NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_stay_photo_rooms_type_check" CHECK(type IN ('art_studio', 'backyard', 'balcony', 'bedroom', 'bowling_alley', 'childrens_playroom', 'courtyard', 'darkroom', 'deck', 'dining_area', 'event_room', 'exterior', 'front_yard', 'full_bathroom', 'full_kitchen', 'game_room', 'garage', 'garden', 'gym', 'half_bathroom', 'hot_tub', 'kitchenette', 'laundry_area', 'library', 'living_room', 'movie_theater', 'music_studio', 'office', 'patio', 'photography_studio', 'pool', 'porch', 'rooftop', 'sunroom', 'terrace', 'theme_room', 'wine_cellar', 'woodshop', 'workshop', 'workspace')),
	CONSTRAINT "product_stay_photo_rooms_order_check" CHECK(sort_order >= 0),
	CONSTRAINT "product_stay_photo_rooms_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_stay_photo_rooms_scope_id_unique` ON `product_stay_photo_rooms` (`organization_id`,`product_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_stay_photo_rooms_scope_order_unique` ON `product_stay_photo_rooms` (`organization_id`,`product_id`,`sort_order`);