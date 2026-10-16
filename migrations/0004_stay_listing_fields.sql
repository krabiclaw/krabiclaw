-- Expand the home config in place: rebuilding it would cascade-delete its nights, stays and channel mappings on D1.
ALTER TABLE `product_stay_configs` ADD COLUMN `property_type` text
  CONSTRAINT "product_stay_configs_property_type_check" CHECK(property_type IS NULL OR property_type IN ('apartment', 'house', 'secondary_unit', 'unique_space', 'bed_and_breakfast', 'boutique_hotel'));
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `bedrooms` integer
  CONSTRAINT "product_stay_configs_bedrooms_check" CHECK(bedrooms IS NULL OR bedrooms BETWEEN 0 AND 50);
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `beds` integer
  CONSTRAINT "product_stay_configs_beds_check" CHECK(beds IS NULL OR beds BETWEEN 1 AND 50);
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `bathrooms` real
  CONSTRAINT "product_stay_configs_bathrooms_check" CHECK(bathrooms IS NULL OR (bathrooms BETWEEN 0 AND 50 AND bathrooms * 2 = CAST(bathrooms * 2 AS INTEGER)));
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `amenities` text DEFAULT '[]' NOT NULL
  CONSTRAINT "product_stay_configs_amenities_check" CHECK(json_valid(amenities) AND json_type(amenities) = 'array');
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `cancellation_policy` text
  CONSTRAINT "product_stay_configs_cancellation_check" CHECK(cancellation_policy IS NULL OR cancellation_policy IN ('flexible', 'moderate', 'limited', 'firm', 'strict'));
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `long_term_cancellation_policy` text
  CONSTRAINT "product_stay_configs_long_term_cancellation_check" CHECK(long_term_cancellation_policy IS NULL OR long_term_cancellation_policy IN ('firm', 'strict'));
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `check_in_method` text
  CONSTRAINT "product_stay_configs_check_in_method_check" CHECK(check_in_method IS NULL OR check_in_method IN ('smart_lock', 'keypad', 'lockbox', 'building_staff', 'in_person', 'other'));
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `wifi_network` text
  CONSTRAINT "product_stay_configs_wifi_network_check" CHECK(wifi_network IS NULL OR length(trim(wifi_network)) BETWEEN 1 AND 100);
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `wifi_password` text
  CONSTRAINT "product_stay_configs_wifi_password_check" CHECK(wifi_password IS NULL OR length(wifi_password) BETWEEN 1 AND 100);
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `directions` text
  CONSTRAINT "product_stay_configs_directions_check" CHECK(directions IS NULL OR length(trim(directions)) BETWEEN 1 AND 5000);
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `house_manual` text
  CONSTRAINT "product_stay_configs_house_manual_check" CHECK(house_manual IS NULL OR length(trim(house_manual)) BETWEEN 1 AND 5000);
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `checkout_instructions` text DEFAULT '[]' NOT NULL
  CONSTRAINT "product_stay_configs_checkout_instructions_check" CHECK(json_valid(checkout_instructions) AND json_type(checkout_instructions) = 'array');
