-- Add optional property facts in place; rebuilding this parent can cascade-delete stays, nights and channel mappings on D1.
ALTER TABLE `product_stay_configs` ADD COLUMN `listing_type` text
  CONSTRAINT "product_stay_configs_listing_type_check" CHECK(listing_type IS NULL OR listing_type IN ('entire_place', 'private_room', 'shared_room'));
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `total_floors` integer
  CONSTRAINT "product_stay_configs_total_floors_check" CHECK(total_floors IS NULL OR (typeof(total_floors) = 'integer' AND total_floors BETWEEN 1 AND 9007199254740991));
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `listing_floor` integer
  CONSTRAINT "product_stay_configs_listing_floor_check" CHECK(listing_floor IS NULL OR (typeof(listing_floor) = 'integer' AND listing_floor BETWEEN 1 AND 9007199254740991 AND (total_floors IS NULL OR listing_floor <= total_floors)));
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `year_built` integer
  CONSTRAINT "product_stay_configs_year_built_check" CHECK(year_built IS NULL OR (typeof(year_built) = 'integer' AND year_built BETWEEN 1 AND 9007199254740991));
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `property_size` real
  CONSTRAINT "product_stay_configs_property_size_check" CHECK(property_size IS NULL OR (typeof(property_size) IN ('integer', 'real') AND property_size > 0 AND property_size <= 1.7976931348623157e308));
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `property_size_unit` text
  CONSTRAINT "product_stay_configs_property_size_unit_check" CHECK((property_size IS NULL AND property_size_unit IS NULL) OR (property_size IS NOT NULL AND property_size_unit IS NOT NULL AND property_size_unit IN ('square_meters', 'square_feet')));
