-- Add optional room facts in place; rebuilding this parent can cascade-delete photo memberships on D1.
ALTER TABLE `product_stay_photo_rooms` ADD COLUMN `details_version` integer DEFAULT 1 NOT NULL
  CONSTRAINT "product_stay_photo_rooms_details_version_check" CHECK(details_version >= 1);
--> statement-breakpoint
ALTER TABLE `product_stay_photo_rooms` ADD COLUMN `sleeping_arrangements` text
  CONSTRAINT "product_stay_photo_rooms_sleeping_arrangements_check" CHECK(sleeping_arrangements IS NULL OR (json_valid(sleeping_arrangements) AND json_type(sleeping_arrangements) = 'array'));
--> statement-breakpoint
ALTER TABLE `product_stay_photo_rooms` ADD COLUMN `private_attached_bathroom` integer
  CONSTRAINT "product_stay_photo_rooms_private_bathroom_check" CHECK(private_attached_bathroom IS NULL OR (type = 'bedroom' AND private_attached_bathroom IN (0, 1)));
