-- message_templates is referenced only by scheduled_guest_messages, which
-- nothing references. The child's rows are held in a plain table and the child
-- dropped first, so the parent is unreferenced when it is dropped and no
-- foreign-key action can run (scripts/lint-migrations.mjs). The child is then
-- recreated against the rebuilt parent and its rows restored.
CREATE TABLE `__new_message_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`schedule_json` text,
	`schedule_enabled_at` text,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_templates_text_check" CHECK(length(trim(title)) BETWEEN 1 AND 100 AND length(trim(body)) BETWEEN 1 AND 5000),
	CONSTRAINT "message_templates_version_check" CHECK(version >= 1),
	CONSTRAINT "message_templates_schedule_check" CHECK((schedule_json IS NULL AND schedule_enabled_at IS NULL) OR (schedule_json IS NOT NULL AND schedule_enabled_at IS NOT NULL AND json_valid(schedule_json) AND json_type(schedule_json) IS 'object' AND json_type(schedule_json, '$.productIds') IS 'array' AND json_array_length(schedule_json, '$.productIds') BETWEEN 1 AND 100 AND ((json_extract(schedule_json, '$.trigger') = 'booking_received' AND json_extract(schedule_json, '$.delayMinutes') = 5) OR (json_extract(schedule_json, '$.trigger') IN ('check_in', 'check_out') AND ((json_type(schedule_json, '$.offsetHours') IS NULL AND json_type(schedule_json, '$.offsetDays') IS 'integer' AND json_extract(schedule_json, '$.offsetDays') BETWEEN -7 AND 7 AND json_extract(schedule_json, '$.localTime') GLOB '[0-2][0-9]:[0-5][0-9]' AND json_extract(schedule_json, '$.localTime') < '24:00') OR (json_type(schedule_json, '$.offsetDays') IS NULL AND json_type(schedule_json, '$.localTime') IS NULL AND json_type(schedule_json, '$.offsetHours') IS 'integer' AND json_extract(schedule_json, '$.offsetHours') BETWEEN -72 AND 72))))) IS TRUE),
	CONSTRAINT "message_templates_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (schedule_enabled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', schedule_enabled_at, '+0 days') IS schedule_enabled_at))
);
--> statement-breakpoint
INSERT INTO `__new_message_templates`("id", "organization_id", "title", "body", "schedule_json", "schedule_enabled_at", "version", "created_at", "updated_at") SELECT "id", "organization_id", "title", "body", "schedule_json", "schedule_enabled_at", "version", "created_at", "updated_at" FROM `message_templates`;
--> statement-breakpoint
-- Every existing plan is a stay's. stay_version is replaced by the guard on the record's own facts.
CREATE TABLE `__scheduled_guest_messages_rows` AS SELECT "id", "organization_id", "product_id", 'stay' AS "subject_type", "stay_id" AS "subject_id", "request_id", "template_id", "template_title", "template_version", "body", "due_at", "timezone", "status", "reason", "error_code", "error_field", "entry_id", "started_at", "sent_at", "created_at", "updated_at" FROM `scheduled_guest_messages`;
--> statement-breakpoint
DROP TABLE `scheduled_guest_messages`;
--> statement-breakpoint
DROP TABLE `message_templates`;
--> statement-breakpoint
ALTER TABLE `__new_message_templates` RENAME TO `message_templates`;
--> statement-breakpoint
CREATE INDEX `message_templates_org_updated_idx` ON `message_templates` (`organization_id`,`updated_at`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_templates_org_id_unique` ON `message_templates` (`organization_id`,`id`);
--> statement-breakpoint
CREATE TABLE `scheduled_guest_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`request_id` text,
	`template_id` text,
	`template_title` text NOT NULL,
	`template_version` integer NOT NULL,
	`body` text NOT NULL,
	`due_at` text,
	`timezone` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`error_code` text,
	`error_field` text,
	`entry_id` text,
	`started_at` text,
	`sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `activity_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`request_id`) REFERENCES `requests`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`template_id`) REFERENCES `message_templates`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scheduled_guest_messages_status_check" CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled', 'skipped')),
	CONSTRAINT "scheduled_guest_messages_due_check" CHECK(due_at IS NOT NULL OR status IN ('failed', 'skipped')),
	CONSTRAINT "scheduled_guest_messages_error_check" CHECK(status NOT IN ('failed', 'needs_review') OR (length(trim(reason)) > 0 AND length(trim(error_code)) > 0 AND length(trim(error_field)) > 0)),
	CONSTRAINT "scheduled_guest_messages_sent_check" CHECK(status <> 'sent' OR (entry_id IS NOT NULL AND sent_at IS NOT NULL)),
	CONSTRAINT "scheduled_guest_messages_sending_check" CHECK(status <> 'sending' OR started_at IS NOT NULL),
	CONSTRAINT "scheduled_guest_messages_text_check" CHECK(length(trim(template_title)) BETWEEN 1 AND 100 AND length(trim(body)) BETWEEN 1 AND 5000 AND template_version >= 1),
	CONSTRAINT "scheduled_guest_messages_subject_check" CHECK(subject_type IN ('stay', 'booking', 'reservation') AND (product_id IS NULL) = (subject_type = 'reservation') AND (template_id IS NOT NULL OR subject_type = 'stay')),
	CONSTRAINT "scheduled_guest_messages_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at) AND (started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 days') IS started_at) AND (sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sent_at, '+0 days') IS sent_at))
);
--> statement-breakpoint
INSERT INTO `scheduled_guest_messages` SELECT * FROM `__scheduled_guest_messages_rows`;
--> statement-breakpoint
DROP TABLE `__scheduled_guest_messages_rows`;
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_guest_messages_template_subject_unique` ON `scheduled_guest_messages` (`template_id`,`subject_type`,`subject_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_guest_messages_check_in_unique` ON `scheduled_guest_messages` (`subject_type`,`subject_id`) WHERE template_id IS NULL AND template_title = 'Check-in instructions';
--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_due_idx` ON `scheduled_guest_messages` (`status`,`due_at`);
--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_org_created_idx` ON `scheduled_guest_messages` (`organization_id`,`created_at`,`id`);
