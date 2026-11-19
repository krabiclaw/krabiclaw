CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`userId`);--> statement-breakpoint
CREATE TABLE `activity_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`location_id` text,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`body` text,
	`event_name` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`dedupe_key` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `business_locations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "activity_entries_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+0 days') IS occurred_at AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at),
	CONSTRAINT "activity_entries_payload_check" CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_entries_dedupe_key_unique` ON `activity_entries` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `activity_entries_org_created_idx` ON `activity_entries` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `airbnb_sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`product_id` text,
	`action` text NOT NULL,
	`details` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`requested_by` text,
	`last_error_code` text,
	`last_error` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "airbnb_sync_jobs_action_check" CHECK(action IN ('sync', 'stop')),
	CONSTRAINT "airbnb_sync_jobs_state_check" CHECK(state IN ('pending', 'done', 'failed')),
	CONSTRAINT "airbnb_sync_jobs_error_check" CHECK(state <> 'failed' OR (last_error_code IS NOT NULL AND last_error IS NOT NULL)),
	CONSTRAINT "airbnb_sync_jobs_details_check" CHECK(details IS NULL OR (action = 'sync' AND json_valid(details) AND json_type(details) = 'object'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `airbnb_sync_jobs_listing_unique` ON `airbnb_sync_jobs` (`organization_id`,`listing_id`);--> statement-breakpoint
CREATE TABLE `analytics_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`organization_id` text,
	`location_id` text,
	`session_id` text,
	`visitor_id` text,
	`page_path` text,
	`duration_seconds` integer,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `business_locations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "analytics_events_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (received_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', received_at, '+0 days') IS received_at)),
	CONSTRAINT "analytics_events_payload_check" CHECK(json_valid(payload_json) AND json_type(payload_json) IS 'object'),
	CONSTRAINT "analytics_events_shape_check" CHECK((kind = 'pageview' AND page_path IS NOT NULL) OR (kind IN ('conversion', 'interaction') AND organization_id IS NOT NULL AND duration_seconds IS NULL
    AND json_type(payload_json, '$.event_name') IS 'text' AND length(payload_json ->> '$.event_name') BETWEEN 1 AND 64
    AND (payload_json ->> '$.event_name') GLOB '[a-z]*' AND (payload_json ->> '$.event_name') NOT GLOB '*[^a-z0-9_]*'
    AND json_type(payload_json, '$.stage') IS 'text' AND (payload_json ->> '$.stage') IN ('schedule_navigation', 'external_booking_handoff', 'submitted', 'external_handoff', 'completed', 'viewed', 'started', 'occurred')
    AND ((session_id IS NULL) = (visitor_id IS NULL))
    AND ((json_type(payload_json, '$.attribution.source') IS 'text' AND json_type(payload_json, '$.attribution.medium') IS 'text' AND json_type(payload_json, '$.attributed_at') IS 'text')
      OR (json_type(payload_json, '$.attribution') IS 'null' AND json_type(payload_json, '$.attributed_at') IS 'null'))))
);
--> statement-breakpoint
CREATE INDEX `analytics_events_org_kind_created_idx` ON `analytics_events` (`organization_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `analytics_events_org_received_idx` ON `analytics_events` (`organization_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `analytics_events_org_session_idx` ON `analytics_events` (`organization_id`,`kind`,`session_id`);--> statement-breakpoint
CREATE INDEX `analytics_events_org_visitor_idx` ON `analytics_events` (`organization_id`,`kind`,`visitor_id`);--> statement-breakpoint
CREATE INDEX `analytics_events_conversion_name_idx` ON `analytics_events` (`kind`,(payload_json ->> '$.event_name'),`created_at`);--> statement-breakpoint
CREATE INDEX `analytics_events_conversion_entity_idx` ON `analytics_events` (`organization_id`,(payload_json ->> '$.entity_type'),(payload_json ->> '$.entity_id')) WHERE kind IN ('conversion', 'interaction');--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_events_conversion_entity_unique` ON `analytics_events` (`organization_id`,(payload_json ->> '$.event_name'),(payload_json ->> '$.entity_type'),(payload_json ->> '$.entity_id')) WHERE kind = 'conversion' AND (payload_json ->> '$.entity_type') IS NOT NULL AND (payload_json ->> '$.entity_id') IS NOT NULL AND (payload_json ->> '$.event_name') IN ('contact_submit', 'reservation_submit', 'booking_submit', 'sign_up', 'onboarding_complete', 'purchase', 'refund', 'payment_paid', 'payment_refunded', 'booking_confirmed', 'booking_declined', 'booking_cancelled', 'booking_change_accepted', 'booking_change_declined');--> statement-breakpoint
CREATE TABLE `analytics_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`organization_id` text NOT NULL,
	`date` text NOT NULL,
	`key` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "analytics_summaries_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "analytics_summaries_payload_check" CHECK(json_valid(payload_json) AND json_type(payload_json) IS 'object'),
	CONSTRAINT "analytics_summaries_scope_check" CHECK((kind = 'session' AND date = ''
    AND json_type(payload_json, '$.visitor_id') IS 'text' AND json_type(payload_json, '$.started_at') IS 'text'
    AND json_type(payload_json, '$.last_seen_at') IS 'text' AND json_type(payload_json, '$.landing_path') IS 'text'
    AND json_type(payload_json, '$.attribution.source') IS 'text' AND json_type(payload_json, '$.attribution.medium') IS 'text'
    AND json_type(payload_json, '$.duration_seconds') IS 'integer' AND (payload_json ->> '$.duration_seconds') >= 0)
    OR (kind != 'session' AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND json_type(payload_json, '$.page_views') IS 'integer' AND (payload_json ->> '$.page_views') >= 0)),
	CONSTRAINT "analytics_summaries_day_metrics_check" CHECK(kind != 'organization_day' OR (key = ''
    AND json_type(payload_json, '$.unique_sessions') IS 'integer' AND (payload_json ->> '$.unique_sessions') >= 0
    AND json_type(payload_json, '$.unique_visitors') IS 'integer' AND (payload_json ->> '$.unique_visitors') >= 0
    AND json_type(payload_json, '$.returning_visitors') IS 'integer' AND (payload_json ->> '$.returning_visitors') >= 0
    AND json_type(payload_json, '$.avg_session_duration') IN ('integer', 'real') AND (payload_json ->> '$.avg_session_duration') >= 0
    AND json_type(payload_json, '$.pages_per_session') IN ('integer', 'real') AND (payload_json ->> '$.pages_per_session') >= 0
    AND json_type(payload_json, '$.avg_session_duration') IS NOT NULL AND json_type(payload_json, '$.pages_per_session') IS NOT NULL)),
	CONSTRAINT "analytics_summaries_dimension_key_check" CHECK(kind != 'dimension_day' OR (json_valid(key) AND json_type(key) IS 'array' AND json_array_length(key) = 3
    AND json_type(key, '$[0]') IS 'text' AND (key ->> '$[0]') IN ('country', 'city', 'device', 'referrer')
    AND json_type(key, '$[1]') IS 'text' AND json_type(key, '$[2]') IS 'text'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_summaries_grain_unique` ON `analytics_summaries` (`organization_id`,`kind`,`date`,`key`);--> statement-breakpoint
CREATE INDEX `analytics_summaries_session_started_idx` ON `analytics_summaries` (`organization_id`,(payload_json ->> '$.started_at')) WHERE kind = 'session';--> statement-breakpoint
CREATE INDEX `analytics_summaries_session_seen_idx` ON `analytics_summaries` (`organization_id`,(payload_json ->> '$.last_seen_at')) WHERE kind = 'session';--> statement-breakpoint
CREATE INDEX `analytics_summaries_session_visitor_idx` ON `analytics_summaries` (`organization_id`,(payload_json ->> '$.visitor_id'),(payload_json ->> '$.started_at')) WHERE kind = 'session';--> statement-breakpoint
CREATE TABLE `article_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`collection` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`parent_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `article_categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "article_categories_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "article_categories_collection_check" CHECK(collection IN ('blog', 'docs')),
	CONSTRAINT "article_categories_name_not_blank_check" CHECK(trim(name) <> ''),
	CONSTRAINT "article_categories_slug_check" CHECK(slug <> '' AND slug = lower(slug) AND slug NOT GLOB '*[^a-z0-9-]*' AND slug NOT LIKE '-%' AND slug NOT LIKE '%-' AND slug NOT LIKE '%--%'),
	CONSTRAINT "article_categories_sort_order_check" CHECK(sort_order >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `article_categories_slug_unique` ON `article_categories` (`organization_id`,`collection`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `article_categories_name_unique` ON `article_categories` (`organization_id`,`collection`,lower("name"));--> statement-breakpoint
CREATE INDEX `article_categories_org_sort_idx` ON `article_categories` (`organization_id`,`collection`,`sort_order`);--> statement-breakpoint
CREATE INDEX `article_categories_parent_idx` ON `article_categories` (`parent_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `article_categories_org_id_unique` ON `article_categories` (`organization_id`,`id`);--> statement-breakpoint
CREATE TABLE `article_category_articles` (
	`article_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`category_id` text NOT NULL,
	`article_row_role` text DEFAULT 'root' NOT NULL,
	`article_kind` text DEFAULT 'article' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`category_id`) REFERENCES `article_categories`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`article_id`,`article_row_role`,`article_kind`) REFERENCES `content_documents`(`organization_id`,`id`,`row_role`,`kind`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "article_category_articles_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "article_category_articles_constants_check" CHECK(article_row_role = 'root' AND article_kind = 'article')
);
--> statement-breakpoint
CREATE INDEX `article_category_articles_category_idx` ON `article_category_articles` (`category_id`);--> statement-breakpoint
CREATE TABLE `bookings` (
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
	`no_show_at` text,
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
	CONSTRAINT "bookings_instants_check" CHECK((cancelled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at, '+0 days') IS cancelled_at) AND (no_show_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', no_show_at, '+0 days') IS no_show_at) AND (received_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', received_at, '+0 days') IS received_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at),
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
);
--> statement-breakpoint
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
CREATE TABLE `broadcasts` (
	`id` text PRIMARY KEY NOT NULL,
	`content_document_id` text NOT NULL,
	`category` text NOT NULL,
	`provider_broadcast_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`content_document_id`) REFERENCES `content_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "broadcasts_category_check" CHECK(category IN ('account_security', 'reservations_bookings', 'messages', 'tasks', 'reviews', 'review_requests', 'organization_and_billing', 'product_news')),
	CONSTRAINT "broadcasts_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `broadcasts_content_document_id_unique` ON `broadcasts` (`content_document_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `broadcasts_provider_broadcast_id_unique` ON `broadcasts` (`provider_broadcast_id`) WHERE provider_broadcast_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `business_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`address` text,
	`stay_map_sharing` text DEFAULT 'general' NOT NULL,
	`phone` text,
	`website_url` text,
	`maps_url` text,
	`latitude` real,
	`longitude` real,
	`opening_hours` text,
	`categories` text,
	`rating` real,
	`review_count` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`last_synced_at` text,
	`description` text,
	`short_description` text,
	`special_hours` text,
	`price_level` text,
	`email` text,
	`google_place_id` text,
	`google_review_url` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`timezone` text NOT NULL,
	`seo_title` text,
	`seo_description` text,
	`canonical_url` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "business_locations_instants_check" CHECK((last_synced_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_synced_at, '+0 days') IS last_synced_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "business_locations_address_check" CHECK(address IS NULL OR (json_valid(address) AND json_type(address) IS 'object' AND json_type(address, '$.regionCode') IS 'text' AND trim(address ->> '$.regionCode') <> '' AND json_type(address, '$.addressLines') IS 'array' AND json_array_length(address, '$.addressLines') > 0 AND (json_type(address, '$.languageCode') IS NULL OR json_type(address, '$.languageCode') IS 'text') AND (json_type(address, '$.locality') IS NULL OR json_type(address, '$.locality') IS 'text') AND (json_type(address, '$.sublocality') IS NULL OR json_type(address, '$.sublocality') IS 'text') AND (json_type(address, '$.administrativeArea') IS NULL OR json_type(address, '$.administrativeArea') IS 'text') AND (json_type(address, '$.postalCode') IS NULL OR json_type(address, '$.postalCode') IS 'text'))),
	CONSTRAINT "business_locations_categories_check" CHECK(categories IS NULL OR (json_valid(categories) AND json_type(categories) IS 'array')),
	CONSTRAINT "business_locations_opening_hours_check" CHECK(opening_hours IS NULL OR (json_valid(opening_hours) AND json_type(opening_hours) IS 'object' AND json_type(opening_hours, '$.periods') IS 'array')),
	CONSTRAINT "business_locations_special_hours_check" CHECK(special_hours IS NULL OR (json_valid(special_hours) AND json_type(special_hours) IS 'array')),
	CONSTRAINT "business_locations_timezone_check" CHECK(timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'),
	CONSTRAINT "business_locations_stay_map_sharing_check" CHECK(stay_map_sharing IN ('general', 'specific'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_locations_organization_id_slug_unique` ON `business_locations` (`organization_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `business_locations_organization_id_id_unique` ON `business_locations` (`organization_id`,`id`);--> statement-breakpoint
CREATE TABLE `channel_night_pushes` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`provider` text NOT NULL,
	`date` text NOT NULL,
	`state` text NOT NULL,
	`detail` text,
	`sent_json` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`product_id`, `provider`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`,`provider`) REFERENCES `product_channel_mappings`(`product_id`,`provider`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_night_pushes_provider_check" CHECK(provider = 'channex'),
	CONSTRAINT "channel_night_pushes_state_check" CHECK(state IN ('pending', 'pushed', 'needs_review')),
	CONSTRAINT "channel_night_pushes_detail_check" CHECK(state <> 'needs_review' OR detail IS NOT NULL),
	CONSTRAINT "channel_night_pushes_date_check" CHECK(date(date) IS date),
	CONSTRAINT "channel_night_pushes_updated_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
CREATE INDEX `channel_night_pushes_state_idx` ON `channel_night_pushes` (`organization_id`,`state`);--> statement-breakpoint
CREATE TABLE `channel_sync_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`product_id` text,
	`provider` text NOT NULL,
	`direction` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`task_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_sync_log_provider_check" CHECK(provider IN ('channex', 'google_calendar')),
	CONSTRAINT "channel_sync_log_direction_check" CHECK(direction IN ('inbound', 'outbound')),
	CONSTRAINT "channel_sync_log_kind_check" CHECK(kind IN ('booking_revision', 'availability', 'restrictions', 'calendar_event')),
	CONSTRAINT "channel_sync_log_status_check" CHECK(status IN ('applied', 'acknowledged', 'ignored_disconnected', 'failed', 'needs_review', 'pushed')),
	CONSTRAINT "channel_sync_log_failed_check" CHECK(status NOT IN ('failed', 'needs_review') OR detail IS NOT NULL),
	CONSTRAINT "channel_sync_log_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)
);
--> statement-breakpoint
CREATE INDEX `channel_sync_log_external_idx` ON `channel_sync_log` (`provider`,`kind`,`external_id`);--> statement-breakpoint
CREATE INDEX `channel_sync_log_product_idx` ON `channel_sync_log` (`product_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `channel_sync_log_org_idx` ON `channel_sync_log` (`organization_id`,`created_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_threads_conversation_unique` ON `channel_threads` (`conversation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_threads_booking_unique` ON `channel_threads` (`provider`,`external_booking_id`) WHERE external_booking_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `channel_threads_org_idx` ON `channel_threads` (`organization_id`);--> statement-breakpoint
CREATE TABLE `channex_connections` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`operation_id` text,
	`pending_step` text,
	`group_id` text,
	`setup_property_id` text,
	`state_hash` text,
	`authorization_url` text,
	`authorization_user_id` text,
	`authorization_title` text,
	`authorization_expires_at` text,
	`channel_id` text,
	`connected_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`authorization_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "channex_connections_status_check" CHECK(status IN ('not_connected', 'authorizing', 'connected', 'disconnecting', 'needs_review')),
	CONSTRAINT "channex_connections_connected_check" CHECK(status <> 'connected' OR (channel_id IS NOT NULL AND group_id IS NOT NULL AND connected_at IS NOT NULL)),
	CONSTRAINT "channex_connections_authorizing_check" CHECK(status <> 'authorizing' OR (authorization_url IS NOT NULL AND state_hash IS NOT NULL AND authorization_expires_at IS NOT NULL AND authorization_title IS NOT NULL)),
	CONSTRAINT "channex_connections_instants_check" CHECK((authorization_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', authorization_expires_at, '+0 days') IS authorization_expires_at) AND (connected_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', connected_at, '+0 days') IS connected_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channex_connections_group_unique` ON `channex_connections` (`group_id`) WHERE group_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `channex_connections_channel_unique` ON `channex_connections` (`channel_id`) WHERE channel_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `collection_products` (
	`organization_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`product_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`collection_id`, `product_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`collection_id`) REFERENCES `collections`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "collection_products_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "collection_products_sort_order_check" CHECK(sort_order >= 0)
);
--> statement-breakpoint
CREATE INDEX `collection_products_order_idx` ON `collection_products` (`collection_id`,`sort_order`,`product_id`);--> statement-breakpoint
CREATE INDEX `collection_products_product_idx` ON `collection_products` (`product_id`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`location_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "collections_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "collections_name_not_blank_check" CHECK(trim(name) <> ''),
	CONSTRAINT "collections_slug_check" CHECK(slug <> '' AND slug = lower(slug) AND slug NOT GLOB '*[^a-z0-9-]*' AND slug NOT LIKE '-%' AND slug NOT LIKE '%-' AND slug NOT LIKE '%--%'),
	CONSTRAINT "collections_sort_order_check" CHECK(sort_order >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_org_slug_unique` ON `collections` (`organization_id`,`slug`) WHERE location_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `collections_location_slug_unique` ON `collections` (`organization_id`,`location_id`,`slug`) WHERE location_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `collections_org_sort_idx` ON `collections` (`organization_id`,`location_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `collections_org_id_unique` ON `collections` (`organization_id`,`id`);--> statement-breakpoint
CREATE TABLE `content_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_block_id` text,
	`document_id` text NOT NULL,
	`parent_block_id` text,
	`type` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`level` integer,
	`data_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `content_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_block_id`) REFERENCES `content_blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`,`parent_block_id`) REFERENCES `content_blocks`(`document_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "content_blocks_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "content_blocks_source_check" CHECK(source_block_id IS NULL OR source_block_id <> id),
	CONSTRAINT "content_blocks_data_json_check" CHECK(json_valid(data_json) AND json_type(data_json) IS 'object'),
	CONSTRAINT "content_blocks_parent_check" CHECK(parent_block_id IS NULL OR parent_block_id <> id),
	CONSTRAINT "content_blocks_position_check" CHECK(position >= 0),
	CONSTRAINT "content_blocks_level_check" CHECK(level IS NULL OR level BETWEEN 1 AND 6)
);
--> statement-breakpoint
CREATE INDEX `content_blocks_document_position_idx` ON `content_blocks` (`document_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_blocks_document_source_unique` ON `content_blocks` (`document_id`,`source_block_id`) WHERE source_block_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `content_blocks_parent_idx` ON `content_blocks` (`parent_block_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_blocks_document_id_unique` ON `content_blocks` (`document_id`,`id`);--> statement-breakpoint
CREATE TABLE `content_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`row_role` text NOT NULL,
	`root_id` text,
	`resource_type` text,
	`resource_id` text,
	`root_role` text,
	`locale` text,
	`location_id` text,
	`product_id` text,
	`scope_path` text,
	`title` text,
	`slug` text,
	`path` text,
	`summary` text,
	`status` text,
	`visibility` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`source` text,
	`author_id` text,
	`created_by` text,
	`updated_by` text,
	`published_at` text,
	`first_published_at` text,
	`seo_keywords` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `business_locations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`root_id`,`root_role`,`kind`) REFERENCES `content_documents`(`organization_id`,`id`,`row_role`,`kind`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`locale`,`row_role`) REFERENCES `organization_locales`(`organization_id`,`locale`,`document_role`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "content_documents_instants_check" CHECK((published_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 days') IS published_at) AND (first_published_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', first_published_at, '+0 days') IS first_published_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "content_documents_metadata_check" CHECK(json_valid(metadata_json) AND json_type(metadata_json) IS 'object'),
	CONSTRAINT "content_documents_role_check" CHECK((row_role = 'root' AND root_id IS NULL AND root_role IS NULL AND locale IS NOT NULL) OR (row_role = 'representation' AND ((kind = 'resource' AND root_id IS NULL AND root_role IS NULL) OR (kind <> 'resource' AND root_id IS NOT NULL AND root_id <> id AND root_role = 'root')) AND locale IS NOT NULL AND product_id IS NULL AND location_id IS NULL AND scope_path IS NULL AND status IS NULL AND visibility IS NULL AND source IS NULL AND author_id IS NULL AND published_at IS NULL AND first_published_at IS NULL)),
	CONSTRAINT "content_documents_resource_check" CHECK((kind = 'resource' AND row_role = 'representation' AND resource_type IS NOT NULL AND resource_id IS NOT NULL
	  AND created_by IS NOT NULL AND updated_by IS NOT NULL AND title IS NULL AND slug IS NULL AND summary IS NULL
	  AND (path IS NULL OR (path LIKE '/' || locale || '/%' AND path NOT LIKE '%?%' AND path NOT LIKE '%#%' AND path NOT LIKE '%//%')))
	  OR (kind <> 'resource' AND resource_type IS NULL AND resource_id IS NULL)),
	CONSTRAINT "content_documents_path_check" CHECK(path IS NULL OR (path LIKE '/%' AND path NOT LIKE '//%')),
	CONSTRAINT "content_documents_page_copy_check" CHECK(kind <> 'page' OR (path IS NOT NULL AND title IS NOT NULL)),
	CONSTRAINT "content_documents_qa_scope_check" CHECK(kind <> 'qa' OR row_role <> 'root' OR ((location_id IS NULL OR scope_path IS NULL) AND (scope_path IS NULL OR scope_path LIKE '/%'))),
	CONSTRAINT "content_documents_article_visibility_check" CHECK(kind NOT IN ('article','social_post') OR row_role <> 'root' OR (visibility IN ('listed','unlisted')) IS 1),
	CONSTRAINT "content_documents_qa_state_check" CHECK(kind <> 'qa' OR row_role <> 'root' OR ((status IN ('published','hidden')) IS 1 AND (source IN ('manual','import','template')) IS 1)),
	CONSTRAINT "content_documents_publication_check" CHECK(row_role <> 'root' OR kind NOT IN ('article', 'social_post') OR (status IN ('draft','published')) IS 1),
	CONSTRAINT "content_documents_social_lifecycle_check" CHECK(kind <> 'social_post' OR row_role <> 'root' OR ((status = 'draft' AND published_at IS NULL) OR (status = 'published' AND published_at IS NOT NULL))),
	CONSTRAINT "content_documents_article_lifecycle_check" CHECK(kind <> 'article' OR row_role <> 'root' OR status <> 'published' OR published_at IS NOT NULL),
	CONSTRAINT "content_documents_copy_required_check" CHECK(row_role <> 'root' OR ((kind NOT IN ('page','article','qa') OR title IS NOT NULL) AND (kind NOT IN ('article','social_post') OR slug IS NOT NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_product_root_unique` ON `content_documents` (`organization_id`,`product_id`) WHERE row_role = 'root' AND product_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `content_documents_resource_idx` ON `content_documents` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `content_documents_org_locale_resource_idx` ON `content_documents` (`organization_id`,`locale`,`resource_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_root_locale_unique` ON `content_documents` (`root_id`,`locale`) WHERE row_role = 'representation';--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_route_unique` ON `content_documents` (`organization_id`,`locale`,`path`) WHERE row_role IN ('root','representation') AND path IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_slug_unique` ON `content_documents` (`organization_id`,`kind`,`locale`,`slug`) WHERE row_role IN ('root','representation') AND slug IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_links_org_unique` ON `content_documents` (`organization_id`) WHERE row_role = 'root' AND kind = 'page' AND json_extract(metadata_json, '$.recipe') = 'links';--> statement-breakpoint
CREATE INDEX `content_documents_org_kind_status_idx` ON `content_documents` (`kind`,`row_role`,`status`,`sort_order`);--> statement-breakpoint
CREATE INDEX `content_documents_location_kind_status_idx` ON `content_documents` (`location_id`,`kind`,`row_role`,`status`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_scope_role_unique` ON `content_documents` (`organization_id`,`id`,`row_role`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_resource_locale_unique` ON `content_documents` (`organization_id`,`resource_type`,`resource_id`,`locale`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `content_reports_status_created_idx` ON `content_reports` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `content_reports_conversation_idx` ON `content_reports` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `content_reports_message_idx` ON `content_reports` (`message_id`);--> statement-breakpoint
CREATE TABLE `conversation_participants` (
	`conversation_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`last_read_message_id` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`conversation_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_read_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`conversation_id`) REFERENCES `conversations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_participants_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', archived_at, '+0 days') IS archived_at))
);
--> statement-breakpoint
CREATE INDEX `conversation_participants_user_idx` ON `conversation_participants` (`user_id`,`organization_id`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_scope_id_unique` ON `conversations` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_guest_booking_unique` ON `conversations` (`booking_id`) WHERE kind = 'booking' AND booking_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_participants_unique` ON `conversations` (`organization_id`,`participants_key`) WHERE participants_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `conversations_org_activity_idx` ON `conversations` (`organization_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `conversations_org_booking_idx` ON `conversations` (`organization_id`,`booking_id`);--> statement-breakpoint
CREATE INDEX `conversations_org_user_idx` ON `conversations` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `conversations_user_activity_idx` ON `conversations` (`user_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `conversations_guest_email_idx` ON `conversations` (lower(payload_json ->> '$.guest.email'));--> statement-breakpoint
CREATE TABLE `device_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`environment` text,
	`p256dh` text,
	`auth` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "device_tokens_kind_check" CHECK(((kind = 'apns' AND length(token) > 0 AND length(token) % 2 = 0 AND token NOT GLOB '*[^0123456789abcdef]*' AND environment IN ('sandbox', 'production') AND p256dh IS NULL AND auth IS NULL) OR (kind = 'web' AND token LIKE 'https://%' AND environment IS NULL AND length(p256dh) > 0 AND length(auth) > 0)) IS TRUE),
	CONSTRAINT "device_tokens_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at),
	CONSTRAINT "device_tokens_updated_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
CREATE INDEX `device_tokens_user_idx` ON `device_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `device_tokens_session_idx` ON `device_tokens` (`session_id`);--> statement-breakpoint
CREATE TABLE `google_calendar_cleanup_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`account_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`event_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "google_calendar_cleanup_state_check" CHECK(state IN ('pending', 'error', 'deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_calendar_cleanup_provider_unique` ON `google_calendar_cleanup_jobs` (`calendar_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `google_calendar_event_links` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`integration_revision` text NOT NULL,
	`account_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`event_id` text NOT NULL,
	`booking_id` text NOT NULL,
	`request_id` text,
	`booking_revision` text NOT NULL,
	`synced_revision` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "google_calendar_state_check" CHECK(state IN ('pending', 'synced', 'cleanup', 'deleted', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_calendar_subject_unique` ON `google_calendar_event_links` (`organization_id`,`integration_revision`,`booking_id`) WHERE state <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX `google_calendar_provider_unique` ON `google_calendar_event_links` (`calendar_id`,`event_id`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_thread_deliveries_provider_message_unique` ON `guest_thread_deliveries` (`provider`,`provider_message_id`) WHERE provider_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `guest_thread_deliveries_message_status_idx` ON `guest_thread_deliveries` (`message_id`,`status`);--> statement-breakpoint
CREATE INDEX `guest_thread_deliveries_activity_idx` ON `guest_thread_deliveries` (`activity_entry_id`);--> statement-breakpoint
CREATE INDEX `guest_thread_deliveries_task_idx` ON `guest_thread_deliveries` (`task_id`);--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expiresAt` integer NOT NULL,
	`inviterId` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviterId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitation_organizationId_idx` ON `invitation` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_invitation_org_pending_owner` ON `invitation` (`organizationId`) WHERE role = 'owner' AND status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_invitation_org_email_pending_unique` ON `invitation` (`organizationId`,lower("email")) WHERE status = 'pending';--> statement-breakpoint
CREATE TABLE `jwks` (
	`id` text PRIMARY KEY NOT NULL,
	`publicKey` text NOT NULL,
	`privateKey` text NOT NULL,
	`alg` text,
	`crv` text,
	`createdAt` integer NOT NULL,
	`expiresAt` integer
);
--> statement-breakpoint
CREATE TABLE `mcp_tool_call_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`location_id` text,
	`user_id` text,
	`mcp_surface` text DEFAULT 'client' NOT NULL,
	`request_id` text,
	`method` text NOT NULL,
	`tool_name` text,
	`tool_domain` text,
	`is_mutating` integer,
	`arguments_summary_json` text,
	`result_summary_json` text,
	`status` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`http_status` integer,
	`jsonrpc_error_code` integer,
	`jsonrpc_error_message` text,
	`protocol_version` text,
	`session_id_hash` text,
	`oauth_client_id_hash` text,
	`user_agent` text,
	`cf_ray_id` text,
	`catalog_fingerprint` text,
	`unknown_tool_name` text,
	`duration_ms` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`location_id`) REFERENCES `business_locations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "mcp_tool_call_events_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)),
	CONSTRAINT "mcp_tool_call_events_arguments_summary_json_check" CHECK(arguments_summary_json IS NULL OR (json_valid(arguments_summary_json))),
	CONSTRAINT "mcp_tool_call_events_result_summary_json_check" CHECK(result_summary_json IS NULL OR (json_valid(result_summary_json))),
	CONSTRAINT "mcp_tool_call_events_duration_check" CHECK(duration_ms >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_call_events_created_at` ON `mcp_tool_call_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_call_events_tool_status` ON `mcp_tool_call_events` (`tool_name`,`status`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_call_events_org` ON `mcp_tool_call_events` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_call_events_method_created` ON `mcp_tool_call_events` (`method`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_call_events_session` ON `mcp_tool_call_events` (`session_id_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_call_events_unknown` ON `mcp_tool_call_events` (`unknown_tool_name`,`created_at`);--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`source` text NOT NULL,
	`cloudflare_image_id` text,
	`r2_key` text,
	`public_url` text,
	`thumbnail_url` text,
	`mime_type` text,
	`file_name` text,
	`file_size` integer,
	`width` integer,
	`height` integer,
	`duration` integer,
	`alt_text` text,
	`generation_key` text,
	`category` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "media_assets_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "media_assets_video_thumbnail_check" CHECK(kind <> 'video' OR (thumbnail_url IS NOT NULL AND length(trim(thumbnail_url)) > 0)),
	CONSTRAINT "media_assets_category_check" CHECK(category IS NULL OR category IN ('exterior', 'interior', 'food', 'menu', 'team', 'other', 'logo', 'blog'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_org_id_unique` ON `media_assets` (`organization_id`,`id`);--> statement-breakpoint
CREATE TABLE `media_placements` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`slot` text NOT NULL,
	`asset_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`presentation_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`asset_id`) REFERENCES `media_assets`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_placements_presentation_check" CHECK(presentation_json IS NULL OR (json_valid(presentation_json) AND json_extract(presentation_json, '$.shape') IN ('original', 'square', 'circle') AND json_type(presentation_json, '$.focus.x') IN ('integer', 'real') AND json_type(presentation_json, '$.focus.y') IN ('integer', 'real')) IS TRUE),
	CONSTRAINT "media_placements_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "media_placements_owner_type_check" CHECK(owner_type IN ('organization', 'business_location', 'product', 'collection', 'content_document', 'content_block', 'review', 'review_request', 'message', 'task', 'stay_photo_room', 'stay_home_accessibility', 'stay_room_accessibility')),
	CONSTRAINT "media_placements_sort_order_check" CHECK(sort_order >= 0)
);
--> statement-breakpoint
CREATE INDEX `media_placements_asset_idx` ON `media_placements` (`organization_id`,`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_placements_org_owner_slot_asset_unique` ON `media_placements` (`owner_type`,`owner_id`,`slot`,`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_placements_org_owner_slot_order_unique` ON `media_placements` (`owner_type`,`owner_id`,`slot`,`sort_order`);--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`userId` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_userId_organizationId_unique` ON `member` (`userId`,`organizationId`);--> statement-breakpoint
CREATE INDEX `member_organizationId_idx` ON `member` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_id_organizationId_unique` ON `member` (`id`,`organizationId`);--> statement-breakpoint
CREATE TABLE `member_scheduling` (
	`member_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`timezone` text,
	`weekly_json` text,
	`time_off_json` text,
	`public_name` text,
	`public_photo_url` text,
	`public_bio` text,
	`public_approved` integer DEFAULT 0 NOT NULL,
	`calendar_account_id` text,
	`calendar_ids_json` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`member_id`,`organization_id`) REFERENCES `member`(`id`,`organizationId`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "member_scheduling_hours_check" CHECK(("member_scheduling"."timezone" IS NULL AND "member_scheduling"."weekly_json" IS NULL AND "member_scheduling"."time_off_json" IS NULL) OR ("member_scheduling"."timezone" IS NOT NULL AND "member_scheduling"."weekly_json" IS NOT NULL AND "member_scheduling"."time_off_json" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `member_scheduling_org_idx` ON `member_scheduling` (`organization_id`);--> statement-breakpoint
CREATE TABLE `message_templates` (
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
	CONSTRAINT "message_templates_schedule_check" CHECK((schedule_json IS NULL AND schedule_enabled_at IS NULL) OR (schedule_json IS NOT NULL AND schedule_enabled_at IS NOT NULL AND json_valid(schedule_json) AND json_type(schedule_json) IS 'object' AND json_type(schedule_json, '$.product_ids') IS 'array' AND json_array_length(schedule_json, '$.product_ids') BETWEEN 1 AND 100 AND ((json_extract(schedule_json, '$.trigger') = 'booking_received' AND json_extract(schedule_json, '$.delay_minutes') = 5) OR (json_extract(schedule_json, '$.trigger') IN ('check_in', 'check_out') AND ((json_type(schedule_json, '$.offset_hours') IS NULL AND json_type(schedule_json, '$.offset_days') IS 'integer' AND json_extract(schedule_json, '$.offset_days') BETWEEN -7 AND 7 AND json_extract(schedule_json, '$.local_time') GLOB '[0-2][0-9]:[0-5][0-9]' AND json_extract(schedule_json, '$.local_time') < '24:00') OR (json_type(schedule_json, '$.offset_days') IS NULL AND json_type(schedule_json, '$.local_time') IS NULL AND json_type(schedule_json, '$.offset_hours') IS 'integer' AND json_extract(schedule_json, '$.offset_hours') BETWEEN -72 AND 72))))) IS TRUE),
	CONSTRAINT "message_templates_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (schedule_enabled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', schedule_enabled_at, '+0 days') IS schedule_enabled_at))
);
--> statement-breakpoint
CREATE INDEX `message_templates_org_updated_idx` ON `message_templates` (`organization_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_templates_org_id_unique` ON `message_templates` (`organization_id`,`id`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_dedupe_key_unique` ON `messages` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_sequence_unique` ON `messages` (`conversation_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `messages_conversation_event_idx` ON `messages` (`conversation_id`,`event_name`);--> statement-breakpoint
CREATE TABLE `oauthAccessToken` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text NOT NULL,
	`userId` text,
	`token` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`authorizationCodeId` text,
	`resources` text,
	`requestedUserInfoClaims` text,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`sessionId` text,
	`referenceId` text,
	`refreshId` text,
	`revoked` integer,
	`confirmation` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthAccessToken_token_unique` ON `oauthAccessToken` (`token`);--> statement-breakpoint
CREATE TABLE `oauthClient` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text NOT NULL,
	`clientSecret` text,
	`name` text NOT NULL,
	`redirectUris` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`clientCredentialsScopes` text DEFAULT '[]' NOT NULL,
	`clientDiscoveryId` text,
	`applicationType` text,
	`requirePKCE` integer DEFAULT 1 NOT NULL,
	`skipConsent` integer DEFAULT 0 NOT NULL,
	`userId` text,
	`metadata` text,
	`disabled` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`enableEndSession` integer,
	`subjectType` text,
	`uri` text,
	`icon` text,
	`contacts` text,
	`tos` text,
	`policy` text,
	`softwareId` text,
	`softwareVersion` text,
	`softwareStatement` text,
	`postLogoutRedirectUris` text,
	`backchannelLogoutUri` text,
	`backchannelLogoutSessionRequired` integer DEFAULT 0 NOT NULL,
	`tokenEndpointAuthMethod` text,
	`jwks` text,
	`jwksUri` text,
	`grantTypes` text,
	`responseTypes` text,
	`type` text,
	`dpopBoundAccessTokens` integer DEFAULT 0 NOT NULL,
	`referenceId` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthClient_clientId_unique` ON `oauthClient` (`clientId`);--> statement-breakpoint
CREATE TABLE `oauthClientAssertion` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauthClientResource` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text NOT NULL,
	`resourceId` text NOT NULL,
	`metadata` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`clientId`) REFERENCES `oauthClient`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resourceId`) REFERENCES `oauthResource`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauthConsent` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text NOT NULL,
	`userId` text NOT NULL,
	`scopes` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`referenceId` text,
	`resources` text,
	`requestedUserInfoClaims` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthConsent_clientId_userId_unique` ON `oauthConsent` (`clientId`,`userId`);--> statement-breakpoint
CREATE TABLE `oauthRefreshToken` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text NOT NULL,
	`userId` text,
	`token` text NOT NULL,
	`scopes` text DEFAULT '' NOT NULL,
	`authorizationCodeId` text,
	`resources` text,
	`requestedUserInfoClaims` text,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`sessionId` text,
	`referenceId` text,
	`revoked` integer,
	`rotatedAt` integer,
	`rotationReplayResponse` text,
	`rotationReplayExpiresAt` integer,
	`authTime` integer,
	`confirmation` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthRefreshToken_token_unique` ON `oauthRefreshToken` (`token`);--> statement-breakpoint
CREATE TABLE `oauthResource` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`name` text NOT NULL,
	`accessTokenTtl` integer,
	`refreshTokenTtl` integer,
	`signingAlgorithm` text,
	`signingKeyId` text,
	`allowedScopes` text,
	`customClaims` text,
	`dpopBoundAccessTokensRequired` integer DEFAULT 0 NOT NULL,
	`disabled` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`policyVersion` integer DEFAULT 1 NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthResource_identifier_unique` ON `oauthResource` (`identifier`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `offline_payments_booking_idx` ON `offline_payments` (`booking_id`,`paid_on`);--> statement-breakpoint
CREATE UNIQUE INDEX `offline_payments_idempotency_unique` ON `offline_payments` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `onboarding_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text,
	`name` text NOT NULL,
	`vertical` text NOT NULL,
	`subdomain_candidate` text,
	`source_type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`payload_json` text NOT NULL,
	`committed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "onboarding_drafts_instants_check" CHECK((committed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', committed_at, '+0 days') IS committed_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "onboarding_drafts_payload_json_check" CHECK(payload_json IS NULL OR (json_valid(payload_json) AND json_type(payload_json) IS 'object'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_onboarding_drafts_active_user_unique` ON `onboarding_drafts` (`user_id`) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX `onboarding_drafts_user_id_idx` ON `onboarding_drafts` (`user_id`);--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`operation` text NOT NULL,
	`subject_id` text NOT NULL,
	`evidence_revision` text NOT NULL,
	`goal_id` text,
	`goal_revision` text,
	`status` text NOT NULL,
	`available_at` text,
	`decision_note` text,
	`decided_at` text,
	`decided_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`goal_id`) REFERENCES `organization_goals`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "opportunities_reference_check" CHECK(length(trim(subject_id)) > 0 AND length(evidence_revision) = 64 AND evidence_revision NOT GLOB '*[^a-f0-9]*' AND ((goal_id IS NULL AND goal_revision IS NULL) OR (goal_id IS NOT NULL AND length(trim(goal_id)) > 0 AND goal_revision IS NOT NULL))),
	CONSTRAINT "opportunities_decision_check" CHECK((status IN ('accepted', 'dismissed')) = (decided_at IS NOT NULL) AND (decided_at IS NOT NULL OR decided_by_user_id IS NULL) AND (decision_note IS NULL OR length(trim(decision_note)) BETWEEN 1 AND 2000)),
	CONSTRAINT "opportunities_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (goal_revision IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', goal_revision, '+0 days') IS goal_revision) AND (available_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', available_at, '+0 days') IS available_at) AND (decided_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', decided_at, '+0 days') IS decided_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opportunities_reference_unique` ON `opportunities` (`organization_id`,`operation`,`subject_id`,`evidence_revision`) WHERE "opportunities"."goal_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `opportunities_goal_reference_unique` ON `opportunities` (`organization_id`,`operation`,`subject_id`,`evidence_revision`,`goal_id`) WHERE "opportunities"."goal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `opportunities_status_idx` ON `opportunities` (`organization_id`,`status`,`available_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `opportunities_scope_unique` ON `opportunities` (`organization_id`,`id`);--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`metadata` text,
	`stripeCustomerId` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`logo` text,
	`consultation_settings_json` text,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`theme_id` text DEFAULT 'saya-theme-v1' NOT NULL,
	`subdomain` text,
	`brand_description` text,
	`contact_email` text,
	`contact_phone` text,
	`default_currency` text NOT NULL,
	`timezone` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`onboarding_status` text DEFAULT 'pending' NOT NULL,
	`url_structure` text DEFAULT 'location_subdirectories' NOT NULL,
	`vertical` text DEFAULT 'restaurant' NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text,
	`seo_title` text,
	`seo_description` text,
	`canonical_url` text,
	`analytics_data_start_at` text,
	CONSTRAINT "organization_slug_required_check" CHECK(trim(slug) <> ''),
	CONSTRAINT "organization_instants_check" CHECK((updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at) AND (analytics_data_start_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', analytics_data_start_at, '+0 days') IS analytics_data_start_at)),
	CONSTRAINT "organization_settings_json_check" CHECK(json_valid(settings_json) AND json_type(settings_json) IS 'object'),
	CONSTRAINT "organization_consultation_settings_check" CHECK(consultation_settings_json IS NULL OR (json_valid(consultation_settings_json) AND json_type(consultation_settings_json) IS 'object' AND json_extract(consultation_settings_json, '$.mode') IN ('external_url', 'native_disabled', 'native') AND json_type(consultation_settings_json, '$.cta_label') IS 'text' AND json_type(consultation_settings_json, '$.schedule_path') IS 'text' AND json_extract(consultation_settings_json, '$.schedule_path') LIKE '/%' AND json_type(consultation_settings_json, '$.confirmation_path') IS 'text' AND json_extract(consultation_settings_json, '$.confirmation_path') LIKE '/%' AND (json_type(consultation_settings_json, '$.metadata_json') IS NULL OR json_type(consultation_settings_json, '$.metadata_json') IN ('null', 'object')) AND (json_type(consultation_settings_json, '$.external_url') IS NULL OR json_type(consultation_settings_json, '$.external_url') IN ('null', 'text'))) IS TRUE),
	CONSTRAINT "organization_config_palette_check" CHECK(json_type(settings_json, '$.config.palette') IS NULL OR (json_type(settings_json, '$.config.palette.light') IS 'object' AND json_type(settings_json, '$.config.palette.dark') IS 'object') IS TRUE),
	CONSTRAINT "organization_config_font_preset_check" CHECK(json_type(settings_json, '$.config.font_preset') IS NULL OR json_type(settings_json, '$.config.font_preset') IS 'text'),
	CONSTRAINT "organization_config_press_email_check" CHECK(json_type(settings_json, '$.config.press_email') IS NULL OR json_type(settings_json, '$.config.press_email') IS 'text'),
	CONSTRAINT "organization_config_partnerships_email_check" CHECK(json_type(settings_json, '$.config.partnerships_email') IS NULL OR json_type(settings_json, '$.config.partnerships_email') IS 'text'),
	CONSTRAINT "organization_config_catering_email_check" CHECK(json_type(settings_json, '$.config.catering_email') IS NULL OR json_type(settings_json, '$.config.catering_email') IS 'text'),
	CONSTRAINT "organization_config_careers_email_check" CHECK(json_type(settings_json, '$.config.careers_email') IS NULL OR json_type(settings_json, '$.config.careers_email') IS 'text'),
	CONSTRAINT "organization_default_currency_check" CHECK(length(default_currency) = 3 AND default_currency = upper(default_currency) AND default_currency NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "organization_timezone_check" CHECK(timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'),
	CONSTRAINT "organization_compliance_metadata_check" CHECK(json_type(settings_json, '$.compliance.metadata_json') IS NULL OR json_type(settings_json, '$.compliance.metadata_json') IN ('null', 'object')),
	CONSTRAINT "organization_config_object_check" CHECK(json_type(settings_json, '$.config') IS NULL OR json_type(settings_json, '$.config') IS 'object'),
	CONSTRAINT "organization_compliance_object_check" CHECK(json_type(settings_json, '$.compliance') IS NULL OR json_type(settings_json, '$.compliance') IS 'object'),
	CONSTRAINT "organization_compliance_check" CHECK(json_type(settings_json, '$.compliance') IS NULL OR (json_extract(settings_json, '$.compliance.address_visibility') IN ('visible', 'hidden') AND (json_extract(settings_json, '$.compliance.service_area_type') IS NULL OR json_extract(settings_json, '$.compliance.service_area_type') IN ('AdministrativeArea', 'City', 'Country', 'Place', 'State')) AND json_type(settings_json, '$.compliance.same_as') IN ('array', 'null') AND json_type(settings_json, '$.compliance.contact_points') IN ('array', 'null')) IS TRUE),
	CONSTRAINT "organization_compliance_nonprofit_check" CHECK(json_extract(settings_json, '$.compliance.nonprofit_status') IS NULL OR json_extract(settings_json, '$.compliance.nonprofit_status') IN ('https://schema.org/Nonprofit501c1', 'https://schema.org/Nonprofit501c2', 'https://schema.org/Nonprofit501c3', 'https://schema.org/Nonprofit501c4', 'https://schema.org/Nonprofit501c5', 'https://schema.org/Nonprofit501c6', 'https://schema.org/Nonprofit501c7', 'https://schema.org/Nonprofit501c8', 'https://schema.org/Nonprofit501c9', 'https://schema.org/Nonprofit501c10', 'https://schema.org/Nonprofit501c11', 'https://schema.org/Nonprofit501c12', 'https://schema.org/Nonprofit501c13', 'https://schema.org/Nonprofit501c14', 'https://schema.org/Nonprofit501c15', 'https://schema.org/Nonprofit501c16', 'https://schema.org/Nonprofit501c17', 'https://schema.org/Nonprofit501c18', 'https://schema.org/Nonprofit501c19', 'https://schema.org/Nonprofit501c20', 'https://schema.org/Nonprofit501c21', 'https://schema.org/Nonprofit501c22', 'https://schema.org/Nonprofit501c23', 'https://schema.org/Nonprofit501c24', 'https://schema.org/Nonprofit501c25', 'https://schema.org/Nonprofit501c26', 'https://schema.org/Nonprofit501c27', 'https://schema.org/Nonprofit501c28', 'https://schema.org/NonprofitANBI', 'https://schema.org/NonprofitSBBI'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_stripeCustomerId_unique` ON `organization` (`stripeCustomerId`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_subdomain_unique` ON `organization` (`subdomain`);--> statement-breakpoint
CREATE INDEX `organization_created_at_idx` ON `organization` (`createdAt`);--> statement-breakpoint
CREATE TABLE `organization_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`former_organization_id` text,
	`successor_domain` text,
	`retired_at` text,
	`reconciliation_token` text,
	`reconciliation_expires_at` text,
	`desired_state` text DEFAULT 'active' NOT NULL,
	`domain` text NOT NULL,
	`type` text NOT NULL,
	`role` text DEFAULT 'secondary' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`cloudflare_hostname_id` text,
	`cloudflare_hostname_status` text,
	`cloudflare_ssl_status` text,
	`ownership_validation_name` text,
	`ownership_validation_type` text,
	`ownership_validation_value` text,
	`ssl_validation_name` text,
	`ssl_validation_type` text,
	`ssl_validation_value` text,
	`ssl_validation_name_2` text,
	`ssl_validation_type_2` text,
	`ssl_validation_value_2` text,
	`validation_strategy` text DEFAULT 'http_auto' NOT NULL,
	`dcv_delegation_name` text,
	`dcv_delegation_type` text,
	`dcv_delegation_value` text,
	`dns_target` text,
	`dns_status` text DEFAULT 'pending' NOT NULL,
	`dns_last_resolved_at` text,
	`dns_resolved_target` text,
	`last_synced_at` text,
	`next_check_at` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`activated_at` text,
	`certificate_last_active_at` text,
	`renewal_issue_started_at` text,
	`renewal_notification_sent_at` text,
	`certificate_expires_at` text,
	`error_message` text,
	`metadata` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organization_domains_instants_check" CHECK((retired_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', retired_at, '+0 days') IS retired_at) AND (reconciliation_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', reconciliation_expires_at, '+0 days') IS reconciliation_expires_at) AND (dns_last_resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', dns_last_resolved_at, '+0 days') IS dns_last_resolved_at) AND (last_synced_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_synced_at, '+0 days') IS last_synced_at) AND (next_check_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', next_check_at, '+0 days') IS next_check_at) AND (activated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', activated_at, '+0 days') IS activated_at) AND (certificate_last_active_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', certificate_last_active_at, '+0 days') IS certificate_last_active_at) AND (renewal_issue_started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', renewal_issue_started_at, '+0 days') IS renewal_issue_started_at) AND (renewal_notification_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', renewal_notification_sent_at, '+0 days') IS renewal_notification_sent_at) AND (certificate_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', certificate_expires_at, '+0 days') IS certificate_expires_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "organization_domains_owner_check" CHECK((status = 'retired' AND type = 'subdomain' AND role = 'secondary' AND organization_id IS NULL AND former_organization_id IS NOT NULL AND retired_at IS NOT NULL) OR (status <> 'retired' AND organization_id IS NOT NULL AND former_organization_id IS NULL AND retired_at IS NULL AND successor_domain IS NULL)),
	CONSTRAINT "organization_domains_desired_state_check" CHECK(desired_state IN ('active', 'deleted') AND (desired_state <> 'deleted' OR type = 'custom')),
	CONSTRAINT "organization_domains_lease_check" CHECK((reconciliation_token IS NULL) = (reconciliation_expires_at IS NULL)),
	CONSTRAINT "organization_domains_metadata_check" CHECK(metadata IS NULL OR (json_valid(metadata)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_domains_domain_unique` ON `organization_domains` (`domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_domains_cloudflare_hostname_id_unique` ON `organization_domains` (`cloudflare_hostname_id`);--> statement-breakpoint
CREATE INDEX `organization_domains_org_idx` ON `organization_domains` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_organization_domains_one_canonical` ON `organization_domains` (`organization_id`) WHERE role = 'canonical' AND status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `organization_domains_one_active_subdomain` ON `organization_domains` (`organization_id`) WHERE type = 'subdomain' AND status = 'active';--> statement-breakpoint
CREATE INDEX `idx_organization_domains_reconcile` ON `organization_domains` (`status`,`next_check_at`);--> statement-breakpoint
CREATE TABLE `organization_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`intent` text NOT NULL,
	`constraints` text,
	`target_at` text,
	`strategy_json` text,
	`status` text NOT NULL,
	`created_by_user_id` text,
	`updated_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "organization_goals_text_check" CHECK(length(trim(intent)) BETWEEN 1 AND 2000 AND (constraints IS NULL OR length(trim(constraints)) BETWEEN 1 AND 2000)),
	CONSTRAINT "organization_goals_status_check" CHECK(status IN ('active', 'archived')),
	CONSTRAINT "organization_goals_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (target_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', target_at, '+0 days') IS target_at))
);
--> statement-breakpoint
CREATE INDEX `organization_goals_status_idx` ON `organization_goals` (`organization_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_goals_scope_unique` ON `organization_goals` (`organization_id`,`id`);--> statement-breakpoint
CREATE TABLE `organization_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`target_id` text,
	`target_name` text,
	`measurement_id` text,
	`verified` integer,
	`verification_token` text,
	`status` text,
	`last_error` text,
	`revision` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organization_integrations_provider_check" CHECK(provider IN ('facebook', 'instagram', 'discord', 'google_analytics', 'google_ads', 'meta_ads', 'google_search_console', 'google_calendar')),
	CONSTRAINT "organization_integrations_values_check" CHECK(trim(account_id) <> '' AND trim(revision) <> '' AND ((status IS 'setting_up' AND target_id IS NULL AND target_name IS NULL) OR (status IS NOT 'setting_up' AND length(trim(target_id)) > 0 AND length(trim(target_name)) > 0)) IS TRUE),
	CONSTRAINT "organization_integrations_measurement_check" CHECK((provider = 'google_analytics') = (measurement_id IS NOT NULL)),
	CONSTRAINT "organization_integrations_verification_check" CHECK((provider = 'google_search_console') = (verified IS NOT NULL) AND (verification_token IS NULL OR provider = 'google_search_console') AND (verified IS NULL OR verified IN (0, 1))),
	CONSTRAINT "organization_integrations_calendar_check" CHECK((provider = 'google_calendar') = (status IS NOT NULL) AND (status IS NULL OR status IN ('setting_up', 'active', 'disabled', 'error')) AND (provider = 'google_calendar' OR (status IS NULL AND last_error IS NULL))),
	CONSTRAINT "organization_integrations_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
CREATE INDEX `organization_integrations_account_idx` ON `organization_integrations` (`provider`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_integrations_provider_unique` ON `organization_integrations` (`organization_id`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_integrations_target_unique` ON `organization_integrations` (`provider`,`target_id`);--> statement-breakpoint
CREATE TABLE `organization_invite_links` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`inviter_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`used_by_user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "organization_invite_links_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at AND (used_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', used_at, '+0 days') IS used_at) AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at),
	CONSTRAINT "organization_invite_links_role_check" CHECK(role IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invite_links_token_hash_unique` ON `organization_invite_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `organization_invite_links_organization_id_idx` ON `organization_invite_links` (`organization_id`);--> statement-breakpoint
CREATE TABLE `organization_locales` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`locale` text NOT NULL,
	`label` text,
	`is_source` integer DEFAULT 0 NOT NULL,
	`document_role` text GENERATED ALWAYS AS (CASE WHEN is_source = 1 THEN 'root' ELSE 'representation' END) VIRTUAL,
	`status` text DEFAULT 'disabled' NOT NULL,
	`activated_at` text,
	`disabled_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organization_locales_instants_check" CHECK((activated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', activated_at, '+0 days') IS activated_at) AND (disabled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', disabled_at, '+0 days') IS disabled_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "organization_locales_status_check" CHECK(status IN ('published', 'disabled') AND (is_source = 0 OR status = 'published'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_organization_locales_one_source_per_org` ON `organization_locales` (`organization_id`) WHERE is_source = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `organization_locales_organization_id_locale_unique` ON `organization_locales` (`organization_id`,`locale`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_locales_locale_role_unique` ON `organization_locales` (`organization_id`,`locale`,`document_role`);--> statement-breakpoint
CREATE TABLE `organization_redirects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`locale` text NOT NULL,
	`owner_type` text,
	`owner_id` text,
	`from_path` text NOT NULL,
	`to_path` text,
	`status_code` integer DEFAULT 301 NOT NULL,
	`behavior` text DEFAULT 'redirect' NOT NULL,
	`reason` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organization_redirects_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "organization_redirects_from_path_check" CHECK(from_path LIKE '/%'),
	CONSTRAINT "organization_redirects_redirect_to_path_check" CHECK(behavior != 'redirect' OR to_path IS NOT NULL),
	CONSTRAINT "organization_redirects_owner_check" CHECK((owner_type IS NULL AND owner_id IS NULL) OR (owner_type IS NOT NULL AND owner_id IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `organization_redirects_organization_id_idx` ON `organization_redirects` (`organization_id`);--> statement-breakpoint
CREATE INDEX `organization_redirects_owner_idx` ON `organization_redirects` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_redirects_org_locale_from_path_unique` ON `organization_redirects` (`organization_id`,`locale`,`from_path`);--> statement-breakpoint
CREATE TABLE `organization_services` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`service` text NOT NULL,
	`terms_version` text NOT NULL,
	`agreed_by_user_id` text,
	`agreed_at` text NOT NULL,
	`ended_by_user_id` text,
	`ended_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agreed_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ended_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_services_current_unique` ON `organization_services` (`organization_id`,`service`) WHERE ended_at IS NULL;--> statement-breakpoint
CREATE TABLE `payment_authorizations` (
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
CREATE TABLE `payment_checkout_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text,
	`variant_id` text,
	`price_id` text,
	`session_id` text,
	`location_id` text,
	`timezone` text,
	`buyer_user_id` text,
	`conversation_id` text,
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
	FOREIGN KEY (`buyer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_holds_quantity_check" CHECK(quantity > 0 AND amount > 0),
	CONSTRAINT "payment_holds_subject_check" CHECK((product_id IS NOT NULL AND variant_id IS NOT NULL AND price_id IS NOT NULL AND session_id IS NOT NULL) OR (product_id IS NOT NULL AND variant_id IS NULL AND price_id IS NULL AND session_id IS NULL AND location_id IS NOT NULL AND timezone IS NOT NULL AND date(starts_at, '+0 days') IS starts_at AND date(ends_at, '+0 days') IS ends_at AND ends_at > starts_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_checkout_holds_payment_id_unique` ON `payment_checkout_holds` (`payment_id`);--> statement-breakpoint
CREATE INDEX `payment_holds_capacity_idx` ON `payment_checkout_holds` (`session_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `payment_cost_snapshots` (
	`source_id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`payment_id` text,
	`incurred_by` text NOT NULL,
	`currency` text NOT NULL,
	`amount` integer NOT NULL,
	`billing_basis_json` text,
	`incurred_at` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `payment_disputes` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`stripe_dispute_id` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`evidence_due_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_disputes_provider_unique` ON `payment_disputes` (`payment_id`,`stripe_dispute_id`);--> statement-breakpoint
CREATE TABLE `payment_fee_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`stripe_report_id` text,
	`livemode` integer NOT NULL,
	`interval_start` integer NOT NULL,
	`interval_end` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payment_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`price_id` text NOT NULL,
	`title` text NOT NULL,
	`unit_amount` integer NOT NULL,
	`quantity` integer NOT NULL,
	`currency` text NOT NULL,
	`tax_behavior` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `payment_orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_order_lines_amount_check" CHECK(unit_amount >= 0 AND quantity > 0)
);
--> statement-breakpoint
CREATE TABLE `payment_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`buyer_user_id` text,
	`payment_id` text NOT NULL,
	`currency` text NOT NULL,
	`amount` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`buyer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_orders_payment_id_unique` ON `payment_orders` (`payment_id`);--> statement-breakpoint
CREATE TABLE `payment_refunds` (
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
CREATE UNIQUE INDEX `payment_refunds_idempotency_key_unique` ON `payment_refunds` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_refunds_provider_unique` ON `payment_refunds` (`payment_id`,`stripe_refund_id`);--> statement-breakpoint
CREATE TABLE `payment_servicing_tenants` (
	`organization_id` text NOT NULL,
	`stripe_account_id` text NOT NULL,
	`livemode` integer NOT NULL,
	`retained_at` text NOT NULL,
	PRIMARY KEY(`stripe_account_id`, `livemode`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`buyer_user_id` text,
	`stripe_account_id` text NOT NULL,
	`livemode` integer NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text,
	`location_id` text,
	`currency` text NOT NULL,
	`amount` integer NOT NULL,
	`price_snapshot_json` text NOT NULL,
	`tax_amount` integer DEFAULT 0 NOT NULL,
	`surcharge_amount` integer DEFAULT 0 NOT NULL,
	`captured_amount` integer DEFAULT 0 NOT NULL,
	`refunded_amount` integer DEFAULT 0 NOT NULL,
	`stripe_payment_intent_id` text,
	`stripe_charge_id` text,
	`receipt_url` text,
	`idempotency_key` text,
	`checkout_expires_at` text,
	`review_json` text,
	`return_token` text,
	`return_token_hash` text,
	`return_expires_at` text,
	`claimed_at` text,
	`claimed_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`buyer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`claimed_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "payments_amounts_check" CHECK(amount >= 0 AND captured_amount >= 0 AND refunded_amount >= 0 AND refunded_amount <= captured_amount),
	CONSTRAINT "payments_currency_check" CHECK(length(currency) = 3 AND currency = upper(currency))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_idempotency_key_unique` ON `payments` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_return_token_hash_unique` ON `payments` (`return_token_hash`);--> statement-breakpoint
CREATE INDEX `payments_tenant_created_idx` ON `payments` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `payments_buyer_idx` ON `payments` (`buyer_user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_provider_unique` ON `payments` (`stripe_account_id`,`livemode`,`stripe_payment_intent_id`);--> statement-breakpoint
CREATE TABLE `post_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`post_id` text,
	`post_row_role` text DEFAULT 'root' NOT NULL,
	`post_kind` text DEFAULT 'social_post' NOT NULL,
	`channel` text NOT NULL,
	`provider_app_id` text NOT NULL,
	`provider_subject_id` text NOT NULL,
	`provider_target_id` text NOT NULL,
	`state` text NOT NULL,
	`provider_post_id` text,
	`provider_permalink` text,
	`provider_handles_json` text DEFAULT '{}' NOT NULL,
	`payload_hash` text NOT NULL,
	`attempt_id` text,
	`initiating_activity_id` text,
	`error_code` text,
	`error_message` text,
	`published_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`initiating_activity_id`) REFERENCES `activity_entries`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`post_id`,`post_row_role`,`post_kind`) REFERENCES `content_documents`(`organization_id`,`id`,`row_role`,`kind`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "post_publications_instants_check" CHECK((published_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', published_at, '+0 days') IS published_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "post_publications_constants_check" CHECK(post_row_role = 'root' AND post_kind = 'social_post'),
	CONSTRAINT "post_publications_channel_check" CHECK(channel IN ('facebook', 'instagram', 'discord')),
	CONSTRAINT "post_publications_state_check" CHECK(state IN ('preparing', 'publishing', 'published', 'failed', 'unknown', 'removed')),
	CONSTRAINT "post_publications_identity_check" CHECK(length(trim(provider_app_id)) > 0 AND length(trim(provider_subject_id)) > 0 AND length(trim(provider_target_id)) > 0 AND (provider_post_id IS NULL OR length(trim(provider_post_id)) > 0)),
	CONSTRAINT "post_publications_handles_check" CHECK(json_valid(provider_handles_json) AND json_type(provider_handles_json) IS 'object'),
	CONSTRAINT "post_publications_permalink_check" CHECK(provider_permalink IS NULL OR provider_permalink LIKE 'https://%'),
	CONSTRAINT "post_publications_published_check" CHECK(state NOT IN ('published', 'removed') OR (published_at IS NOT NULL AND (provider_post_id IS NOT NULL OR (channel = 'instagram' AND json_type(provider_handles_json, '$.container_id') IS 'text')))),
	CONSTRAINT "post_publications_failed_check" CHECK((state IN ('failed', 'unknown')) = (error_code IS NOT NULL)),
	CONSTRAINT "post_publications_attempt_check" CHECK(attempt_id IS NULL OR state IN ('preparing', 'publishing'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_publications_post_channel_unique` ON `post_publications` (`organization_id`,`post_id`,`channel`) WHERE post_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `post_publications_provider_post_unique` ON `post_publications` (`organization_id`,`channel`,`provider_app_id`,`provider_post_id`) WHERE provider_post_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `post_publications_subject_idx` ON `post_publications` (`channel`,`provider_app_id`,`provider_subject_id`);--> statement-breakpoint
CREATE INDEX `post_publications_target_state_idx` ON `post_publications` (`organization_id`,`channel`,`provider_target_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `post_publications_org_id_unique` ON `post_publications` (`organization_id`,`id`);--> statement-breakpoint
CREATE TABLE `prices` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_variant_id` text NOT NULL,
	`location_id` text,
	`stay_date` text,
	`weekend` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`currency` text NOT NULL,
	`unit_amount` integer NOT NULL,
	`type` text DEFAULT 'one_time' NOT NULL,
	`recurring_interval` text,
	`recurring_interval_count` integer,
	`tax_behavior` text DEFAULT 'unspecified' NOT NULL,
	`compare_at_unit_amount` integer,
	`valid_from_at` text,
	`valid_until_at` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_variant_id`) REFERENCES `product_variants`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "prices_instants_check" CHECK((valid_from_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', valid_from_at, '+0 days') IS valid_from_at) AND (valid_until_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', valid_until_at, '+0 days') IS valid_until_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "prices_stay_rate_check" CHECK(weekend IN (0, 1) AND (stay_date IS NULL OR (weekend = 0 AND date(stay_date, '+0 days') IS stay_date)) AND ((stay_date IS NULL AND weekend = 0) OR (active = 1 AND type = 'one_time' AND location_id IS NULL AND valid_from_at IS NULL AND valid_until_at IS NULL))),
	CONSTRAINT "prices_active_check" CHECK(active IN (0, 1)),
	CONSTRAINT "prices_currency_check" CHECK(length(currency) = 3 AND currency = upper(currency) AND currency NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "prices_unit_amount_check" CHECK(unit_amount >= 0),
	CONSTRAINT "prices_compare_at_check" CHECK(compare_at_unit_amount IS NULL OR compare_at_unit_amount > unit_amount),
	CONSTRAINT "prices_validity_check" CHECK(valid_until_at IS NULL OR valid_from_at IS NULL OR valid_until_at > valid_from_at),
	CONSTRAINT "prices_recurring_check" CHECK((type = 'recurring' AND recurring_interval IS NOT NULL AND recurring_interval_count IS NOT NULL AND recurring_interval_count > 0) OR (type <> 'recurring' AND recurring_interval IS NULL AND recurring_interval_count IS NULL))
);
--> statement-breakpoint
CREATE INDEX `prices_variant_validity_idx` ON `prices` (`organization_id`,`product_variant_id`,`active`,`valid_from_at`,`valid_until_at`);--> statement-breakpoint
CREATE INDEX `prices_location_idx` ON `prices` (`organization_id`,`location_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `prices_stay_date_unique` ON `prices` (`product_variant_id`,`stay_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `prices_weekend_unique` ON `prices` (`product_variant_id`) WHERE weekend = 1;--> statement-breakpoint
CREATE TABLE `product_availability_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`location_id` text NOT NULL,
	`timezone` text NOT NULL,
	`weekday` integer NOT NULL,
	`start_time` text NOT NULL,
	`interval_weeks` integer DEFAULT 1 NOT NULL,
	`effective_from_date` text,
	`effective_until_date` text,
	`capacity` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_booking_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_availability_rules_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "product_availability_rules_weekday_check" CHECK(weekday BETWEEN 0 AND 6),
	CONSTRAINT "product_availability_rules_start_time_check" CHECK(start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time < '24:00'),
	CONSTRAINT "product_availability_rules_interval_check" CHECK(interval_weeks >= 1),
	CONSTRAINT "product_availability_rules_anchor_check" CHECK(interval_weeks = 1 OR effective_from_date IS NOT NULL),
	CONSTRAINT "product_availability_rules_dates_check" CHECK((effective_from_date IS NULL OR date(effective_from_date, '+0 days') IS effective_from_date) AND (effective_until_date IS NULL OR date(effective_until_date, '+0 days') IS effective_until_date) AND (effective_from_date IS NULL OR effective_until_date IS NULL OR effective_until_date >= effective_from_date)),
	CONSTRAINT "product_availability_rules_capacity_check" CHECK(capacity IS NULL OR capacity >= 0),
	CONSTRAINT "product_availability_rules_timezone_check" CHECK(timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_availability_rules_slot_unique` ON `product_availability_rules` (`product_id`,`location_id`,`weekday`,`start_time`,`interval_weeks`);--> statement-breakpoint
CREATE INDEX `product_availability_rules_product_idx` ON `product_availability_rules` (`product_id`,`weekday`,`start_time`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_availability_rules_org_id_unique` ON `product_availability_rules` (`organization_id`,`id`);--> statement-breakpoint
CREATE TABLE `product_booking_configs` (
	`product_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`unit` text NOT NULL,
	`duration_minutes` integer,
	`seating_interval_minutes` integer,
	`default_capacity` integer,
	`confirmation_mode` text DEFAULT 'instant' NOT NULL,
	`online_payment_required` integer DEFAULT 0 NOT NULL,
	`held_online` integer DEFAULT 0 NOT NULL,
	`scheduling_mode` text NOT NULL,
	`assigned_member_id` text,
	`advance_notice_minutes` integer,
	`questions` text DEFAULT '[]' NOT NULL,
	`party_size_min` integer,
	`party_size_max` integer,
	`minimum_guest_age` integer,
	`accessibility_contact_required` integer DEFAULT 0 NOT NULL,
	`payment_basis` text DEFAULT 'per_guest' NOT NULL,
	`payment_min_party_size` integer,
	`check_in_time` text,
	`check_in_end_time` text,
	`check_out_time` text,
	`min_nights` integer,
	`calendar_rules` text,
	`cancellation_policy` text,
	`long_term_cancellation_policy` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_booking_configs_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "product_booking_configs_duration_check" CHECK(duration_minutes IS NULL OR duration_minutes > 0),
	CONSTRAINT "product_booking_configs_seating_interval_check" CHECK(seating_interval_minutes IS NULL OR (seating_interval_minutes BETWEEN 5 AND 1440 AND unit = 'slot' AND held_online = 0)),
	CONSTRAINT "product_booking_configs_capacity_check" CHECK(default_capacity IS NULL OR default_capacity >= 0),
	CONSTRAINT "product_booking_configs_confirmation_check" CHECK(confirmation_mode IN ('instant', 'review')),
	CONSTRAINT "product_booking_configs_scheduling_mode_check" CHECK(scheduling_mode IN ('business', 'provider')),
	CONSTRAINT "product_booking_configs_payment_check" CHECK(online_payment_required IN (0, 1)),
	CONSTRAINT "product_booking_configs_held_online_check" CHECK(held_online IN (0, 1) AND (held_online = 0 OR scheduling_mode = 'provider')),
	CONSTRAINT "product_booking_configs_nights_check" CHECK(CASE WHEN unit = 'nights' THEN default_capacity >= 1 AND min_nights >= 1 AND duration_minutes IS NULL AND held_online = 0 AND scheduling_mode = 'business' AND advance_notice_minutes IS NULL
		ELSE check_in_time IS NULL AND check_in_end_time IS NULL AND check_out_time IS NULL AND min_nights IS NULL AND calendar_rules IS NULL AND cancellation_policy IS NULL AND long_term_cancellation_policy IS NULL END),
	CONSTRAINT "product_booking_configs_times_check" CHECK((check_in_time IS NULL OR (check_in_time GLOB '[0-2][0-9]:[0-5][0-9]' AND check_in_time < '24:00')) AND (check_out_time IS NULL OR (check_out_time GLOB '[0-2][0-9]:[0-5][0-9]' AND check_out_time < '24:00'))),
	CONSTRAINT "product_booking_configs_check_in_end_check" CHECK(check_in_end_time IS NULL OR (check_in_end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND check_in_end_time < '24:00')),
	CONSTRAINT "product_booking_configs_calendar_rules_check" CHECK(calendar_rules IS NULL OR (json_valid(calendar_rules) AND json_type(calendar_rules) = 'object' AND json_type(calendar_rules, '$.weekend_price_minor') IS NULL)),
	CONSTRAINT "product_booking_configs_cancellation_check" CHECK(cancellation_policy IS NULL OR cancellation_policy IN ('flexible', 'moderate', 'limited', 'firm', 'strict')),
	CONSTRAINT "product_booking_configs_long_term_cancellation_check" CHECK(long_term_cancellation_policy IS NULL OR long_term_cancellation_policy IN ('firm', 'strict')),
	CONSTRAINT "product_booking_configs_party_check" CHECK((party_size_min IS NULL OR party_size_min >= 1) AND (party_size_max IS NULL OR party_size_max >= COALESCE(party_size_min, 1))),
	CONSTRAINT "product_booking_configs_guest_terms_check" CHECK((minimum_guest_age IS NULL OR minimum_guest_age >= 0) AND accessibility_contact_required IN (0, 1)),
	CONSTRAINT "product_booking_configs_payment_basis_check" CHECK(payment_basis IN ('per_guest', 'per_booking') AND (payment_min_party_size IS NULL OR payment_min_party_size >= 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_booking_configs_org_product_unique` ON `product_booking_configs` (`organization_id`,`product_id`);--> statement-breakpoint
CREATE TABLE `product_channel_mappings` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`provider` text NOT NULL,
	`listing_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`property_id` text,
	`room_type_id` text,
	`rate_plan_id` text,
	`import_stage` text NOT NULL,
	`import_property` text,
	`import_calendar` text,
	`import_content` text,
	`import_written` text,
	`enabled` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`product_id`, `provider`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_channel_mappings_provider_check" CHECK(provider = 'channex'),
	CONSTRAINT "product_channel_mappings_stage_check" CHECK(import_stage IN ('property', 'room', 'rate', 'inventory', 'verify_inventory', 'content', 'draft', 'mapping', 'activate', 'reservations', 'messages', 'complete')),
	CONSTRAINT "product_channel_mappings_ids_check" CHECK((import_stage = 'property' OR property_id IS NOT NULL) AND (import_stage IN ('property', 'room') OR room_type_id IS NOT NULL) AND (import_stage IN ('property', 'room', 'rate') OR rate_plan_id IS NOT NULL)),
	CONSTRAINT "product_channel_mappings_calendar_check" CHECK(import_calendar IS NULL OR (json_valid(import_calendar) AND json_type(import_calendar) = 'array')),
	CONSTRAINT "product_channel_mappings_property_json_check" CHECK(import_property IS NULL OR (json_valid(import_property) AND json_type(import_property) = 'object')),
	CONSTRAINT "product_channel_mappings_content_json_check" CHECK(import_content IS NULL OR (json_valid(import_content) AND json_type(import_content) = 'object')),
	CONSTRAINT "product_channel_mappings_enabled_check" CHECK(enabled IN (0, 1) AND (enabled = 0 OR import_stage IN ('reservations', 'messages', 'complete'))),
	CONSTRAINT "product_channel_mappings_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_channel_mappings_listing_unique` ON `product_channel_mappings` (`provider`,`listing_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_channel_mappings_property_unique` ON `product_channel_mappings` (`provider`,`property_id`) WHERE property_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_channel_mappings_room_type_unique` ON `product_channel_mappings` (`provider`,`room_type_id`) WHERE room_type_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_channel_mappings_rate_plan_unique` ON `product_channel_mappings` (`provider`,`rate_plan_id`) WHERE rate_plan_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `product_channel_mappings_org_idx` ON `product_channel_mappings` (`organization_id`);--> statement-breakpoint
CREATE TABLE `product_locations` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`location_id` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`published` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`product_id`, `location_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_locations_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "product_locations_active_check" CHECK(active IN (0, 1) AND published IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `product_locations_location_idx` ON `product_locations` (`location_id`,`published`,`active`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_locations_org_product_location_unique` ON `product_locations` (`organization_id`,`product_id`,`location_id`);--> statement-breakpoint
CREATE TABLE `product_nights` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`date` text NOT NULL,
	`closed` integer DEFAULT 0 NOT NULL,
	`min_stay_arrival` integer,
	`max_stay` integer,
	`closed_to_arrival` integer DEFAULT 0 NOT NULL,
	`closed_to_departure` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`product_id`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_nights_date_check" CHECK(date(date, '+0 days') IS date),
	CONSTRAINT "product_nights_flags_check" CHECK(closed IN (0, 1) AND closed_to_arrival IN (0, 1) AND closed_to_departure IN (0, 1)),
	CONSTRAINT "product_nights_stay_rules_check" CHECK((min_stay_arrival IS NULL OR min_stay_arrival >= 1) AND (max_stay IS NULL OR max_stay >= 1)),
	CONSTRAINT "product_nights_source_check" CHECK(source IN ('host', 'import')),
	CONSTRAINT "product_nights_updated_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
CREATE TABLE `product_publications` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`published` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`product_id`, `organization_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_publications_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "product_publications_published_check" CHECK(published IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `product_publications_org_idx` ON `product_publications` (`published`);--> statement-breakpoint
CREATE TABLE `product_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`location_id` text,
	`availability_rule_id` text,
	`source_occurrence_key` text,
	`timezone` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`capacity` integer,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_booking_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`availability_rule_id`) REFERENCES `product_availability_rules`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_sessions_instants_check" CHECK((strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+0 days') IS starts_at) AND (strftime('%Y-%m-%dT%H:%M:%fZ', ends_at, '+0 days') IS ends_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "product_sessions_interval_check" CHECK(ends_at > starts_at),
	CONSTRAINT "product_sessions_status_check" CHECK(status IN ('scheduled', 'cancelled')),
	CONSTRAINT "product_sessions_capacity_check" CHECK(capacity IS NULL OR capacity >= 0),
	CONSTRAINT "product_sessions_timezone_check" CHECK(timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_sessions_occurrence_unique` ON `product_sessions` (`product_id`,`source_occurrence_key`) WHERE source_occurrence_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_sessions_location_instant_unique` ON `product_sessions` (`product_id`,`location_id`,`starts_at`) WHERE location_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_sessions_online_instant_unique` ON `product_sessions` (`product_id`,`starts_at`) WHERE location_id IS NULL;--> statement-breakpoint
CREATE INDEX `product_sessions_product_start_idx` ON `product_sessions` (`product_id`,`starts_at`,`status`);--> statement-breakpoint
CREATE INDEX `product_sessions_location_start_idx` ON `product_sessions` (`location_id`,`starts_at`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_sessions_org_id_unique` ON `product_sessions` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_sessions_org_product_id_unique` ON `product_sessions` (`organization_id`,`product_id`,`id`);--> statement-breakpoint
CREATE TABLE `product_stay_accessibility` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`feature_code` text NOT NULL,
	`available` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `product_id`, `feature_code`),
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_stay_accessibility_feature_check" CHECK(feature_code IN ('disabled_parking_spot', 'path_to_entrance_lit_at_night', 'home_step_free_access', 'home_wide_doorway', 'pool_hoist', 'ceiling_hoist')),
	CONSTRAINT "product_stay_accessibility_available_check" CHECK(available IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `product_stay_configs` (
	`internal_name` text,
	`product_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`location_id` text NOT NULL,
	`check_in_instructions` text,
	`property_type_group` text,
	`property_type` text,
	`listing_type` text,
	`total_floors` integer,
	`listing_floor` integer,
	`year_built` integer,
	`property_size` real,
	`property_size_unit` text,
	`bedrooms` integer,
	`beds` integer,
	`bathrooms` real,
	`amenities` text DEFAULT '[]' NOT NULL,
	`check_in_method` text,
	`wifi_network` text,
	`wifi_password` text,
	`directions` text,
	`house_manual` text,
	`checkout_instructions` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`location_id`) REFERENCES `product_locations`(`organization_id`,`product_id`,`location_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_stay_configs_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "product_stay_configs_instructions_check" CHECK(check_in_instructions IS NULL OR (length(trim(check_in_instructions)) BETWEEN 1 AND 5000)),
	CONSTRAINT "product_stay_configs_property_type_group_check" CHECK(property_type_group IS NULL OR property_type_group IN ('apartments', 'houses', 'secondary_units', 'unique_homes', 'bnb', 'boutique_hotels_and_more')),
	CONSTRAINT "product_stay_configs_property_type_check" CHECK((property_type IS NULL AND property_type_group IS NULL) OR (property_type IS NOT NULL AND property_type_group IS NOT NULL AND property_type_group || ':' || property_type IN ('apartments:apartment', 'apartments:condominium', 'apartments:serviced_apartment', 'apartments:loft', 'houses:house', 'houses:townhouse', 'houses:bungalow', 'houses:cabin', 'houses:chalet', 'houses:earthhouse', 'houses:hut', 'houses:lighthouse', 'houses:villa', 'houses:dome', 'houses:cottage', 'houses:farmstay', 'houses:houseboat', 'houses:tiny_house', 'secondary_units:guesthouse', 'secondary_units:private_suite', 'secondary_units:farmstay', 'unique_homes:boat', 'unique_homes:castle', 'unique_homes:cave', 'unique_homes:earthhouse', 'unique_homes:hut', 'unique_homes:igloo', 'unique_homes:island', 'unique_homes:lighthouse', 'unique_homes:plane', 'unique_homes:rv', 'unique_homes:tent', 'unique_homes:tipi', 'unique_homes:train', 'unique_homes:treehouse', 'unique_homes:yurt', 'unique_homes:other', 'unique_homes:dome', 'unique_homes:barn', 'unique_homes:campsite', 'unique_homes:farmstay', 'unique_homes:houseboat', 'unique_homes:tiny_house', 'unique_homes:windmill', 'unique_homes:bus', 'unique_homes:holiday_park', 'unique_homes:ranch', 'unique_homes:religious_building', 'unique_homes:riad', 'unique_homes:shipping_container', 'unique_homes:tower', 'bnb:bnb', 'bnb:nature_eco_lodge', 'bnb:farmstay', 'boutique_hotels_and_more:boutique_hotel', 'boutique_hotels_and_more:nature_eco_lodge', 'boutique_hotels_and_more:hostel', 'boutique_hotels_and_more:serviced_apartment', 'boutique_hotels_and_more:aparthotel', 'boutique_hotels_and_more:hotel', 'boutique_hotels_and_more:resort'))),
	CONSTRAINT "product_stay_configs_bedrooms_check" CHECK(bedrooms IS NULL OR bedrooms BETWEEN 0 AND 50),
	CONSTRAINT "product_stay_configs_listing_type_check" CHECK(listing_type IS NULL OR listing_type IN ('entire_place', 'private_room', 'shared_room')),
	CONSTRAINT "product_stay_configs_total_floors_check" CHECK(total_floors IS NULL OR (typeof(total_floors) = 'integer' AND total_floors BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "product_stay_configs_listing_floor_check" CHECK(listing_floor IS NULL OR (typeof(listing_floor) = 'integer' AND listing_floor BETWEEN 1 AND 9007199254740991 AND (total_floors IS NULL OR listing_floor <= total_floors))),
	CONSTRAINT "product_stay_configs_year_built_check" CHECK(year_built IS NULL OR (typeof(year_built) = 'integer' AND year_built BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "product_stay_configs_property_size_check" CHECK(property_size IS NULL OR (typeof(property_size) IN ('integer', 'real') AND property_size > 0 AND property_size <= 1.7976931348623157e308)),
	CONSTRAINT "product_stay_configs_property_size_unit_check" CHECK((property_size IS NULL AND property_size_unit IS NULL) OR (property_size IS NOT NULL AND property_size_unit IS NOT NULL AND property_size_unit IN ('square_meters', 'square_feet'))),
	CONSTRAINT "product_stay_configs_beds_check" CHECK(beds IS NULL OR beds >= 0),
	CONSTRAINT "product_stay_configs_bathrooms_check" CHECK(bathrooms IS NULL OR (bathrooms BETWEEN 0 AND 50 AND bathrooms * 2 = CAST(bathrooms * 2 AS INTEGER))),
	CONSTRAINT "product_stay_configs_amenities_check" CHECK(json_valid(amenities) AND json_type(amenities) = 'array'),
	CONSTRAINT "product_stay_configs_check_in_method_check" CHECK(check_in_method IS NULL OR check_in_method IN ('smart_lock', 'keypad', 'lockbox', 'building_staff', 'in_person', 'other')),
	CONSTRAINT "product_stay_configs_wifi_network_check" CHECK(wifi_network IS NULL OR length(trim(wifi_network)) BETWEEN 1 AND 100),
	CONSTRAINT "product_stay_configs_wifi_password_check" CHECK(wifi_password IS NULL OR length(wifi_password) BETWEEN 1 AND 100),
	CONSTRAINT "product_stay_configs_directions_check" CHECK(directions IS NULL OR length(trim(directions)) BETWEEN 1 AND 5000),
	CONSTRAINT "product_stay_configs_house_manual_check" CHECK(house_manual IS NULL OR length(trim(house_manual)) BETWEEN 1 AND 5000),
	CONSTRAINT "product_stay_configs_checkout_instructions_check" CHECK(json_valid(checkout_instructions) AND json_type(checkout_instructions) = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_stay_configs_org_product_unique` ON `product_stay_configs` (`organization_id`,`product_id`);--> statement-breakpoint
CREATE TABLE `product_stay_photo_room_amenities` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`room_id` text NOT NULL,
	`amenity_code` text NOT NULL,
	PRIMARY KEY(`organization_id`, `product_id`, `room_id`, `amenity_code`),
	FOREIGN KEY (`organization_id`,`product_id`,`room_id`) REFERENCES `product_stay_photo_rooms`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_stay_photo_room_amenities_code_check" CHECK(amenity_code IN ('ac', 'dryer', 'essentials', 'heating', 'hot_water', 'kitchen', 'tv', 'washer', 'wireless_internet', 'bathtub', 'bidet', 'body_soap', 'cleaning_products', 'conditioner', 'hair_dryer', 'alfresco_shower', 'shampoo', 'shower_gel', 'bed_linens', 'wardrobe_or_closet', 'clothes_drying_rack', 'extra_pillows_and_blankets', 'hangers', 'iron', 'mosquito_net', 'room_darkening_shades', 'safe', 'arcade_machine', 'batting_cage', 'books', 'bowling_alley', 'climbing_wall', 'ethernet_connection', 'exercise_equipment', 'game_console', 'laser_tag', 'life_size_games', 'mini_golf', 'home_theater', 'piano', 'ping_pong_table', 'pool_table', 'record_player', 'skate_ramp', 'sound_system', 'theme_room', 'baby_bath', 'baby_monitor', 'childrens_bike', 'playroom', 'stair_gates', 'babysitter_recommendations', 'board_games', 'changing_table', 'childrens_books_and_toys', 'childrens_dinnerware', 'crib', 'fireplace_guards', 'high_chair', 'playground', 'outlet_covers', 'pack_n_play_travel_crib', 'table_corner_guards', 'window_guards', 'ceiling_fan', 'fireplace', 'portable_fans', 'carbon_monoxide_detector', 'fire_extinguisher', 'first_aid_kit', 'smoke_detector', 'laptop_friendly_workspace', 'pocket_wifi', 'baking_sheet', 'barbeque_utensils', 'bread_maker', 'blender', 'coffee', 'coffee_maker', 'cooking_basics', 'dining_table', 'dishes_and_silverware', 'dishwasher', 'freezer', 'hot_water_kettle', 'kitchenette', 'microwave', 'mini_fridge', 'oven', 'refrigerator', 'rice_maker', 'stove', 'toaster', 'trash_compacter', 'wine_glasses', 'beach_access', 'lake_access', 'laundromat_nearby', 'private_entrance', 'resort_access', 'ski_in_ski_out', 'waterfront', 'garden_or_backyard', 'bbq_area', 'beach_essentials', 'bicycle', 'boat_slip', 'fire_pit', 'hammock', 'kayak', 'alfresco_dining', 'outdoor_seating', 'outdoor_kitchen', 'patio_or_belcony', 'sun_loungers', 'free_parking', 'street_parking', 'paid_parking_on_premises', 'paid_parking', 'free_parking_off_premises', 'elevator', 'ev_charger', 'hockey_rink', 'gym', 'jacuzzi', 'pool', 'private_living_room', 'sauna', 'single_level_home', 'ebike_charger', 'solar_power', 'recycling', 'composting', 'doorman', 'gated_community', 'breakfast', 'cleaning_before_checkout', 'long_term_stays_allowed', 'luggage_dropoff_allowed', 'bay_view', 'beach_view', 'canal_view', 'city_view', 'courtyard_view', 'desert_view', 'garden_view', 'golf_view', 'harbor_view', 'lake_view', 'marina_view', 'mountain_view', 'ocean_view', 'park_view', 'pool_view', 'resort_view', 'river_view', 'sea_view', 'valley_view', 'vineyard_view', 'landmark_view'))
);
--> statement-breakpoint
CREATE TABLE `product_stay_photo_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`type` text NOT NULL,
	`details_version` integer DEFAULT 1 NOT NULL,
	`sleeping_arrangements` text,
	`private_attached_bathroom` integer,
	`sort_order` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_stay_photo_rooms_type_check" CHECK(type IN ('art_studio', 'backyard', 'balcony', 'bedroom', 'bowling_alley', 'childrens_playroom', 'courtyard', 'darkroom', 'deck', 'dining_area', 'event_room', 'exterior', 'front_yard', 'full_bathroom', 'full_kitchen', 'game_room', 'garage', 'garden', 'gym', 'half_bathroom', 'hot_tub', 'kitchenette', 'laundry_area', 'library', 'living_room', 'movie_theater', 'music_studio', 'office', 'patio', 'photography_studio', 'pool', 'porch', 'rooftop', 'sunroom', 'terrace', 'theme_room', 'wine_cellar', 'woodshop', 'workshop', 'workspace')),
	CONSTRAINT "product_stay_photo_rooms_order_check" CHECK(sort_order >= 0),
	CONSTRAINT "product_stay_photo_rooms_created_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at),
	CONSTRAINT "product_stay_photo_rooms_details_version_check" CHECK(details_version >= 1),
	CONSTRAINT "product_stay_photo_rooms_sleeping_arrangements_check" CHECK(sleeping_arrangements IS NULL OR (json_valid(sleeping_arrangements) AND json_type(sleeping_arrangements) = 'array')),
	CONSTRAINT "product_stay_photo_rooms_private_bathroom_check" CHECK(private_attached_bathroom IS NULL OR (type = 'bedroom' AND private_attached_bathroom IN (0, 1)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_stay_photo_rooms_scope_id_unique` ON `product_stay_photo_rooms` (`organization_id`,`product_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_stay_photo_rooms_scope_order_unique` ON `product_stay_photo_rooms` (`organization_id`,`product_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `product_stay_room_accessibility` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`room_id` text NOT NULL,
	`feature_code` text NOT NULL,
	`available` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `product_id`, `room_id`, `feature_code`),
	FOREIGN KEY (`organization_id`,`product_id`,`room_id`) REFERENCES `product_stay_photo_rooms`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_stay_room_accessibility_feature_check" CHECK(feature_code IN ('step_free_access', 'wide_doorway')),
	CONSTRAINT "product_stay_room_accessibility_available_check" CHECK(available IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `product_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`sku` text,
	`active` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_variants_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "product_variants_name_not_blank_check" CHECK(trim(name) <> ''),
	CONSTRAINT "product_variants_active_check" CHECK(active IN (0, 1)),
	CONSTRAINT "product_variants_sort_order_check" CHECK(sort_order >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_org_sku_unique` ON `product_variants` (`organization_id`,`sku`) WHERE sku IS NOT NULL;--> statement-breakpoint
CREATE INDEX `product_variants_product_sort_idx` ON `product_variants` (`product_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_org_id_unique` ON `product_variants` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_product_id_unique` ON `product_variants` (`organization_id`,`product_id`,`id`);--> statement-breakpoint
CREATE TABLE `products` (
	`kind` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`order_url` text,
	`unit_label` text,
	`marketing_features` text DEFAULT '[]' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`tax_code` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "products_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "products_name_not_blank_check" CHECK(trim(name) <> ''),
	CONSTRAINT "products_slug_check" CHECK(slug <> '' AND slug = lower(slug) AND slug NOT GLOB '*[^a-z0-9-]*' AND slug NOT LIKE '-%' AND slug NOT LIKE '%-' AND slug NOT LIKE '%--%'),
	CONSTRAINT "products_kind_check" CHECK(kind IN ('dish', 'experience', 'service', 'stay', 'table')),
	CONSTRAINT "products_active_check" CHECK(active IN (0, 1)),
	CONSTRAINT "products_marketing_features_check" CHECK(json_valid(marketing_features) AND json_type(marketing_features) = 'array'),
	CONSTRAINT "products_details_json_check" CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
	CONSTRAINT "products_metadata_check" CHECK(json_valid(metadata) AND json_type(metadata) = 'object'),
	CONSTRAINT "products_order_url_check" CHECK(order_url IS NULL OR (order_url LIKE 'https://_%' AND instr(order_url, '@') = 0 AND instr(order_url, char(10)) = 0 AND instr(order_url, char(13)) = 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_org_id_unique` ON `products` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_org_slug_unique` ON `products` (`organization_id`,`slug`);--> statement-breakpoint
CREATE TABLE `public_resource_cache_invalidations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`processed_at` text,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "public_resource_cache_invalidations_instants_check" CHECK((processed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', processed_at, '+0 days') IS processed_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at))
);
--> statement-breakpoint
CREATE INDEX `public_resource_cache_invalidations_status_idx` ON `public_resource_cache_invalidations` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `public_resource_cache_invalidations_org_idx` ON `public_resource_cache_invalidations` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text,
	CONSTRAINT "rate_limits_instants_check" CHECK((updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at) AND (expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at))
);
--> statement-breakpoint
CREATE INDEX `idx_rate_limits_expires` ON `rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `review_category_ratings` (
	`review_id` text NOT NULL,
	`category` text NOT NULL,
	`rating` integer NOT NULL,
	PRIMARY KEY(`review_id`, `category`),
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_category_ratings_rating_check" CHECK(rating BETWEEN 1 AND 5),
	CONSTRAINT "review_category_ratings_category_check" CHECK(category IN ('food', 'service', 'atmosphere', 'expertise', 'organization', 'enjoyment', 'listening', 'explanation', 'next_steps', 'cleanliness', 'accuracy', 'check_in', 'communication'))
);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_requests_token_hash_unique` ON `review_requests` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_requests_active_booking_unique` ON `review_requests` (`booking_id`) WHERE revoked_at IS NULL AND submitted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `review_requests_submitted_booking_unique` ON `review_requests` (`organization_id`,`booking_id`) WHERE submitted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_review_requests_send_due` ON `review_requests` (`organization_id`,`first_sent_at`,`reminder_sent_at`,`submitted_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `review_requests_organization_id_idx` ON `review_requests` (`organization_id`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_google_review_scope_unique` ON `reviews` (`organization_id`,`location_id`,`google_review_id`);--> statement-breakpoint
CREATE INDEX `reviews_booking_idx` ON `reviews` (`booking_id`);--> statement-breakpoint
CREATE INDEX `reviews_org_user_idx` ON `reviews` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_reviews_location_status` ON `reviews` (`location_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reviews_org_status` ON `reviews` (`status`,`created_at`) WHERE location_id IS NULL;--> statement-breakpoint
CREATE INDEX `idx_reviews_product_status_created` ON `reviews` (`product_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `reviews_organization_id_idx` ON `reviews` (`organization_id`);--> statement-breakpoint
CREATE TABLE `scheduled_guest_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text,
	`booking_id` text,
	`conversation_id` text,
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
	CONSTRAINT "scheduled_guest_messages_kind_check" CHECK((author_user_id IS NULL AND conversation_id IS NULL AND product_id IS NOT NULL AND booking_id IS NOT NULL AND template_title IS NOT NULL AND template_version IS NOT NULL AND timezone IS NOT NULL) OR (author_user_id IS NOT NULL AND conversation_id IS NOT NULL AND due_at IS NOT NULL AND status <> 'skipped' AND product_id IS NULL AND booking_id IS NULL AND template_id IS NULL AND template_title IS NULL AND template_version IS NULL AND timezone IS NULL)),
	CONSTRAINT "scheduled_guest_messages_status_check" CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'needs_review', 'cancelled', 'skipped')),
	CONSTRAINT "scheduled_guest_messages_due_check" CHECK(due_at IS NOT NULL OR status IN ('failed', 'skipped')),
	CONSTRAINT "scheduled_guest_messages_error_check" CHECK((status NOT IN ('failed', 'needs_review') OR (length(trim(reason)) > 0 AND length(trim(error_code)) > 0 AND length(trim(error_field)) > 0)) IS TRUE),
	CONSTRAINT "scheduled_guest_messages_sent_check" CHECK(status <> 'sent' OR (message_id IS NOT NULL AND sent_at IS NOT NULL)),
	CONSTRAINT "scheduled_guest_messages_sending_check" CHECK(status <> 'sending' OR started_at IS NOT NULL),
	CONSTRAINT "scheduled_guest_messages_text_check" CHECK(length(trim(body)) BETWEEN 1 AND 5000 AND (template_title IS NULL OR length(trim(template_title)) BETWEEN 1 AND 100) AND (template_version IS NULL OR template_version >= 1)),
	CONSTRAINT "scheduled_guest_messages_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at) AND (started_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 days') IS started_at) AND (sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', sent_at, '+0 days') IS sent_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_guest_messages_template_booking_unique` ON `scheduled_guest_messages` (`template_id`,`booking_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_guest_messages_check_in_unique` ON `scheduled_guest_messages` (`booking_id`) WHERE template_id IS NULL AND template_title = 'Check-in instructions';--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_booking_idx` ON `scheduled_guest_messages` (`booking_id`);--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_conversation_idx` ON `scheduled_guest_messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_author_idx` ON `scheduled_guest_messages` (`author_user_id`);--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_due_idx` ON `scheduled_guest_messages` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `scheduled_guest_messages_org_created_idx` ON `scheduled_guest_messages` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`activeOrganizationId` text,
	`impersonatedBy` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`userId`);--> statement-breakpoint
CREATE TABLE `stay_calendar_links` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`channel` text NOT NULL,
	`import_url` text NOT NULL,
	`export_token` text NOT NULL,
	`blocked_json` text DEFAULT '[]' NOT NULL,
	`synced_at` text,
	`sync_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `product_stay_configs`(`organization_id`,`product_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stay_calendar_links_channel_check" CHECK(channel = 'vrbo'),
	CONSTRAINT "stay_calendar_links_import_url_check" CHECK(import_url LIKE 'https://%'),
	CONSTRAINT "stay_calendar_links_blocked_check" CHECK(json_valid(blocked_json) AND json_type(blocked_json) = 'array'),
	CONSTRAINT "stay_calendar_links_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (synced_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', synced_at, '+0 days') IS synced_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stay_calendar_links_home_channel_unique` ON `stay_calendar_links` (`product_id`,`channel`);--> statement-breakpoint
CREATE UNIQUE INDEX `stay_calendar_links_export_token_unique` ON `stay_calendar_links` (`export_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `stay_calendar_links_org_product_id_unique` ON `stay_calendar_links` (`organization_id`,`product_id`,`id`);--> statement-breakpoint
CREATE TABLE `stay_nights` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`date` text NOT NULL,
	`booking_id` text,
	`hold_id` text,
	`calendar_link_id` text,
	PRIMARY KEY(`product_id`, `date`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`hold_id`) REFERENCES `payment_checkout_holds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`booking_id`) REFERENCES `bookings`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`calendar_link_id`) REFERENCES `stay_calendar_links`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stay_nights_date_check" CHECK(date(date, '+0 days') IS date),
	CONSTRAINT "stay_nights_claimant_check" CHECK((booking_id IS NOT NULL) + (hold_id IS NOT NULL) + (calendar_link_id IS NOT NULL) = 1)
);
--> statement-breakpoint
CREATE INDEX `stay_nights_booking_idx` ON `stay_nights` (`booking_id`);--> statement-breakpoint
CREATE INDEX `stay_nights_hold_idx` ON `stay_nights` (`hold_id`);--> statement-breakpoint
CREATE INDEX `stay_nights_calendar_link_idx` ON `stay_nights` (`calendar_link_id`);--> statement-breakpoint
CREATE TABLE `stripe_connected_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`stripe_account_id` text,
	`country` text,
	`livemode` integer NOT NULL,
	`status` text DEFAULT 'creating' NOT NULL,
	`card_payments_status` text,
	`surcharge_basis_points` integer,
	`requirements_json` text DEFAULT '[]' NOT NULL,
	`stripe_refreshed_at` text,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stripe_connected_accounts_country_check" CHECK(country IS NULL OR (length(country) = 2 AND country = upper(country) AND country NOT GLOB '*[^A-Z]*')),
	CONSTRAINT "stripe_connected_accounts_livemode_check" CHECK(livemode IN (0, 1)),
	CONSTRAINT "stripe_connected_accounts_status_check" CHECK(status IN ('creating', 'creation_failed', 'action_required', 'pending_review', 'restricted', 'ready')),
	CONSTRAINT "stripe_connected_accounts_capability_check" CHECK(card_payments_status IS NULL OR card_payments_status IN ('active', 'pending', 'restricted', 'unsupported')),
	CONSTRAINT "stripe_connected_accounts_requirements_check" CHECK(json_valid(requirements_json) AND json_type(requirements_json) = 'array'),
	CONSTRAINT "stripe_connected_accounts_identity_check" CHECK((stripe_account_id IS NULL AND status IN ('creating', 'creation_failed')) OR (trim(stripe_account_id) <> '' AND status IN ('action_required', 'pending_review', 'restricted', 'ready'))),
	CONSTRAINT "stripe_connected_accounts_instants_check" CHECK((stripe_refreshed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', stripe_refreshed_at, '+0 days') IS stripe_refreshed_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_connected_accounts_stripe_account_id_unique` ON `stripe_connected_accounts` (`stripe_account_id`);--> statement-breakpoint
CREATE INDEX `stripe_connected_accounts_status_idx` ON `stripe_connected_accounts` (`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_connected_accounts_org_unique` ON `stripe_connected_accounts` (`organization_id`);--> statement-breakpoint
CREATE TABLE `stripe_connected_customers` (
	`user_id` text NOT NULL,
	`stripe_account_id` text NOT NULL,
	`livemode` integer NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `stripe_account_id`, `livemode`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stripe_ga4_subscription_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`stripe_subscription_id` text,
	`action` text NOT NULL,
	`attribution_json` text,
	`client_id` text,
	`session_id` text,
	`session_captured_at` integer,
	`previous_price_id` text,
	`new_price_id` text,
	`effective_timing` text DEFAULT 'immediate' NOT NULL,
	`source` text DEFAULT 'browser' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lifecycle_sent_at` text,
	`consumed_at` text,
	`consumed_event_id` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stripe_ga4_subscription_intents_attribution_check" CHECK(attribution_json IS NULL OR (json_valid(attribution_json) AND json_type(attribution_json) IS 'object')),
	CONSTRAINT "stripe_ga4_subscription_intents_instants_check" CHECK((lifecycle_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', lifecycle_sent_at, '+0 days') IS lifecycle_sent_at) AND (consumed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at, '+0 days') IS consumed_at) AND (expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at))
);
--> statement-breakpoint
CREATE INDEX `stripe_ga4_subscription_intents_subscription_idx` ON `stripe_ga4_subscription_intents` (`stripe_subscription_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `stripe_ga4_subscription_intents_organization_idx` ON `stripe_ga4_subscription_intents` (`organization_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `stripe_ga4_subscription_intents_expiry_idx` ON `stripe_ga4_subscription_intents` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `stripe_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`stripe_event_id` text NOT NULL,
	`event_type` text,
	`processor` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "stripe_webhook_events_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)),
	CONSTRAINT "stripe_webhook_events_payload_check" CHECK(payload IS NULL OR (json_valid(payload)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_webhook_events_stripe_event_id_unique` ON `stripe_webhook_events` (`stripe_event_id`);--> statement-breakpoint
CREATE TABLE `subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`plan` text NOT NULL,
	`referenceId` text NOT NULL,
	`stripeCustomerId` text,
	`stripeSubscriptionId` text,
	`status` text DEFAULT 'incomplete' NOT NULL,
	`periodStart` integer,
	`periodEnd` integer,
	`trialStart` integer,
	`trialEnd` integer,
	`cancelAtPeriodEnd` integer DEFAULT 0 NOT NULL,
	`cancelAt` integer,
	`canceledAt` integer,
	`endedAt` integer,
	`seats` integer,
	`billingInterval` text,
	`stripeScheduleId` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_stripeSubscriptionId_unique` ON `subscription` (`stripeSubscriptionId`);--> statement-breakpoint
CREATE INDEX `subscription_referenceId_idx` ON `subscription` (`referenceId`);--> statement-breakpoint
CREATE INDEX `subscription_status_idx` ON `subscription` (`status`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text,
	`subject_id` text,
	`product_id` text,
	`location_id` text,
	`opportunity_id` text,
	`title` text,
	`notes` text,
	`assigned_member_id` text,
	`starts_at` text,
	`due_at` text,
	`timezone` text NOT NULL,
	`status` text NOT NULL,
	`outcome_note` text,
	`closed_at` text,
	`closed_by_user_id` text,
	`dedupe_key` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`closed_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`opportunity_id`) REFERENCES `opportunities`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_kind_check" CHECK(kind IN ('turnover', 'guest_reply', 'message_delivery', 'booking_review', 'booking_change', 'opportunity', 'custom', 'stay_ready', 'consultation_prep', 'consultation_follow_up')
    AND (subject_type IS NULL) = (subject_id IS NULL)
    AND (subject_type IS NULL OR subject_type IN ('conversation', 'scheduled_guest_message', 'booking', 'article', 'post', 'product'))
    AND (kind <> 'custom' OR subject_type IS NULL)
    AND ((kind = 'opportunity') = (opportunity_id IS NOT NULL))),
	CONSTRAINT "tasks_text_check" CHECK((title IS NULL OR length(trim(title)) BETWEEN 1 AND 200) AND (kind NOT IN ('custom', 'opportunity') OR title IS NOT NULL)
    AND (notes IS NULL OR length(trim(notes)) BETWEEN 1 AND 5000) AND (outcome_note IS NULL OR length(trim(outcome_note)) BETWEEN 1 AND 5000)
    AND length(trim(dedupe_key)) > 0 AND timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'),
	CONSTRAINT "tasks_window_check" CHECK(starts_at IS NULL OR due_at IS NULL OR starts_at <= due_at),
	CONSTRAINT "tasks_status_check" CHECK(status IN ('open', 'done', 'skipped', 'cancelled') AND (status = 'open') = (closed_at IS NULL) AND (status <> 'open' OR closed_by_user_id IS NULL) AND version >= 1),
	CONSTRAINT "tasks_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (starts_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+0 days') IS starts_at) AND (due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at) AND (closed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', closed_at, '+0 days') IS closed_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_dedupe_key_unique` ON `tasks` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_opportunity_unique` ON `tasks` (`opportunity_id`) WHERE opportunity_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `tasks_status_due_idx` ON `tasks` (`organization_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_member_status_due_idx` ON `tasks` (`organization_id`,`assigned_member_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_subject_idx` ON `tasks` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`activity_organization_id` text GENERATED ALWAYS AS (CASE WHEN provider_occurred_at IS NULL THEN organization_id END) VIRTUAL,
	`payment_id` text,
	`billing_basis_json` text,
	`provider_occurred_at` text,
	`delivery_at` text,
	`error` text,
	`resource` text NOT NULL,
	`source` text NOT NULL,
	`provider` text,
	`channel` text,
	`session_id` text,
	`quantity` integer NOT NULL,
	`unit` text NOT NULL,
	`metadata_json` text,
	`idempotency_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`activity_organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "usage_events_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)),
	CONSTRAINT "usage_events_metadata_json_check" CHECK(metadata_json IS NULL OR (json_valid(metadata_json))),
	CONSTRAINT "usage_events_meter_check" CHECK((provider_occurred_at IS NULL AND payment_id IS NULL AND billing_basis_json IS NULL AND delivery_at IS NULL AND error IS NULL)
	  OR (provider_occurred_at IS NOT NULL AND resource IN ('captured_volume', 'stripe_cost', 'stripe_cost_adjustment', 'ad_spend') AND length(unit) = 3 AND unit = upper(unit)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_organization_id_idempotency_key_unique` ON `usage_events` (`organization_id`,`idempotency_key`) WHERE provider_occurred_at IS NULL;--> statement-breakpoint
CREATE INDEX `usage_events_organization_resource_created_idx` ON `usage_events` (`organization_id`,`resource`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_events_org_created_idx` ON `usage_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `usage_events_activity_org_idx` ON `usage_events` (`activity_organization_id`);--> statement-breakpoint
CREATE INDEX `usage_events_pending_meter_idx` ON `usage_events` (`organization_id`,`created_at`) WHERE provider_occurred_at IS NOT NULL AND delivery_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_meter_key_unique` ON `usage_events` (`idempotency_key`) WHERE provider_occurred_at IS NOT NULL;--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer DEFAULT 0 NOT NULL,
	`image` text,
	`phoneNumber` text,
	`phoneNumberVerified` integer DEFAULT 0 NOT NULL,
	`role` text DEFAULT 'user',
	`banned` integer DEFAULT 0,
	`banReason` text,
	`banExpires` integer,
	`isAnonymous` integer DEFAULT 0 NOT NULL,
	`stripeCustomerId` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_phoneNumber_unique` ON `user` (`phoneNumber`);--> statement-breakpoint
CREATE TABLE `user_notification_preferences` (
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`email_enabled` integer NOT NULL,
	`whatsapp_enabled` integer NOT NULL,
	`push_enabled` integer NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `category`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_notification_preferences_category_check" CHECK(category IN ('account_security', 'reservations_bookings', 'messages', 'tasks', 'reviews', 'review_requests', 'organization_and_billing', 'product_news')),
	CONSTRAINT "user_notification_preferences_updated_at_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at),
	CONSTRAINT "user_notification_preferences_account_security_check" CHECK(category != 'account_security' OR email_enabled = 1)
);
--> statement-breakpoint
CREATE TABLE `user_workspace_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`location_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`whatsapp_pending_confirmation` text,
	`whatsapp_last_inbound_id` text,
	`whatsapp_updated_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`location_id`) REFERENCES `business_locations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "user_workspace_state_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at) AND (whatsapp_updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', whatsapp_updated_at, '+0 days') IS whatsapp_updated_at)),
	CONSTRAINT "user_workspace_state_whatsapp_pending_check" CHECK(whatsapp_pending_confirmation IS NULL OR (json_valid(whatsapp_pending_confirmation) AND json_type(whatsapp_pending_confirmation) IS 'object'))
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL
);
