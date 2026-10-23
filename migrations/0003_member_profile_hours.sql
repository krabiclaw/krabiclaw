PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_member_scheduling` (
	`member_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`timezone` text,
	`weekly_json` text,
	`time_off_json` text,
	`windows_json` text,
	`windows_until` text,
	`public_name` text,
	`public_photo_url` text,
	`public_bio` text,
	`public_approved` integer DEFAULT 0 NOT NULL,
	`calendar_account_id` text,
	`calendar_ids_json` text DEFAULT '[]' NOT NULL,
	`calendar_revision` text NOT NULL,
	`busy_json` text DEFAULT '[]' NOT NULL,
	`busy_from` text,
	`busy_until` text,
	`busy_checked_at` text,
	`busy_error` text,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`member_id`,`organization_id`) REFERENCES `member`(`id`,`organizationId`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "member_scheduling_hours_check" CHECK(("__new_member_scheduling"."timezone" IS NULL AND "__new_member_scheduling"."weekly_json" IS NULL AND "__new_member_scheduling"."time_off_json" IS NULL AND "__new_member_scheduling"."windows_json" IS NULL AND "__new_member_scheduling"."windows_until" IS NULL) OR ("__new_member_scheduling"."timezone" IS NOT NULL AND "__new_member_scheduling"."weekly_json" IS NOT NULL AND "__new_member_scheduling"."time_off_json" IS NOT NULL AND "__new_member_scheduling"."windows_json" IS NOT NULL AND "__new_member_scheduling"."windows_until" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_member_scheduling`("member_id", "organization_id", "timezone", "weekly_json", "time_off_json", "windows_json", "windows_until", "public_name", "public_photo_url", "public_bio", "public_approved", "calendar_account_id", "calendar_ids_json", "calendar_revision", "busy_json", "busy_from", "busy_until", "busy_checked_at", "busy_error", "updated_at", "updated_by") SELECT "member_id", "organization_id", "timezone", "weekly_json", "time_off_json", "windows_json", "windows_until", "public_name", "public_photo_url", "public_bio", "public_approved", "calendar_account_id", "calendar_ids_json", "calendar_revision", "busy_json", "busy_from", "busy_until", "busy_checked_at", "busy_error", "updated_at", "updated_by" FROM `member_scheduling`;--> statement-breakpoint
DROP TABLE `member_scheduling`;--> statement-breakpoint
ALTER TABLE `__new_member_scheduling` RENAME TO `member_scheduling`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `member_scheduling_org_idx` ON `member_scheduling` (`organization_id`);