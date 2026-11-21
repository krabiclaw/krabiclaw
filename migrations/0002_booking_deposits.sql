ALTER TABLE `bookings` ADD `deposit_minor` integer;--> statement-breakpoint
ALTER TABLE `offline_payments` ADD `purpose` text DEFAULT 'payment' NOT NULL;