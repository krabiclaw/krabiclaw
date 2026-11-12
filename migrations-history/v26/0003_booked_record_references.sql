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
--> statement-breakpoint
-- team_threads is referenced by team_messages and team_thread_members, and
-- team_messages by content_reports. Their rows are held in plain tables and the
-- children dropped leaf first, so team_threads is unreferenced when it is
-- rebuilt; the children are then recreated with their own definitions and rows.
CREATE TABLE `__content_reports_rows` AS SELECT * FROM `content_reports`;
--> statement-breakpoint
CREATE TABLE `__team_messages_rows` AS SELECT * FROM `team_messages`;
--> statement-breakpoint
CREATE TABLE `__team_thread_members_rows` AS SELECT * FROM `team_thread_members`;
--> statement-breakpoint
DROP TABLE `content_reports`;
--> statement-breakpoint
DROP TABLE `team_messages`;
--> statement-breakpoint
DROP TABLE `team_thread_members`;
--> statement-breakpoint
CREATE TABLE `__new_team_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`location_id` text,
	`created_by_user_id` text,
	`name` text,
	`is_group` integer DEFAULT 0 NOT NULL,
	`participants_key` text NOT NULL,
	`last_message_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "team_threads_subject_check" CHECK((subject_type IS NULL) = (subject_id IS NULL) AND (subject_type IS NULL OR subject_type IN ('stay', 'booking', 'reservation'))),
	CONSTRAINT "team_threads_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', last_message_at, '+0 days') IS last_message_at AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);
--> statement-breakpoint
-- A conversation's stay or booking becomes its booked-record reference.
INSERT INTO `__new_team_threads`("id", "organization_id", "subject_type", "subject_id", "location_id", "created_by_user_id", "name", "is_group", "participants_key", "last_message_at", "created_at") SELECT "id", "organization_id", CASE WHEN "stay_id" IS NOT NULL THEN 'stay' WHEN "booking_id" IS NOT NULL THEN 'booking' END, COALESCE("stay_id", "booking_id"), "location_id", "created_by_user_id", "name", "is_group", "participants_key", "last_message_at", "created_at" FROM `team_threads`;
--> statement-breakpoint
DROP TABLE `team_threads`;
--> statement-breakpoint
ALTER TABLE `__new_team_threads` RENAME TO `team_threads`;
--> statement-breakpoint
CREATE UNIQUE INDEX `team_threads_participants_unique` ON `team_threads` (`organization_id`,`participants_key`);
--> statement-breakpoint
CREATE INDEX `team_threads_org_activity_idx` ON `team_threads` (`organization_id`,`last_message_at`);
--> statement-breakpoint
CREATE INDEX `team_threads_org_subject_idx` ON `team_threads` (`organization_id`,`subject_type`,`subject_id`);
--> statement-breakpoint
CREATE INDEX `team_threads_org_location_idx` ON `team_threads` (`organization_id`,`location_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_threads_org_id_unique` ON `team_threads` (`organization_id`,`id`);
--> statement-breakpoint
CREATE TABLE `team_thread_members` (
	`thread_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`member_id` text NOT NULL,
	`last_read_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`thread_id`, `member_id`),
	FOREIGN KEY (`organization_id`,`thread_id`) REFERENCES `team_threads`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`,`organization_id`) REFERENCES `member`(`id`,`organizationId`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "team_thread_members_instants_check" CHECK((last_read_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_read_at, '+0 days') IS last_read_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);
--> statement-breakpoint
INSERT INTO `team_thread_members`("thread_id", "organization_id", "member_id", "last_read_at", "created_at") SELECT "thread_id", "organization_id", "member_id", "last_read_at", "created_at" FROM `__team_thread_members_rows`;
--> statement-breakpoint
DROP TABLE `__team_thread_members_rows`;
--> statement-breakpoint
CREATE INDEX `team_thread_members_member_idx` ON `team_thread_members` (`member_id`);
--> statement-breakpoint
CREATE TABLE `team_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`sender_user_id` text,
	`body` text NOT NULL,
	`automatic` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`sender_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`thread_id`) REFERENCES `team_threads`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "team_messages_body_check" CHECK(length(body) <= 5000 AND body = trim(body)),
	CONSTRAINT "team_messages_idempotency_check" CHECK(length(idempotency_key) BETWEEN 1 AND 200),
	CONSTRAINT "team_messages_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);
--> statement-breakpoint
INSERT INTO `team_messages`("id", "organization_id", "thread_id", "sender_user_id", "body", "automatic", "idempotency_key", "request_hash", "created_at") SELECT "id", "organization_id", "thread_id", "sender_user_id", "body", "automatic", "idempotency_key", "request_hash", "created_at" FROM `__team_messages_rows`;
--> statement-breakpoint
DROP TABLE `__team_messages_rows`;
--> statement-breakpoint
CREATE UNIQUE INDEX `team_messages_thread_idempotency_unique` ON `team_messages` (`thread_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `team_messages_thread_created_idx` ON `team_messages` (`thread_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_messages_org_id_unique` ON `team_messages` (`organization_id`,`id`);
--> statement-breakpoint
CREATE TABLE `content_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`reporter_user_id` text,
	`subject` text NOT NULL,
	`request_id` text,
	`team_message_id` text,
	`author_user_id` text,
	`reason` text NOT NULL,
	`excerpt` text NOT NULL,
	`blocked` integer NOT NULL,
	`status` text NOT NULL,
	`resolved_by_user_id` text,
	`resolved_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reporter_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_message_id`) REFERENCES `team_messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "content_reports_subject_check" CHECK((subject = 'guest_thread' AND team_message_id IS NULL) OR (subject = 'team_message' AND request_id IS NULL AND blocked = 0)),
	CONSTRAINT "content_reports_reason_check" CHECK(length(reason) BETWEEN 1 AND 1000 AND reason = trim(reason)),
	CONSTRAINT "content_reports_resolution_check" CHECK((status = 'open') = (resolved_at IS NULL)),
	CONSTRAINT "content_reports_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND (resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at, '+0 days') IS resolved_at))
);
--> statement-breakpoint
INSERT INTO `content_reports`("id", "organization_id", "reporter_user_id", "subject", "request_id", "team_message_id", "author_user_id", "reason", "excerpt", "blocked", "status", "resolved_by_user_id", "resolved_at", "created_at") SELECT "id", "organization_id", "reporter_user_id", "subject", "request_id", "team_message_id", "author_user_id", "reason", "excerpt", "blocked", "status", "resolved_by_user_id", "resolved_at", "created_at" FROM `__content_reports_rows`;
--> statement-breakpoint
DROP TABLE `__content_reports_rows`;
--> statement-breakpoint
CREATE INDEX `content_reports_status_created_idx` ON `content_reports` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `content_reports_request_idx` ON `content_reports` (`request_id`);
--> statement-breakpoint
CREATE INDEX `content_reports_team_message_idx` ON `content_reports` (`team_message_id`);
