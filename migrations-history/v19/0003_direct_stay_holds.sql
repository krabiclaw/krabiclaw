PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_payment_checkout_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text,
	`variant_id` text,
	`price_id` text,
	`session_id` text,
	`location_id` text,
	`timezone` text,
	`assigned_member_id` text,
	`buyer_user_id` text,
	`request_id` text,
	`payment_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`converted_booking_id` text,
	`converted_reservation_id` text,
	`converted_stay_id` text,
	FOREIGN KEY (`buyer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_holds_quantity_check" CHECK(quantity > 0 AND amount > 0),
	CONSTRAINT "payment_holds_subject_check" CHECK((product_id IS NOT NULL AND variant_id IS NOT NULL AND price_id IS NOT NULL AND session_id IS NOT NULL AND converted_reservation_id IS NULL AND converted_stay_id IS NULL) OR (product_id IS NULL AND variant_id IS NULL AND price_id IS NULL AND session_id IS NULL AND location_id IS NOT NULL AND timezone IS NOT NULL AND assigned_member_id IS NULL AND converted_booking_id IS NULL AND converted_stay_id IS NULL) OR (product_id IS NOT NULL AND variant_id IS NULL AND price_id IS NULL AND session_id IS NULL AND location_id IS NOT NULL AND timezone IS NOT NULL AND assigned_member_id IS NULL AND converted_booking_id IS NULL AND converted_reservation_id IS NULL AND date(starts_at, '+0 days') IS starts_at AND date(ends_at, '+0 days') IS ends_at AND ends_at > starts_at))
);
--> statement-breakpoint
INSERT INTO `__new_payment_checkout_holds`("id", "organization_id", "product_id", "variant_id", "price_id", "session_id", "location_id", "timezone", "assigned_member_id", "buyer_user_id", "request_id", "payment_id", "quantity", "amount", "currency", "starts_at", "ends_at", "status", "expires_at", "created_at", "converted_booking_id", "converted_reservation_id") SELECT "id", "organization_id", "product_id", "variant_id", "price_id", "session_id", "location_id", "timezone", "assigned_member_id", "buyer_user_id", "request_id", "payment_id", "quantity", "amount", "currency", "starts_at", "ends_at", "status", "expires_at", "created_at", "converted_booking_id", "converted_reservation_id" FROM `payment_checkout_holds`;--> statement-breakpoint
DROP TABLE `payment_checkout_holds`;--> statement-breakpoint
ALTER TABLE `__new_payment_checkout_holds` RENAME TO `payment_checkout_holds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `payment_checkout_holds_payment_id_unique` ON `payment_checkout_holds` (`payment_id`);--> statement-breakpoint
CREATE INDEX `payment_holds_capacity_idx` ON `payment_checkout_holds` (`session_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `payment_holds_reservation_idx` ON `payment_checkout_holds` (`organization_id`,`location_id`,`starts_at`,`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `__new_stay_nights` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`date` text NOT NULL,
	`stay_id` text,
	`hold_id` text,
	PRIMARY KEY(`product_id`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`hold_id`) REFERENCES `payment_checkout_holds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`stay_id`) REFERENCES `stays`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stay_nights_date_check" CHECK(date(date, '+0 days') IS date),
	CONSTRAINT "stay_nights_claimant_check" CHECK((stay_id IS NULL) <> (hold_id IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_stay_nights`("organization_id", "product_id", "date", "stay_id") SELECT "organization_id", "product_id", "date", "stay_id" FROM `stay_nights`;--> statement-breakpoint
DROP TABLE `stay_nights`;--> statement-breakpoint
ALTER TABLE `__new_stay_nights` RENAME TO `stay_nights`;--> statement-breakpoint
CREATE INDEX `stay_nights_stay_idx` ON `stay_nights` (`stay_id`);--> statement-breakpoint
CREATE INDEX `stay_nights_hold_idx` ON `stay_nights` (`hold_id`);