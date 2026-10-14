ALTER TABLE `payment_attempts` ADD `stripe_payment_intent_id` text;--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD `review_json` text;--> statement-breakpoint
ALTER TABLE `payment_refunds` ADD `surcharge_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `surcharge_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `stripe_connected_accounts` ADD `surcharge_basis_points` integer;