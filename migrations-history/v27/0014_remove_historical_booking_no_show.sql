-- The 0012 migration verified that each historical no-show has its original
-- conversation event. Remove the redundant column from the bookings instant check.
-- Snapshot the inbound FK graph into plain tables before dropping it leaf-first.
-- Restore canonical tables, rows and indexes parent-first with FKs enforced.
CREATE TABLE "__copy_no_show_bookings" AS
SELECT rowid AS "__original_rowid", "id", "organization_id", "user_id", "product_id", "product_variant_id", "product_session_id", "location_id", "starts_at", "ends_at", "timezone", "party_size", "adults", "children", "infants", "party_size_is_minimum", "status", "cancelled_at", "cancellation_reason", "answers", "private_notes", "policy_json", "total_minor", "currency", "idempotency_key", "version", "channel", "owner", "provider", "external_booking_id", "channel_booking_id", "revision_id", "provider_updated_at", "overbooked", "booked_product_id", "received_at", "created_at", "updated_at", "website_source"
FROM "bookings";--> statement-breakpoint
CREATE TABLE "__copy_no_show_conversations" AS
SELECT rowid AS "__original_rowid", "id", "organization_id", "kind", "location_id", "booking_id", "user_id", "name", "is_group", "participants_key", "created_by_user_id", "blocked_at", "payload_json", "last_message_at", "created_at"
FROM "conversations";--> statement-breakpoint
CREATE TABLE "__copy_no_show_channel_threads" AS
SELECT rowid AS "__original_rowid", "provider", "external_thread_id", "organization_id", "product_id", "conversation_id", "external_booking_id", "provider_updated_at", "moved_from_thread_id", "created_at", "updated_at"
FROM "channel_threads";--> statement-breakpoint
CREATE TABLE "__copy_no_show_conversation_guest_invites" AS
SELECT rowid AS "__original_rowid", "id", "organization_id", "conversation_id", "email", "token_hash", "inviter_id", "expires_at", "accepted_at", "accepted_user_id"
FROM "conversation_guest_invites";--> statement-breakpoint
CREATE TABLE "__copy_no_show_messages" AS
SELECT rowid AS "__original_rowid", "id", "organization_id", "conversation_id", "sequence", "author_kind", "author_user_id", "channel", "body", "event_name", "payload_json", "dedupe_key", "occurred_at", "created_at"
FROM "messages";--> statement-breakpoint
CREATE TABLE "__copy_no_show_content_reports" AS
SELECT rowid AS "__original_rowid", "id", "organization_id", "reporter_user_id", "subject", "conversation_id", "message_id", "author_user_id", "reason", "excerpt", "blocked", "status", "resolved_by_user_id", "resolved_at", "created_at"
FROM "content_reports";--> statement-breakpoint
CREATE TABLE "__copy_no_show_conversation_participants" AS
SELECT rowid AS "__original_rowid", "conversation_id", "organization_id", "user_id", "last_read_message_id", "archived_at", "created_at", "role", "host_listing_id"
FROM "conversation_participants";--> statement-breakpoint
CREATE TABLE "__copy_no_show_guest_thread_deliveries" AS
SELECT rowid AS "__original_rowid", "id", "message_id", "activity_entry_id", "task_id", "channel", "provider", "purpose", "status", "provider_message_id", "email_json", "email_message_id", "error", "non_delivery_confirmed", "created_at", "updated_at"
FROM "guest_thread_deliveries";--> statement-breakpoint
CREATE TABLE "__copy_no_show_offline_payments" AS
SELECT rowid AS "__original_rowid", "id", "organization_id", "booking_id", "amount_minor", "currency", "method", "paid_on", "reference", "note", "idempotency_key", "created_at", "created_by"
FROM "offline_payments";--> statement-breakpoint
CREATE TABLE "__copy_no_show_review_requests" AS
SELECT rowid AS "__original_rowid", "id", "organization_id", "location_id", "booking_id", "token_hash", "token", "expires_at", "first_sent_at", "reminder_sent_at", "submitted_at", "clicked_at", "revoked_at", "send_count", "last_error", "user_id", "created_at", "updated_at"
FROM "review_requests";--> statement-breakpoint
CREATE TABLE "__copy_no_show_reviews" AS
SELECT rowid AS "__original_rowid", "id", "organization_id", "location_id", "booking_id", "user_id", "product_id", "author_name", "rating", "title", "content", "private_feedback", "google_review_id", "google_review_metadata", "owner_reply", "owner_reply_at", "helpful_count", "status", "source", "entered_by_user_id", "collection_method", "original_review_date", "original_reference", "publication_authorized", "ip_hash", "user_agent", "created_at", "updated_at"
FROM "reviews";--> statement-breakpoint
CREATE TABLE "__copy_no_show_review_category_ratings" AS
SELECT rowid AS "__original_rowid", "review_id", "category", "rating"
FROM "review_category_ratings";--> statement-breakpoint
CREATE TABLE "__copy_no_show_scheduled_guest_messages" AS
SELECT rowid AS "__original_rowid", "id", "organization_id", "product_id", "booking_id", "conversation_id", "task_id", "author_user_id", "template_id", "template_title", "template_version", "body", "due_at", "timezone", "status", "reason", "error_code", "error_field", "message_id", "started_at", "sent_at", "created_at", "updated_at"
FROM "scheduled_guest_messages";--> statement-breakpoint
CREATE TABLE "__copy_no_show_stay_nights" AS
SELECT rowid AS "__original_rowid", "organization_id", "product_id", "date", "booking_id"
FROM "stay_nights";--> statement-breakpoint
DROP TABLE "stay_nights";--> statement-breakpoint
DROP TABLE "scheduled_guest_messages";--> statement-breakpoint
DROP TABLE "review_category_ratings";--> statement-breakpoint
DROP TABLE "reviews";--> statement-breakpoint
DROP TABLE "review_requests";--> statement-breakpoint
DROP TABLE "offline_payments";--> statement-breakpoint
DROP TABLE "guest_thread_deliveries";--> statement-breakpoint
DROP TABLE "conversation_participants";--> statement-breakpoint
DROP TABLE "content_reports";--> statement-breakpoint
DROP TABLE "messages";--> statement-breakpoint
DROP TABLE "conversation_guest_invites";--> statement-breakpoint
DROP TABLE "channel_threads";--> statement-breakpoint
DROP TABLE "conversations";--> statement-breakpoint
DROP TABLE "bookings";--> statement-breakpoint
CREATE TABLE "bookings" (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text,
	`product_id` text NOT NULL,
	`product_variant_id` text NOT NULL,
	`product_session_id` text,
	`location_id` text,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`timezone` text NOT NULL,
	`party_size` integer NOT NULL,
	`adults` integer,
	`children` integer,
	`infants` integer,
	`party_size_is_minimum` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`cancelled_at` text,
	`cancellation_reason` text,
	`answers` text DEFAULT '[]' NOT NULL,
	`private_notes` text,
	`policy_json` text NOT NULL,
	`total_minor` integer,
	`currency` text,
	`idempotency_key` text,
	`version` integer DEFAULT 1 NOT NULL,
	`channel` text DEFAULT 'direct' NOT NULL,
	`owner` text DEFAULT 'app' NOT NULL,
	`provider` text,
	`external_booking_id` text,
	`channel_booking_id` text,
	`revision_id` text,
	`provider_updated_at` text,
	`overbooked` integer DEFAULT 0 NOT NULL,
	`booked_product_id` text,
	`website_source` text,
	`received_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`product_id`,`product_session_id`) REFERENCES `product_sessions`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`product_id`,`product_variant_id`) REFERENCES `product_variants`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`booked_product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bookings_policy_check" CHECK(json_valid(policy_json) AND json_type(policy_json) = 'object'),
	CONSTRAINT "bookings_answers_check" CHECK(json_valid(answers) AND json_type(answers) = 'array'),
	CONSTRAINT "bookings_status_check" CHECK(status IN ('pending', 'confirmed', 'cancelled') AND (status = 'cancelled' OR cancelled_at IS NULL)),
	CONSTRAINT "bookings_instants_check" CHECK((cancelled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at, '+0 days') IS cancelled_at) AND (received_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', received_at, '+0 days') IS received_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at),
	CONSTRAINT "bookings_window_check" CHECK((strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+0 days') IS starts_at OR (product_session_id IS NULL AND date(starts_at, '+0 days') IS starts_at))
		AND (strftime('%Y-%m-%dT%H:%M:%fZ', ends_at, '+0 days') IS ends_at OR (product_session_id IS NULL AND date(ends_at, '+0 days') IS ends_at))
		AND (length(starts_at) = 10 OR length(ends_at) = 10 OR ends_at > starts_at) AND substr(ends_at, 1, 10) >= substr(starts_at, 1, 10)
		AND timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'),
	CONSTRAINT "bookings_party_size_check" CHECK(party_size > 0 AND party_size_is_minimum IN (0, 1)
		AND ((adults IS NULL AND children IS NULL AND infants IS NULL) OR (adults >= 1 AND children >= 0 AND infants >= 0 AND adults + children = party_size))),
	CONSTRAINT "bookings_money_check" CHECK((total_minor IS NULL) = (currency IS NULL) AND (total_minor IS NULL OR (total_minor >= 0 AND length(currency) = 3 AND currency = upper(currency))) AND (product_session_id IS NOT NULL OR total_minor IS NOT NULL)),
	CONSTRAINT "bookings_channel_check" CHECK(channel IN ('airbnb', 'vrbo', 'booking_com', 'direct') AND (provider IS NULL OR provider = 'channex')),
	CONSTRAINT "bookings_owner_check" CHECK(owner IN ('app', 'channel') AND (owner = 'channel') = (provider IS NOT NULL AND external_booking_id IS NOT NULL)),
	CONSTRAINT "bookings_overbooked_check" CHECK(overbooked IN (0, 1) AND (overbooked = 0 OR owner = 'channel')),
	CONSTRAINT "bookings_booked_product_check" CHECK(booked_product_id IS NULL OR (booked_product_id <> product_id AND product_session_id IS NULL)),
	CONSTRAINT "bookings_version_check" CHECK(version >= 1)
);--> statement-breakpoint
INSERT INTO "bookings" (rowid, "id", "organization_id", "user_id", "product_id", "product_variant_id", "product_session_id", "location_id", "starts_at", "ends_at", "timezone", "party_size", "adults", "children", "infants", "party_size_is_minimum", "status", "cancelled_at", "cancellation_reason", "answers", "private_notes", "policy_json", "total_minor", "currency", "idempotency_key", "version", "channel", "owner", "provider", "external_booking_id", "channel_booking_id", "revision_id", "provider_updated_at", "overbooked", "booked_product_id", "received_at", "created_at", "updated_at", "website_source")
SELECT "__original_rowid", "id", "organization_id", "user_id", "product_id", "product_variant_id", "product_session_id", "location_id", "starts_at", "ends_at", "timezone", "party_size", "adults", "children", "infants", "party_size_is_minimum", "status", "cancelled_at", "cancellation_reason", "answers", "private_notes", "policy_json", "total_minor", "currency", "idempotency_key", "version", "channel", "owner", "provider", "external_booking_id", "channel_booking_id", "revision_id", "provider_updated_at", "overbooked", "booked_product_id", "received_at", "created_at", "updated_at", "website_source"
FROM "__copy_no_show_bookings";--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_idempotency_unique` ON `bookings` (`organization_id`,`idempotency_key`) WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_provider_booking_unique` ON `bookings` (`provider`,`external_booking_id`) WHERE external_booking_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_channel_reservation_unique` ON `bookings` (`organization_id`,`channel`,`channel_booking_id`) WHERE channel_booking_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `bookings_session_status_idx` ON `bookings` (`product_session_id`,`status`);--> statement-breakpoint
CREATE INDEX `bookings_org_starts_idx` ON `bookings` (`organization_id`,`starts_at`,`status`);--> statement-breakpoint
CREATE INDEX `bookings_product_window_idx` ON `bookings` (`product_id`,`starts_at`,`ends_at`);--> statement-breakpoint
CREATE INDEX `bookings_org_created_idx` ON `bookings` (`created_at`);--> statement-breakpoint
CREATE INDEX `bookings_org_user_idx` ON `bookings` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_org_id_unique` ON `bookings` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_org_product_id_unique` ON `bookings` (`organization_id`,`product_id`,`id`);--> statement-breakpoint
DROP TABLE "__copy_no_show_bookings";--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`location_id` text,
	`booking_id` text,
	`user_id` text,
	`name` text,
	`is_group` integer DEFAULT 0 NOT NULL,
	`participants_key` text,
	`created_by_user_id` text,
	`blocked_at` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`last_message_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversations_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', last_message_at, '+0 days') IS last_message_at AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND (blocked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', blocked_at, '+0 days') IS blocked_at)),
	CONSTRAINT "conversations_payload_check" CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
	CONSTRAINT "conversations_kind_check" CHECK((kind = 'team' AND user_id IS NULL AND blocked_at IS NULL AND payload_json = '{}' AND participants_key IS NOT NULL)
		OR (kind IN ('contact', 'booking') AND name IS NULL AND is_group = 0 AND participants_key IS NULL AND created_by_user_id IS NULL)),
	CONSTRAINT "conversations_contact_check" CHECK(kind <> 'contact' OR booking_id IS NULL),
	CONSTRAINT "conversations_guest_payload_check" CHECK(kind = 'team' OR (
    (json_type(payload_json, '$.participant') IS NULL AND json_type(payload_json, '$.guest.name') IS 'text'
      AND (json_type(payload_json, '$.guest.email') IS 'text' OR json_type(payload_json, '$.guest.email') IS 'null')
      AND (json_type(payload_json, '$.guest.phone') IS 'text' OR json_type(payload_json, '$.guest.phone') IS 'null')
      AND (kind = 'booking' OR json_type(payload_json, '$.guest.email') IS 'text' OR json_type(payload_json, '$.guest.phone') IS 'text'))
    OR (kind = 'booking' AND json_type(payload_json, '$.participant') IS 'object'
      AND json_extract(payload_json, '$.participant.kind') IS 'channel'
      AND json_type(payload_json, '$.participant.title') IS 'text' AND trim(json_extract(payload_json, '$.participant.title')) <> ''
      AND json_type(payload_json, '$.guest') IS 'object'
      AND (json_type(payload_json, '$.guest.name') IS 'text' OR json_type(payload_json, '$.guest.name') IS 'null')
      AND (json_type(payload_json, '$.guest.email') IS 'text' OR json_type(payload_json, '$.guest.email') IS 'null')
      AND (json_type(payload_json, '$.guest.phone') IS 'text' OR json_type(payload_json, '$.guest.phone') IS 'null'))
  )),
	CONSTRAINT "conversations_team_name_check" CHECK(name IS NULL OR (length(trim(name)) BETWEEN 1 AND 100 AND name = trim(name)))
);--> statement-breakpoint
INSERT INTO "conversations" (rowid, "id", "organization_id", "kind", "location_id", "booking_id", "user_id", "name", "is_group", "participants_key", "created_by_user_id", "blocked_at", "payload_json", "last_message_at", "created_at")
SELECT "__original_rowid", "id", "organization_id", "kind", "location_id", "booking_id", "user_id", "name", "is_group", "participants_key", "created_by_user_id", "blocked_at", "payload_json", "last_message_at", "created_at"
FROM "__copy_no_show_conversations";--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_guest_booking_unique` ON `conversations` (`booking_id`) WHERE kind = 'booking' AND booking_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `conversations_guest_email_idx` ON `conversations` (lower(payload_json ->> '$.guest.email'));--> statement-breakpoint
CREATE INDEX `conversations_org_activity_idx` ON `conversations` (`organization_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `conversations_org_booking_idx` ON `conversations` (`organization_id`,`booking_id`);--> statement-breakpoint
CREATE INDEX `conversations_org_user_idx` ON `conversations` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_participants_unique` ON `conversations` (`organization_id`,`participants_key`) WHERE participants_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_scope_id_unique` ON `conversations` (`organization_id`,`id`);--> statement-breakpoint
CREATE INDEX `conversations_user_activity_idx` ON `conversations` (`user_id`,`last_message_at`);--> statement-breakpoint
DROP TABLE "__copy_no_show_conversations";--> statement-breakpoint
CREATE TABLE `channel_threads` (
	`provider` text NOT NULL,
	`external_thread_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`external_booking_id` text,
	`provider_updated_at` text NOT NULL,
	`moved_from_thread_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`provider`, `external_thread_id`),
	FOREIGN KEY (`organization_id`,`conversation_id`) REFERENCES `conversations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`,`provider`) REFERENCES `product_channel_mappings`(`product_id`,`provider`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "channel_threads_provider_check" CHECK(provider = 'channex'),
	CONSTRAINT "channel_threads_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);--> statement-breakpoint
INSERT INTO "channel_threads" (rowid, "provider", "external_thread_id", "organization_id", "product_id", "conversation_id", "external_booking_id", "provider_updated_at", "moved_from_thread_id", "created_at", "updated_at")
SELECT "__original_rowid", "provider", "external_thread_id", "organization_id", "product_id", "conversation_id", "external_booking_id", "provider_updated_at", "moved_from_thread_id", "created_at", "updated_at"
FROM "__copy_no_show_channel_threads";--> statement-breakpoint
CREATE UNIQUE INDEX `channel_threads_booking_unique` ON `channel_threads` (`provider`,`external_booking_id`) WHERE external_booking_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `channel_threads_conversation_unique` ON `channel_threads` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `channel_threads_org_idx` ON `channel_threads` (`organization_id`);--> statement-breakpoint
DROP TABLE "__copy_no_show_channel_threads";--> statement-breakpoint
CREATE TABLE `conversation_guest_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`inviter_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`accepted_user_id` text,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`accepted_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`conversation_id`) REFERENCES `conversations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO "conversation_guest_invites" (rowid, "id", "organization_id", "conversation_id", "email", "token_hash", "inviter_id", "expires_at", "accepted_at", "accepted_user_id")
SELECT "__original_rowid", "id", "organization_id", "conversation_id", "email", "token_hash", "inviter_id", "expires_at", "accepted_at", "accepted_user_id"
FROM "__copy_no_show_conversation_guest_invites";--> statement-breakpoint
CREATE INDEX `conversation_guest_invites_conversation_idx` ON `conversation_guest_invites` (`conversation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_guest_invites_token_hash_unique` ON `conversation_guest_invites` (`token_hash`);--> statement-breakpoint
DROP TABLE "__copy_no_show_conversation_guest_invites";--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`author_kind` text NOT NULL,
	`author_user_id` text,
	`channel` text,
	`body` text,
	`event_name` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`dedupe_key` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`conversation_id`) REFERENCES `conversations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "messages_sequence_check" CHECK(sequence > 0),
	CONSTRAINT "messages_payload_check" CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
	CONSTRAINT "messages_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+0 days') IS occurred_at AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);--> statement-breakpoint
INSERT INTO "messages" (rowid, "id", "organization_id", "conversation_id", "sequence", "author_kind", "author_user_id", "channel", "body", "event_name", "payload_json", "dedupe_key", "occurred_at", "created_at")
SELECT "__original_rowid", "id", "organization_id", "conversation_id", "sequence", "author_kind", "author_user_id", "channel", "body", "event_name", "payload_json", "dedupe_key", "occurred_at", "created_at"
FROM "__copy_no_show_messages";--> statement-breakpoint
CREATE INDEX `messages_conversation_author_idx` ON `messages` (`conversation_id`,`author_kind`);--> statement-breakpoint
CREATE INDEX `messages_conversation_event_idx` ON `messages` (`conversation_id`,`event_name`,`author_kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_sequence_unique` ON `messages` (`conversation_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_dedupe_key_unique` ON `messages` (`dedupe_key`);--> statement-breakpoint
DROP TABLE "__copy_no_show_messages";--> statement-breakpoint
CREATE TABLE `content_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`reporter_user_id` text,
	`subject` text NOT NULL,
	`conversation_id` text,
	`message_id` text,
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
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "content_reports_subject_check" CHECK((subject = 'conversation' AND message_id IS NULL) OR (subject = 'message' AND conversation_id IS NULL AND blocked = 0)),
	CONSTRAINT "content_reports_reason_check" CHECK(length(reason) BETWEEN 1 AND 1000 AND reason = trim(reason)),
	CONSTRAINT "content_reports_resolution_check" CHECK((status = 'open') = (resolved_at IS NULL)),
	CONSTRAINT "content_reports_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND (resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at, '+0 days') IS resolved_at))
);--> statement-breakpoint
INSERT INTO "content_reports" (rowid, "id", "organization_id", "reporter_user_id", "subject", "conversation_id", "message_id", "author_user_id", "reason", "excerpt", "blocked", "status", "resolved_by_user_id", "resolved_at", "created_at")
SELECT "__original_rowid", "id", "organization_id", "reporter_user_id", "subject", "conversation_id", "message_id", "author_user_id", "reason", "excerpt", "blocked", "status", "resolved_by_user_id", "resolved_at", "created_at"
FROM "__copy_no_show_content_reports";--> statement-breakpoint
CREATE INDEX `content_reports_conversation_idx` ON `content_reports` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `content_reports_message_idx` ON `content_reports` (`message_id`);--> statement-breakpoint
CREATE INDEX `content_reports_status_created_idx` ON `content_reports` (`status`,`created_at`);--> statement-breakpoint
DROP TABLE "__copy_no_show_content_reports";--> statement-breakpoint
CREATE TABLE `conversation_participants` (
	`conversation_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`last_read_message_id` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `role` text, `host_listing_id` text REFERENCES products(id) ON DELETE CASCADE,
	PRIMARY KEY(`conversation_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_read_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`conversation_id`) REFERENCES `conversations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_participants_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', archived_at, '+0 days') IS archived_at))
);--> statement-breakpoint
INSERT INTO "conversation_participants" (rowid, "conversation_id", "organization_id", "user_id", "last_read_message_id", "archived_at", "created_at", "role", "host_listing_id")
SELECT "__original_rowid", "conversation_id", "organization_id", "user_id", "last_read_message_id", "archived_at", "created_at", "role", "host_listing_id"
FROM "__copy_no_show_conversation_participants";--> statement-breakpoint
CREATE INDEX `conversation_participants_user_idx` ON `conversation_participants` (`user_id`,`organization_id`);--> statement-breakpoint
DROP TABLE "__copy_no_show_conversation_participants";--> statement-breakpoint
CREATE TABLE `guest_thread_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`activity_entry_id` text,
	`task_id` text,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_message_id` text,
	`email_json` text,
	`email_message_id` text,
	`error` text,
	`non_delivery_confirmed` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`activity_entry_id`) REFERENCES `activity_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "guest_thread_deliveries_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "guest_thread_deliveries_subject_check" CHECK((message_id IS NOT NULL) + (activity_entry_id IS NOT NULL) + (task_id IS NOT NULL) = 1),
	CONSTRAINT "guest_thread_deliveries_provider_check" CHECK((channel = 'email' AND provider IN ('resend', 'log_only')) OR (channel = 'whatsapp' AND provider IN ('meta', 'log_only')) OR (channel = 'airbnb' AND provider = 'channex') OR (channel = 'push' AND provider IN ('apns', 'web_push')))
);--> statement-breakpoint
INSERT INTO "guest_thread_deliveries" (rowid, "id", "message_id", "activity_entry_id", "task_id", "channel", "provider", "purpose", "status", "provider_message_id", "email_json", "email_message_id", "error", "non_delivery_confirmed", "created_at", "updated_at")
SELECT "__original_rowid", "id", "message_id", "activity_entry_id", "task_id", "channel", "provider", "purpose", "status", "provider_message_id", "email_json", "email_message_id", "error", "non_delivery_confirmed", "created_at", "updated_at"
FROM "__copy_no_show_guest_thread_deliveries";--> statement-breakpoint
CREATE INDEX `guest_thread_deliveries_activity_idx` ON `guest_thread_deliveries` (`activity_entry_id`);--> statement-breakpoint
CREATE INDEX `guest_thread_deliveries_message_status_idx` ON `guest_thread_deliveries` (`message_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `guest_thread_deliveries_provider_message_unique` ON `guest_thread_deliveries` (`provider`,`provider_message_id`) WHERE provider_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `guest_thread_deliveries_task_idx` ON `guest_thread_deliveries` (`task_id`);--> statement-breakpoint
DROP TABLE "__copy_no_show_guest_thread_deliveries";--> statement-breakpoint
CREATE TABLE `offline_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`booking_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`method` text NOT NULL,
	`paid_on` text NOT NULL,
	`reference` text,
	`note` text,
	`idempotency_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "offline_payments_amount_check" CHECK(amount_minor <> 0 AND length(currency) = 3 AND currency = upper(currency)),
	CONSTRAINT "offline_payments_method_check" CHECK(method IN ('cash', 'bank_transfer', 'card_external', 'other')),
	CONSTRAINT "offline_payments_paid_on_check" CHECK(date(paid_on, '+0 days') IS paid_on),
	CONSTRAINT "offline_payments_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);--> statement-breakpoint
INSERT INTO "offline_payments" (rowid, "id", "organization_id", "booking_id", "amount_minor", "currency", "method", "paid_on", "reference", "note", "idempotency_key", "created_at", "created_by")
SELECT "__original_rowid", "id", "organization_id", "booking_id", "amount_minor", "currency", "method", "paid_on", "reference", "note", "idempotency_key", "created_at", "created_by"
FROM "__copy_no_show_offline_payments";--> statement-breakpoint
CREATE INDEX `offline_payments_booking_idx` ON `offline_payments` (`booking_id`,`paid_on`);--> statement-breakpoint
CREATE UNIQUE INDEX `offline_payments_idempotency_unique` ON `offline_payments` (`organization_id`,`idempotency_key`);--> statement-breakpoint
DROP TABLE "__copy_no_show_offline_payments";--> statement-breakpoint
CREATE TABLE `review_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`location_id` text,
	`booking_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token` text,
	`expires_at` text NOT NULL,
	`first_sent_at` text,
	`reminder_sent_at` text,
	`submitted_at` text,
	`clicked_at` text,
	`revoked_at` text,
	`send_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `business_locations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_requests_instants_check" CHECK((expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at) AND (first_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', first_sent_at, '+0 days') IS first_sent_at) AND (reminder_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', reminder_sent_at, '+0 days') IS reminder_sent_at) AND (submitted_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', submitted_at, '+0 days') IS submitted_at) AND (clicked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', clicked_at, '+0 days') IS clicked_at) AND (revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at, '+0 days') IS revoked_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at))
);--> statement-breakpoint
INSERT INTO "review_requests" (rowid, "id", "organization_id", "location_id", "booking_id", "token_hash", "token", "expires_at", "first_sent_at", "reminder_sent_at", "submitted_at", "clicked_at", "revoked_at", "send_count", "last_error", "user_id", "created_at", "updated_at")
SELECT "__original_rowid", "id", "organization_id", "location_id", "booking_id", "token_hash", "token", "expires_at", "first_sent_at", "reminder_sent_at", "submitted_at", "clicked_at", "revoked_at", "send_count", "last_error", "user_id", "created_at", "updated_at"
FROM "__copy_no_show_review_requests";--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_requests_active_booking_unique` ON `review_requests` (`booking_id`) WHERE revoked_at IS NULL AND submitted_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_review_requests_send_due` ON `review_requests` (`organization_id`,`first_sent_at`,`reminder_sent_at`,`submitted_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `review_requests_organization_id_idx` ON `review_requests` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_requests_submitted_booking_unique` ON `review_requests` (`organization_id`,`booking_id`) WHERE submitted_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `review_requests_token_hash_unique` ON `review_requests` (`token_hash`);--> statement-breakpoint
DROP TABLE "__copy_no_show_review_requests";--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`location_id` text,
	`booking_id` text,
	`user_id` text,
	`product_id` text,
	`author_name` text,
	`rating` integer NOT NULL,
	`title` text,
	`content` text,
	`private_feedback` text,
	`google_review_id` text,
	`google_review_metadata` text,
	`owner_reply` text,
	`owner_reply_at` text,
	`helpful_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text DEFAULT 'direct' NOT NULL,
	`entered_by_user_id` text,
	`collection_method` text,
	`original_review_date` text,
	`original_reference` text,
	`publication_authorized` integer DEFAULT 0 NOT NULL,
	`ip_hash` text,
	`user_agent` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `business_locations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`entered_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reviews_instants_check" CHECK((owner_reply_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', owner_reply_at, '+0 days') IS owner_reply_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "reviews_google_review_metadata_check" CHECK(google_review_metadata IS NULL OR (json_valid(google_review_metadata) AND json_type(google_review_metadata) IS 'object')),
	CONSTRAINT "reviews_rating_check" CHECK(rating BETWEEN 1 AND 5),
	CONSTRAINT "reviews_product_scope_check" CHECK(product_id IS NULL OR organization_id IS NOT NULL),
	CONSTRAINT "reviews_owner_entered_provenance_check" CHECK(source != 'owner_entered' OR (organization_id IS NOT NULL AND location_id IS NULL AND entered_by_user_id IS NOT NULL AND collection_method IS NOT NULL AND publication_authorized = 1))
);--> statement-breakpoint
INSERT INTO "reviews" (rowid, "id", "organization_id", "location_id", "booking_id", "user_id", "product_id", "author_name", "rating", "title", "content", "private_feedback", "google_review_id", "google_review_metadata", "owner_reply", "owner_reply_at", "helpful_count", "status", "source", "entered_by_user_id", "collection_method", "original_review_date", "original_reference", "publication_authorized", "ip_hash", "user_agent", "created_at", "updated_at")
SELECT "__original_rowid", "id", "organization_id", "location_id", "booking_id", "user_id", "product_id", "author_name", "rating", "title", "content", "private_feedback", "google_review_id", "google_review_metadata", "owner_reply", "owner_reply_at", "helpful_count", "status", "source", "entered_by_user_id", "collection_method", "original_review_date", "original_reference", "publication_authorized", "ip_hash", "user_agent", "created_at", "updated_at"
FROM "__copy_no_show_reviews";--> statement-breakpoint
CREATE INDEX `idx_reviews_location_status` ON `reviews` (`location_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reviews_org_status` ON `reviews` (`status`,`created_at`) WHERE location_id IS NULL;--> statement-breakpoint
CREATE INDEX `idx_reviews_product_status_created` ON `reviews` (`product_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `reviews_booking_idx` ON `reviews` (`booking_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_google_review_scope_unique` ON `reviews` (`organization_id`,`location_id`,`google_review_id`);--> statement-breakpoint
CREATE INDEX `reviews_org_user_idx` ON `reviews` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `reviews_organization_id_idx` ON `reviews` (`organization_id`);--> statement-breakpoint
DROP TABLE "__copy_no_show_reviews";--> statement-breakpoint
CREATE TABLE `review_category_ratings` (
	`review_id` text NOT NULL,
	`category` text NOT NULL,
	`rating` integer NOT NULL,
	PRIMARY KEY(`review_id`, `category`),
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_category_ratings_rating_check" CHECK(rating BETWEEN 1 AND 5),
	CONSTRAINT "review_category_ratings_category_check" CHECK(category IN ('food', 'service', 'atmosphere', 'expertise', 'organization', 'enjoyment', 'listening', 'explanation', 'next_steps', 'cleanliness', 'accuracy', 'check_in', 'communication'))
);--> statement-breakpoint
INSERT INTO "review_category_ratings" (rowid, "review_id", "category", "rating")
SELECT "__original_rowid", "review_id", "category", "rating"
FROM "__copy_no_show_review_category_ratings";--> statement-breakpoint
DROP TABLE "__copy_no_show_review_category_ratings";--> statement-breakpoint
CREATE TABLE "scheduled_guest_messages" (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text,
	`booking_id` text,
	`conversation_id` text,
	`task_id` text,
	`author_user_id` text,
	`template_id` text,
	`template_title` text,
	`template_version` integer,
	`body` text NOT NULL,
	`due_at` text,
	`timezone` text,
	`status` text NOT NULL,
	`reason` text,
	`error_code` text,
	`error_field` text,
	`message_id` text,
	`started_at` text,
	`sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`conversation_id`) REFERENCES `conversations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`template_id`) REFERENCES `message_templates`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scheduled_guest_messages_kind_check" CHECK((task_id IS NULL AND author_user_id IS NULL AND conversation_id IS NULL AND product_id IS NOT NULL AND booking_id IS NOT NULL AND template_title IS NOT NULL AND template_version IS NOT NULL AND timezone IS NOT NULL) OR (task_id IS NULL AND author_user_id IS NOT NULL AND conversation_id IS NOT NULL AND due_at IS NOT NULL AND status <> 'skipped' AND product_id IS NULL AND booking_id IS NULL AND template_id IS NULL AND template_title IS NULL AND template_version IS NULL AND timezone IS NULL) OR (task_id IS NOT NULL AND author_user_id IS NULL AND due_at IS NOT NULL AND status <> 'skipped' AND product_id IS NULL AND booking_id IS NULL AND template_id IS NULL AND template_title IS NULL AND template_version IS NULL AND timezone IS NOT NULL)),
	CONSTRAINT "scheduled_guest_messages_status_check" CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled', 'skipped')),
	CONSTRAINT "scheduled_guest_messages_due_check" CHECK(due_at IS NOT NULL OR status IN ('failed', 'skipped')),
	CONSTRAINT "scheduled_guest_messages_error_check" CHECK((status NOT IN ('failed', 'needs_review') OR (length(trim(reason)) > 0 AND length(trim(error_code)) > 0 AND length(trim(error_field)) > 0)) IS TRUE),
	CONSTRAINT "scheduled_guest_messages_sent_check" CHECK(status <> 'sent' OR (sent_at IS NOT NULL AND (message_id IS NOT NULL OR (task_id IS NOT NULL AND conversation_id IS NULL)))),
	CONSTRAINT "scheduled_guest_messages_sending_check" CHECK(status <> 'sending' OR started_at IS NOT NULL),
	CONSTRAINT "scheduled_guest_messages_text_check" CHECK(length(trim(body)) BETWEEN 1 AND 5000 AND (template_title IS NULL OR length(trim(template_title)) BETWEEN 1 AND 100) AND (template_version IS NULL OR template_version >= 1)),
	CONSTRAINT "scheduled_guest_messages_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at) AND (started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 days') IS started_at) AND (sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sent_at, '+0 days') IS sent_at))
);--> statement-breakpoint
INSERT INTO "scheduled_guest_messages" (rowid, "id", "organization_id", "product_id", "booking_id", "conversation_id", "task_id", "author_user_id", "template_id", "template_title", "template_version", "body", "due_at", "timezone", "status", "reason", "error_code", "error_field", "message_id", "started_at", "sent_at", "created_at", "updated_at")
SELECT "__original_rowid", "id", "organization_id", "product_id", "booking_id", "conversation_id", "task_id", "author_user_id", "template_id", "template_title", "template_version", "body", "due_at", "timezone", "status", "reason", "error_code", "error_field", "message_id", "started_at", "sent_at", "created_at", "updated_at"
FROM "__copy_no_show_scheduled_guest_messages";--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_author_idx` ON `scheduled_guest_messages` (`author_user_id`);--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_booking_idx` ON `scheduled_guest_messages` (`booking_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_guest_messages_check_in_unique` ON `scheduled_guest_messages` (`booking_id`) WHERE template_id IS NULL AND template_title = 'Check-in instructions';--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_conversation_idx` ON `scheduled_guest_messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_due_idx` ON `scheduled_guest_messages` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_org_created_idx` ON `scheduled_guest_messages` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_guest_messages_template_booking_unique` ON `scheduled_guest_messages` (`template_id`,`booking_id`);--> statement-breakpoint
DROP TABLE "__copy_no_show_scheduled_guest_messages";--> statement-breakpoint
CREATE TABLE "stay_nights" (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`date` text NOT NULL,
	`booking_id` text NOT NULL,
	PRIMARY KEY(`product_id`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stay_nights_date_check" CHECK(date(date, '+0 days') IS date)
);--> statement-breakpoint
INSERT INTO "stay_nights" (rowid, "organization_id", "product_id", "date", "booking_id")
SELECT "__original_rowid", "organization_id", "product_id", "date", "booking_id"
FROM "__copy_no_show_stay_nights";--> statement-breakpoint
CREATE INDEX `stay_nights_booking_idx` ON `stay_nights` (`booking_id`);--> statement-breakpoint
DROP TABLE "__copy_no_show_stay_nights";
