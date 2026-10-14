PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_payment_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`stripe_refund_id` text,
	`amount` integer,
	`reason` text NOT NULL,
	`note` text,
	`status` text NOT NULL,
	`error` text,
	`attempted_at` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "payment_refunds_amount_check" CHECK(amount IS NULL OR amount > 0)
);
--> statement-breakpoint
INSERT INTO `__new_payment_refunds`("id", "payment_id", "idempotency_key", "stripe_refund_id", "amount", "reason", "note", "status", "error", "attempted_at", "created_by", "created_at", "updated_at") SELECT "id", "payment_id", "idempotency_key", "stripe_refund_id", "amount", "reason", "note", "status", "error", "attempted_at", "created_by", "created_at", "updated_at" FROM `payment_refunds`;--> statement-breakpoint
DROP TABLE `payment_refunds`;--> statement-breakpoint
ALTER TABLE `__new_payment_refunds` RENAME TO `payment_refunds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `payment_refunds_idempotency_key_unique` ON `payment_refunds` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_refunds_provider_unique` ON `payment_refunds` (`payment_id`,`stripe_refund_id`);--> statement-breakpoint
CREATE TABLE `__new_payment_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text,
	`payment_id` text NOT NULL,
	`action` text NOT NULL,
	`amount` integer,
	`note` text,
	`expires_at` text NOT NULL,
	`approved_at` text,
	`consumed_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_payment_authorizations`("id", "organization_id", "user_id", "payment_id", "action", "amount", "note", "expires_at", "approved_at", "consumed_at") SELECT "id", "organization_id", "user_id", "payment_id", "action", "amount", "note", "expires_at", "approved_at", "consumed_at" FROM `payment_authorizations`;--> statement-breakpoint
DROP TABLE `payment_authorizations`;--> statement-breakpoint
ALTER TABLE `__new_payment_authorizations` RENAME TO `payment_authorizations`;