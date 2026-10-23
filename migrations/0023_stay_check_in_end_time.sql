-- The end of a home's check-in window, as Airbnb's listing editor holds it: local HH:MM, null for a flexible end.
-- In place: rebuilding the home config would cascade-delete its nights, stays and channel mappings on D1.
ALTER TABLE `product_stay_configs` ADD COLUMN `check_in_end_time` text
  CONSTRAINT "product_stay_configs_check_in_end_check" CHECK(check_in_end_time IS NULL OR (check_in_end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND check_in_end_time < '24:00'));
