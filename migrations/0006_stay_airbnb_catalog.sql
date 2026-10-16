-- Property types and amenities become Airbnb's own catalog (shared/stay-listing.ts).
-- In place: rebuilding the home config would cascade-delete its nights, stays and channel mappings on D1.
-- A home's property type moves into Airbnb's group and a type in it.
CREATE TABLE `stay_property_type_carry` (`product_id` text PRIMARY KEY NOT NULL, `property_type_group` text NOT NULL, `property_type` text NOT NULL);
--> statement-breakpoint
INSERT INTO `stay_property_type_carry` (product_id, property_type_group, property_type)
  SELECT product_id,
    CASE property_type WHEN 'apartment' THEN 'apartments' WHEN 'house' THEN 'houses' WHEN 'secondary_unit' THEN 'secondary_units'
      WHEN 'unique_space' THEN 'unique_homes' WHEN 'bed_and_breakfast' THEN 'bnb' WHEN 'boutique_hotel' THEN 'boutique_hotels_and_more' END,
    CASE property_type WHEN 'apartment' THEN 'apartment' WHEN 'house' THEN 'house' WHEN 'secondary_unit' THEN 'guesthouse'
      WHEN 'unique_space' THEN 'other' WHEN 'bed_and_breakfast' THEN 'bnb' WHEN 'boutique_hotel' THEN 'boutique_hotel' END
  FROM `product_stay_configs` WHERE property_type IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `product_stay_configs` DROP COLUMN `property_type`;
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `property_type_group` text
  CONSTRAINT "product_stay_configs_property_type_group_check" CHECK(property_type_group IS NULL OR property_type_group IN ('apartments', 'houses', 'secondary_units', 'unique_homes', 'bnb', 'boutique_hotels_and_more'));
--> statement-breakpoint
ALTER TABLE `product_stay_configs` ADD COLUMN `property_type` text
  CONSTRAINT "product_stay_configs_property_type_check" CHECK((property_type IS NULL AND property_type_group IS NULL) OR property_type_group || ':' || property_type IN ('apartments:apartment', 'apartments:condominium', 'apartments:serviced_apartment', 'apartments:loft', 'houses:house', 'houses:townhouse', 'houses:bungalow', 'houses:cabin', 'houses:chalet', 'houses:earthhouse', 'houses:hut', 'houses:lighthouse', 'houses:villa', 'houses:dome', 'houses:cottage', 'houses:farmstay', 'houses:houseboat', 'houses:tiny_house', 'secondary_units:guesthouse', 'secondary_units:private_suite', 'secondary_units:farmstay', 'unique_homes:boat', 'unique_homes:castle', 'unique_homes:cave', 'unique_homes:earthhouse', 'unique_homes:hut', 'unique_homes:igloo', 'unique_homes:island', 'unique_homes:lighthouse', 'unique_homes:plane', 'unique_homes:rv', 'unique_homes:tent', 'unique_homes:tipi', 'unique_homes:train', 'unique_homes:treehouse', 'unique_homes:yurt', 'unique_homes:other', 'unique_homes:dome', 'unique_homes:barn', 'unique_homes:campsite', 'unique_homes:farmstay', 'unique_homes:houseboat', 'unique_homes:tiny_house', 'unique_homes:windmill', 'unique_homes:bus', 'unique_homes:holiday_park', 'unique_homes:ranch', 'unique_homes:religious_building', 'unique_homes:riad', 'unique_homes:shipping_container', 'unique_homes:tower', 'bnb:bnb', 'bnb:nature_eco_lodge', 'bnb:farmstay', 'boutique_hotels_and_more:boutique_hotel', 'boutique_hotels_and_more:nature_eco_lodge', 'boutique_hotels_and_more:hostel', 'boutique_hotels_and_more:serviced_apartment', 'boutique_hotels_and_more:aparthotel', 'boutique_hotels_and_more:hotel', 'boutique_hotels_and_more:resort'));
--> statement-breakpoint
UPDATE `product_stay_configs` SET
    property_type_group = (SELECT property_type_group FROM `stay_property_type_carry` c WHERE c.product_id = product_stay_configs.product_id),
    property_type = (SELECT property_type FROM `stay_property_type_carry` c WHERE c.product_id = product_stay_configs.product_id)
  WHERE product_id IN (SELECT product_id FROM `stay_property_type_carry`);
--> statement-breakpoint
DROP TABLE `stay_property_type_carry`;
--> statement-breakpoint
-- Amenity codes take Airbnb's names. Self check-in is the arrival guide's check-in method and pets are a house rule, not Airbnb amenities.
UPDATE `product_stay_configs` SET amenities = (
  WITH renamed(old, new) AS (VALUES
    ('air_conditioning', 'ac'),
    ('indoor_fireplace', 'fireplace'),
    ('smoke_alarm', 'smoke_detector'),
    ('carbon_monoxide_alarm', 'carbon_monoxide_detector'),
    ('wifi', 'wireless_internet'),
    ('dedicated_workspace', 'laptop_friendly_workspace'),
    ('ski_in_out', 'ski_in_ski_out'),
    ('patio', 'patio_or_belcony'),
    ('bbq_grill', 'bbq_area'),
    ('outdoor_dining', 'alfresco_dining'),
    ('outdoor_shower', 'alfresco_shower'),
    ('paid_parking', 'paid_parking_on_premises'),
    ('hot_tub', 'jacuzzi'),
    ('long_term_stays', 'long_term_stays_allowed'),
    ('luggage_dropoff', 'luggage_dropoff_allowed'))
  SELECT json_group_array(COALESCE(r.new, j.value)) FROM json_each(product_stay_configs.amenities) j
    LEFT JOIN renamed r ON r.old = j.value
   WHERE j.value NOT IN ('self_check_in', 'pets_allowed')
)
WHERE EXISTS (SELECT 1 FROM json_each(product_stay_configs.amenities) j WHERE j.value IN ('air_conditioning', 'indoor_fireplace', 'smoke_alarm', 'carbon_monoxide_alarm', 'wifi', 'dedicated_workspace', 'ski_in_out', 'patio', 'bbq_grill', 'outdoor_dining', 'outdoor_shower', 'paid_parking', 'hot_tub', 'long_term_stays', 'luggage_dropoff', 'self_check_in', 'pets_allowed'));
