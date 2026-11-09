ALTER TABLE `product_stay_configs` ADD `internal_name` text;
--> statement-breakpoint
UPDATE product_stay_configs
SET internal_name = (
  SELECT name FROM products
  WHERE products.id = product_stay_configs.product_id
    AND products.organization_id = product_stay_configs.organization_id
);
