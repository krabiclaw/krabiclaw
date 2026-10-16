PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_media_placements` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`slot` text NOT NULL,
	`asset_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`presentation_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`asset_id`) REFERENCES `media_assets`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_placements_presentation_check" CHECK(presentation_json IS NULL OR (json_valid(presentation_json) AND json_extract(presentation_json, '$.shape') IN ('original', 'square', 'circle') AND json_type(presentation_json, '$.focus.x') IN ('integer', 'real') AND json_type(presentation_json, '$.focus.y') IN ('integer', 'real')) IS TRUE),
	CONSTRAINT "media_placements_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "media_placements_owner_type_check" CHECK(owner_type IN ('organization', 'business_location', 'product', 'collection', 'content_document', 'content_block', 'review', 'review_request', 'activity_entry')),
	CONSTRAINT "media_placements_sort_order_check" CHECK(sort_order >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_media_placements`("id", "organization_id", "owner_type", "owner_id", "slot", "asset_id", "sort_order", "status", "presentation_json", "created_at", "updated_at") SELECT "id", "organization_id", "owner_type", "owner_id", "slot", "asset_id", "sort_order", "status", "presentation_json", "created_at", "updated_at" FROM `media_placements`;--> statement-breakpoint
DROP TABLE `media_placements`;--> statement-breakpoint
ALTER TABLE `__new_media_placements` RENAME TO `media_placements`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `media_placements_asset_idx` ON `media_placements` (`organization_id`,`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_placements_org_owner_slot_asset_unique` ON `media_placements` (`owner_type`,`owner_id`,`slot`,`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_placements_org_owner_slot_order_unique` ON `media_placements` (`owner_type`,`owner_id`,`slot`,`sort_order`);