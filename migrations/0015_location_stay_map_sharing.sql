-- Add the lodging map choice in place; rebuilding this parent can cascade-delete its offerings, stays and bookings on D1.
ALTER TABLE `business_locations` ADD COLUMN `stay_map_sharing` text DEFAULT 'general' NOT NULL
  CONSTRAINT "business_locations_stay_map_sharing_check" CHECK(stay_map_sharing IN ('general', 'specific'));
