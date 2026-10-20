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
	`kind` text NOT NULL,
	`scope_kind` text NOT NULL,
	`organization_id` text,
	`location_id` text,
	`request_id` text,
	`parent_id` text,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`target_user_id` text,
	`channel` text,
	`body` text,
	`event_name` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`dedupe_key` text NOT NULL,
	`sequence` integer,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `business_locations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `activity_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "activity_entries_instants_check" CHECK((occurred_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+0 days') IS occurred_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)),
	CONSTRAINT "activity_entries_scope_check" CHECK((scope_kind = 'request' AND request_id IS NOT NULL AND organization_id IS NULL AND location_id IS NULL) OR (scope_kind = 'organization' AND organization_id IS NOT NULL AND request_id IS NULL) OR (scope_kind = 'global' AND organization_id IS NULL AND request_id IS NULL)),
	CONSTRAINT "activity_entries_payload_check" CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
	CONSTRAINT "activity_entries_timeline_check" CHECK((kind IN ('submission', 'message', 'operation', 'assignment', 'resolution') AND request_id IS NOT NULL AND sequence IS NOT NULL AND sequence > 0 AND scope_kind = 'request') OR (kind NOT IN ('submission', 'message', 'operation', 'assignment', 'resolution') AND sequence IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_entries_dedupe_key_unique` ON `activity_entries` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `activity_entries_request_sequence_unique` ON `activity_entries` (`request_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `activity_entries_notification_source_unique` ON `activity_entries` (`parent_id`) WHERE kind = 'notification' AND parent_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `activity_entries_request_occurred_idx` ON `activity_entries` (`request_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `activity_entries_parent_actor_idx` ON `activity_entries` (`parent_id`,`actor_user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `activity_entries_context_organization_created_idx` ON `activity_entries` (`kind`,`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_entries_kind_org_created_idx` ON `activity_entries` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_entries_org_created_idx` ON `activity_entries` (`kind`,`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_entries_target_created_idx` ON `activity_entries` (`kind`,`target_user_id`,`created_at`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `analytics_events_conversion_entity_unique` ON `analytics_events` (`organization_id`,(payload_json ->> '$.event_name'),(payload_json ->> '$.entity_type'),(payload_json ->> '$.entity_id')) WHERE kind = 'conversion' AND (payload_json ->> '$.entity_type') IS NOT NULL AND (payload_json ->> '$.entity_id') IS NOT NULL AND (payload_json ->> '$.event_name') IN ('contact_submit', 'reservation_submit', 'booking_submit', 'sign_up', 'onboarding_complete', 'purchase', 'refund', 'payment_paid', 'payment_refunded', 'booking_confirmed', 'booking_declined', 'booking_cancelled', 'booking_change_accepted', 'booking_change_declined', 'payments_fee_invoice_paid');--> statement-breakpoint
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
	`product_id` text NOT NULL,
	`product_session_id` text NOT NULL,
	`product_variant_id` text NOT NULL,
	`assigned_member_id` text,
	`user_id` text,
	`request_id` text,
	`party_size` integer NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`cancelled_at` text,
	`cancellation_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`product_id`,`product_session_id`) REFERENCES `product_sessions`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`product_id`,`product_variant_id`) REFERENCES `product_variants`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`request_id`) REFERENCES `requests`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bookings_status_check" CHECK(status IN ('pending', 'confirmed', 'cancelled')),
	CONSTRAINT "bookings_instants_check" CHECK((cancelled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at, '+0 days') IS cancelled_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "bookings_party_size_check" CHECK(party_size > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_request_unique` ON `bookings` (`request_id`) WHERE request_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `bookings_session_status_idx` ON `bookings` (`product_session_id`,`status`);--> statement-breakpoint
CREATE INDEX `bookings_org_created_idx` ON `bookings` (`created_at`);--> statement-breakpoint
CREATE INDEX `bookings_org_user_idx` ON `bookings` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `broadcasts` (
	`id` text PRIMARY KEY NOT NULL,
	`content_document_id` text NOT NULL,
	`category` text NOT NULL,
	`provider_broadcast_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`content_document_id`) REFERENCES `content_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "broadcasts_category_check" CHECK(category IN ('account_security', 'reservations_bookings', 'guest_messages', 'reviews', 'review_requests', 'organization_and_billing', 'product_news')),
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
	`timezone` text,
	`max_capacity` integer,
	`seo_title` text,
	`seo_description` text,
	`canonical_url` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "business_locations_instants_check" CHECK((last_synced_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_synced_at, '+0 days') IS last_synced_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "business_locations_address_check" CHECK(address IS NULL OR (json_valid(address) AND json_type(address) IS 'object' AND json_type(address, '$.regionCode') IS 'text' AND trim(address ->> '$.regionCode') <> '' AND json_type(address, '$.addressLines') IS 'array' AND json_array_length(address, '$.addressLines') > 0 AND (json_type(address, '$.languageCode') IS NULL OR json_type(address, '$.languageCode') IS 'text') AND (json_type(address, '$.locality') IS NULL OR json_type(address, '$.locality') IS 'text') AND (json_type(address, '$.sublocality') IS NULL OR json_type(address, '$.sublocality') IS 'text') AND (json_type(address, '$.administrativeArea') IS NULL OR json_type(address, '$.administrativeArea') IS 'text') AND (json_type(address, '$.postalCode') IS NULL OR json_type(address, '$.postalCode') IS 'text'))),
	CONSTRAINT "business_locations_categories_check" CHECK(categories IS NULL OR (json_valid(categories) AND json_type(categories) IS 'array')),
	CONSTRAINT "business_locations_opening_hours_check" CHECK(opening_hours IS NULL OR (json_valid(opening_hours) AND json_type(opening_hours) IS 'object' AND json_type(opening_hours, '$.periods') IS 'array')),
	CONSTRAINT "business_locations_special_hours_check" CHECK(special_hours IS NULL OR (json_valid(special_hours) AND json_type(special_hours) IS 'array'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_locations_organization_id_slug_unique` ON `business_locations` (`organization_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `business_locations_organization_id_id_unique` ON `business_locations` (`organization_id`,`id`);--> statement-breakpoint
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
	CONSTRAINT "content_documents_role_check" CHECK((row_role = 'root' AND root_id IS NULL AND root_role IS NULL AND locale IS NOT NULL) OR (row_role = 'representation' AND root_id IS NOT NULL AND root_id <> id AND root_role = 'root' AND locale IS NOT NULL AND product_id IS NULL AND location_id IS NULL AND scope_path IS NULL AND status IS NULL AND visibility IS NULL AND source IS NULL AND author_id IS NULL AND published_at IS NULL AND first_published_at IS NULL)),
	CONSTRAINT "content_documents_path_check" CHECK(path IS NULL OR (path LIKE '/%' AND path NOT LIKE '//%')),
	CONSTRAINT "content_documents_page_copy_check" CHECK(kind <> 'page' OR (path IS NOT NULL AND title IS NOT NULL)),
	CONSTRAINT "content_documents_qa_scope_check" CHECK(kind <> 'qa' OR row_role <> 'root' OR ((location_id IS NULL OR scope_path IS NULL) AND (scope_path IS NULL OR scope_path LIKE '/%'))),
	CONSTRAINT "content_documents_article_visibility_check" CHECK(kind NOT IN ('article','social_post') OR row_role <> 'root' OR (visibility IN ('listed','unlisted')) IS 1),
	CONSTRAINT "content_documents_qa_state_check" CHECK(kind <> 'qa' OR row_role <> 'root' OR ((status IN ('published','hidden')) IS 1 AND (source IN ('manual','import','template')) IS 1)),
	CONSTRAINT "content_documents_publication_check" CHECK(row_role <> 'root' OR kind NOT IN ('article', 'social_post') OR (status IN ('draft','published')) IS 1),
	CONSTRAINT "content_documents_social_lifecycle_check" CHECK(kind <> 'social_post' OR row_role <> 'root' OR ((status = 'draft' AND published_at IS NULL) OR (status = 'published' AND published_at IS NOT NULL))),
	CONSTRAINT "content_documents_article_lifecycle_check" CHECK(kind <> 'article' OR row_role <> 'root' OR status <> 'published' OR published_at IS NOT NULL),
	CONSTRAINT "content_documents_copy_required_check" CHECK(row_role <> 'root' OR ((kind NOT IN ('page','article','qa') OR title IS NOT NULL) AND (kind NOT IN ('article','social_post') OR slug IS NOT NULL))),
	CONSTRAINT "content_documents_social_source_check" CHECK(kind <> 'social_post' OR row_role <> 'root' OR (source IN ('manual','template')) IS 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_product_root_unique` ON `content_documents` (`organization_id`,`product_id`) WHERE row_role = 'root' AND product_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_root_locale_unique` ON `content_documents` (`root_id`,`locale`) WHERE row_role = 'representation';--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_route_unique` ON `content_documents` (`organization_id`,`locale`,`path`) WHERE row_role IN ('root','representation') AND path IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_slug_unique` ON `content_documents` (`organization_id`,`kind`,`locale`,`slug`) WHERE row_role IN ('root','representation') AND slug IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_links_org_unique` ON `content_documents` (`organization_id`) WHERE row_role = 'root' AND kind = 'page' AND json_extract(metadata_json, '$.recipe') = 'links';--> statement-breakpoint
CREATE INDEX `content_documents_org_kind_status_idx` ON `content_documents` (`kind`,`row_role`,`status`,`sort_order`);--> statement-breakpoint
CREATE INDEX `content_documents_location_kind_status_idx` ON `content_documents` (`location_id`,`kind`,`row_role`,`status`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_documents_scope_role_unique` ON `content_documents` (`organization_id`,`id`,`row_role`,`kind`);--> statement-breakpoint
CREATE TABLE `google_calendar_cleanup_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`account_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`event_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` text,
	`lease_token` text,
	`lease_until` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "google_calendar_cleanup_state_check" CHECK(state IN ('pending', 'error', 'deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_calendar_cleanup_provider_unique` ON `google_calendar_cleanup_jobs` (`calendar_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `google_calendar_cleanup_due_idx` ON `google_calendar_cleanup_jobs` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `google_calendar_event_links` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`integration_revision` text NOT NULL,
	`account_id` text NOT NULL,
	`calendar_id` text NOT NULL,
	`event_id` text NOT NULL,
	`booking_kind` text NOT NULL,
	`operational_id` text NOT NULL,
	`request_id` text,
	`booking_revision` text NOT NULL,
	`synced_revision` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`lease_token` text,
	`lease_until` text,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "google_calendar_kind_check" CHECK(booking_kind IN ('booking', 'reservation')),
	CONSTRAINT "google_calendar_state_check" CHECK(state IN ('pending', 'synced', 'cleanup', 'deleted', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_calendar_subject_unique` ON `google_calendar_event_links` (`organization_id`,`integration_revision`,`booking_kind`,`operational_id`) WHERE state <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX `google_calendar_provider_unique` ON `google_calendar_event_links` (`calendar_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `google_calendar_due_idx` ON `google_calendar_event_links` (`organization_id`,`state`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `google_calendar_setup` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`started_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `guest_thread_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_message_id` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `activity_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "guest_thread_deliveries_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "guest_thread_deliveries_provider_check" CHECK((channel = 'email' AND provider IN ('resend', 'log_only')) OR (channel = 'whatsapp' AND provider IN ('meta', 'log_only')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_thread_deliveries_provider_message_unique` ON `guest_thread_deliveries` (`provider`,`provider_message_id`) WHERE provider_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `guest_thread_deliveries_entry_status_idx` ON `guest_thread_deliveries` (`entry_id`,`status`);--> statement-breakpoint
CREATE TABLE `inventory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_variant_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_variant_id`) REFERENCES `product_variants`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inventory_items_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_items_org_id_unique` ON `inventory_items` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_items_variant_unique` ON `inventory_items` (`product_variant_id`);--> statement-breakpoint
CREATE TABLE `inventory_levels` (
	`organization_id` text NOT NULL,
	`inventory_item_id` text NOT NULL,
	`location_id` text NOT NULL,
	`on_hand` integer DEFAULT 0 NOT NULL,
	`reserved` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`inventory_item_id`, `location_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`inventory_item_id`) REFERENCES `inventory_items`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inventory_levels_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "inventory_levels_quantities_check" CHECK(on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)
);
--> statement-breakpoint
CREATE INDEX `inventory_levels_location_idx` ON `inventory_levels` (`location_id`);--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expiresAt` integer NOT NULL,
	`inviterId` text NOT NULL,
	`teamId` text,
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
CREATE TABLE `location_reservation_configs` (
	`duration_minutes` integer,
	`location_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`slot_capacity` integer,
	`advance_notice_minutes` integer,
	`minimum_guest_age` integer,
	`deposit_required` integer DEFAULT 0 NOT NULL,
	`deposit_amount` integer,
	`deposit_currency` text,
	`deposit_tax_behavior` text,
	`deposit_trigger_party_size` integer,
	`free_cancellation_until_minutes` integer,
	`reschedule_allowed` integer DEFAULT 1 NOT NULL,
	`reschedule_cutoff_minutes` integer,
	`accessibility_contact_required` integer DEFAULT 0 NOT NULL,
	`additional_notes_html` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "location_reservation_configs_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "location_reservation_configs_booleans_check" CHECK(deposit_required IN (0, 1) AND reschedule_allowed IN (0, 1) AND accessibility_contact_required IN (0, 1)),
	CONSTRAINT "location_reservation_configs_duration_check" CHECK(duration_minutes IS NULL OR duration_minutes > 0),
	CONSTRAINT "location_reservation_configs_slot_capacity_check" CHECK(slot_capacity IS NULL OR slot_capacity >= 0),
	CONSTRAINT "location_reservation_configs_minutes_check" CHECK((advance_notice_minutes IS NULL OR advance_notice_minutes >= 0) AND (free_cancellation_until_minutes IS NULL OR free_cancellation_until_minutes >= 0) AND (reschedule_cutoff_minutes IS NULL OR reschedule_cutoff_minutes >= 0)),
	CONSTRAINT "location_reservation_configs_party_check" CHECK(deposit_trigger_party_size IS NULL OR deposit_trigger_party_size > 0),
	CONSTRAINT "location_reservation_configs_deposit_check" CHECK((deposit_amount IS NULL OR deposit_amount > 0) AND (deposit_currency IS NULL OR (length(deposit_currency) = 3 AND deposit_currency = upper(deposit_currency))) AND (deposit_tax_behavior IS NULL OR deposit_tax_behavior IN ('inclusive', 'exclusive'))),
	CONSTRAINT "location_reservation_configs_age_check" CHECK(minimum_guest_age IS NULL OR minimum_guest_age >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `location_reservation_configs_org_location_unique` ON `location_reservation_configs` (`organization_id`,`location_id`);--> statement-breakpoint
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
	CONSTRAINT "media_placements_owner_type_check" CHECK(owner_type IN ('organization', 'business_location', 'product', 'content_document', 'content_block', 'review', 'review_request', 'activity_entry')),
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
CREATE INDEX `member_userId_organizationId_idx` ON `member` (`userId`,`organizationId`);--> statement-breakpoint
CREATE INDEX `member_organizationId_idx` ON `member` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_id_organizationId_unique` ON `member` (`id`,`organizationId`);--> statement-breakpoint
CREATE TABLE `member_scheduling` (
	`member_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`timezone` text NOT NULL,
	`weekly_json` text NOT NULL,
	`time_off_json` text NOT NULL,
	`windows_json` text NOT NULL,
	`windows_until` text NOT NULL,
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
	FOREIGN KEY (`member_id`,`organization_id`) REFERENCES `member`(`id`,`organizationId`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_scheduling_org_idx` ON `member_scheduling` (`organization_id`);--> statement-breakpoint
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
	`public` integer DEFAULT 0 NOT NULL,
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
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`metadata` text,
	`stripeCustomerId` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`logo` text,
	`consultation_settings_json` text,
	`settings_json` text DEFAULT '{"config":{"default_timezone":"UTC"}}' NOT NULL,
	`theme_id` text DEFAULT 'saya-theme-v1' NOT NULL,
	`subdomain` text,
	`brand_description` text,
	`contact_email` text,
	`contact_phone` text,
	`default_currency` text,
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
	CONSTRAINT "organization_consultation_settings_check" CHECK(consultation_settings_json IS NULL OR (json_valid(consultation_settings_json) AND json_type(consultation_settings_json) IS 'object' AND json_extract(consultation_settings_json, '$.mode') IN ('external_url', 'native_disabled', 'native') AND json_type(consultation_settings_json, '$.cta_label') IS 'text' AND json_type(consultation_settings_json, '$.schedule_path') IS 'text' AND json_extract(consultation_settings_json, '$.schedule_path') LIKE '/%' AND json_type(consultation_settings_json, '$.confirmation_path') IS 'text' AND json_extract(consultation_settings_json, '$.confirmation_path') LIKE '/%' AND json_type(consultation_settings_json, '$.tracking_enabled') IN ('true', 'false') AND (json_type(consultation_settings_json, '$.metadata_json') IS NULL OR json_type(consultation_settings_json, '$.metadata_json') IN ('null', 'object')) AND (json_type(consultation_settings_json, '$.external_url') IS NULL OR json_type(consultation_settings_json, '$.external_url') IN ('null', 'text'))) IS TRUE),
	CONSTRAINT "organization_config_palette_check" CHECK(json_type(settings_json, '$.config.palette') IS NULL OR (json_type(settings_json, '$.config.palette.light') IS 'object' AND json_type(settings_json, '$.config.palette.dark') IS 'object') IS TRUE),
	CONSTRAINT "organization_config_font_preset_check" CHECK(json_type(settings_json, '$.config.font_preset') IS NULL OR json_type(settings_json, '$.config.font_preset') IS 'text'),
	CONSTRAINT "organization_config_press_email_check" CHECK(json_type(settings_json, '$.config.press_email') IS NULL OR json_type(settings_json, '$.config.press_email') IS 'text'),
	CONSTRAINT "organization_config_partnerships_email_check" CHECK(json_type(settings_json, '$.config.partnerships_email') IS NULL OR json_type(settings_json, '$.config.partnerships_email') IS 'text'),
	CONSTRAINT "organization_config_catering_email_check" CHECK(json_type(settings_json, '$.config.catering_email') IS NULL OR json_type(settings_json, '$.config.catering_email') IS 'text'),
	CONSTRAINT "organization_config_careers_email_check" CHECK(json_type(settings_json, '$.config.careers_email') IS NULL OR json_type(settings_json, '$.config.careers_email') IS 'text'),
	CONSTRAINT "organization_config_default_timezone_check" CHECK(json_type(settings_json, '$.config.default_timezone') IS 'text' AND length(json_extract(settings_json, '$.config.default_timezone')) > 0),
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
CREATE TABLE `organization_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`target_id` text NOT NULL,
	`target_name` text NOT NULL,
	`measurement_id` text,
	`verified` integer,
	`verification_token` text,
	`status` text,
	`last_error` text,
	`revision` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organization_integrations_provider_check" CHECK(provider IN ('facebook', 'instagram', 'discord', 'google_analytics', 'google_search_console', 'google_calendar')),
	CONSTRAINT "organization_integrations_values_check" CHECK(trim(account_id) <> '' AND trim(target_id) <> '' AND trim(target_name) <> '' AND trim(revision) <> ''),
	CONSTRAINT "organization_integrations_measurement_check" CHECK((provider = 'google_analytics') = (measurement_id IS NOT NULL)),
	CONSTRAINT "organization_integrations_verification_check" CHECK((provider = 'google_search_console') = (verified IS NOT NULL) AND (verification_token IS NULL OR provider = 'google_search_console') AND (verified IS NULL OR verified IN (0, 1))),
	CONSTRAINT "organization_integrations_calendar_check" CHECK((provider = 'google_calendar') = (status IS NOT NULL) AND (status IS NULL OR status IN ('active', 'disabled', 'error')) AND (provider = 'google_calendar' OR (status IS NULL AND last_error IS NULL))),
	CONSTRAINT "organization_integrations_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)
);
--> statement-breakpoint
CREATE INDEX `organization_integrations_account_idx` ON `organization_integrations` (`provider`,`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_integrations_provider_unique` ON `organization_integrations` (`organization_id`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_integrations_target_unique` ON `organization_integrations` (`provider`,`target_id`);--> statement-breakpoint
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
CREATE TABLE `payment_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`stripe_checkout_id` text,
	`checkout_url` text,
	`return_token` text NOT NULL,
	`status` text DEFAULT 'creating' NOT NULL,
	`expires_at` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_idempotency_key_unique` ON `payment_attempts` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `payment_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text,
	`payment_id` text NOT NULL,
	`action` text NOT NULL,
	`amount` integer NOT NULL,
	`note` text,
	`expires_at` text NOT NULL,
	`approved_at` text,
	`consumed_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `payment_billing_accounts` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`stripe_billing_customer_id` text NOT NULL,
	`metronome_customer_id` text,
	`metronome_contract_id` text,
	`contract_start_at` text NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL
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
	`assigned_member_id` text,
	`buyer_user_id` text,
	`request_id` text,
	`payment_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`calendar_group` text,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`converted_booking_id` text,
	`converted_reservation_id` text,
	FOREIGN KEY (`buyer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_holds_quantity_check" CHECK(quantity > 0 AND amount > 0),
	CONSTRAINT "payment_holds_subject_check" CHECK((product_id IS NOT NULL AND variant_id IS NOT NULL AND price_id IS NOT NULL AND session_id IS NOT NULL AND converted_reservation_id IS NULL) OR (product_id IS NULL AND variant_id IS NULL AND price_id IS NULL AND session_id IS NULL AND location_id IS NOT NULL AND timezone IS NOT NULL AND calendar_group IS NULL AND assigned_member_id IS NULL AND converted_booking_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_checkout_holds_payment_id_unique` ON `payment_checkout_holds` (`payment_id`);--> statement-breakpoint
CREATE INDEX `payment_holds_capacity_idx` ON `payment_checkout_holds` (`session_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `payment_holds_calendar_idx` ON `payment_checkout_holds` (`organization_id`,`calendar_group`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `payment_holds_reservation_idx` ON `payment_checkout_holds` (`organization_id`,`location_id`,`starts_at`,`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `payment_claims` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`claimed_at` text,
	`claimed_user_id` text,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`claimed_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
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
	`amount` integer NOT NULL,
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
	CONSTRAINT "payment_refunds_amount_check" CHECK(amount > 0)
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
CREATE TABLE `payment_usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`payment_id` text,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`amount` integer NOT NULL,
	`billing_basis_json` text,
	`source_id` text NOT NULL,
	`provider_occurred_at` text NOT NULL,
	`delivery_at` text,
	`error` text,
	`billing_timestamp` text,
	`credit_note_id` text,
	`dead_letter_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_usage_events_source_id_unique` ON `payment_usage_events` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_usage_events_credit_note_id_unique` ON `payment_usage_events` (`credit_note_id`);--> statement-breakpoint
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
	`captured_amount` integer DEFAULT 0 NOT NULL,
	`refunded_amount` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`stripe_payment_intent_id` text,
	`stripe_charge_id` text,
	`receipt_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`buyer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "payments_amounts_check" CHECK(amount >= 0 AND captured_amount >= 0 AND refunded_amount >= 0 AND refunded_amount <= captured_amount),
	CONSTRAINT "payments_currency_check" CHECK(length(currency) = 3 AND currency = upper(currency))
);
--> statement-breakpoint
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
	`error_code` text,
	`error_message` text,
	`published_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
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
CREATE TABLE `product_availability_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`location_id` text,
	`timezone` text NOT NULL,
	`weekday` integer NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text,
	`interval_minutes` integer,
	`interval_weeks` integer DEFAULT 1 NOT NULL,
	`effective_from_date` text,
	`effective_until_date` text,
	`duration_minutes` integer,
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
	CONSTRAINT "product_availability_rules_repeat_check" CHECK((end_time IS NULL) = (interval_minutes IS NULL) AND (end_time IS NULL OR (end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time < '24:00' AND end_time > start_time)) AND (interval_minutes IS NULL OR interval_minutes > 0)),
	CONSTRAINT "product_availability_rules_interval_check" CHECK(interval_weeks >= 1),
	CONSTRAINT "product_availability_rules_anchor_check" CHECK(interval_weeks = 1 OR effective_from_date IS NOT NULL),
	CONSTRAINT "product_availability_rules_dates_check" CHECK((effective_from_date IS NULL OR date(effective_from_date, '+0 days') IS effective_from_date) AND (effective_until_date IS NULL OR date(effective_until_date, '+0 days') IS effective_until_date) AND (effective_from_date IS NULL OR effective_until_date IS NULL OR effective_until_date >= effective_from_date)),
	CONSTRAINT "product_availability_rules_duration_check" CHECK(duration_minutes IS NULL OR duration_minutes > 0),
	CONSTRAINT "product_availability_rules_capacity_check" CHECK(capacity IS NULL OR capacity >= 0),
	CONSTRAINT "product_availability_rules_timezone_check" CHECK(timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_availability_rules_slot_unique` ON `product_availability_rules` (`product_id`,`location_id`,`weekday`,`start_time`,`interval_weeks`) WHERE location_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_availability_rules_neutral_slot_unique` ON `product_availability_rules` (`product_id`,`weekday`,`start_time`,`interval_weeks`) WHERE location_id IS NULL;--> statement-breakpoint
CREATE INDEX `product_availability_rules_product_idx` ON `product_availability_rules` (`product_id`,`weekday`,`start_time`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_availability_rules_org_id_unique` ON `product_availability_rules` (`organization_id`,`id`);--> statement-breakpoint
CREATE TABLE `product_booking_configs` (
	`product_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`duration_minutes` integer,
	`default_capacity` integer,
	`confirmation_mode` text DEFAULT 'instant' NOT NULL,
	`online_payment_required` integer DEFAULT 0 NOT NULL,
	`online_timezone` text,
	`calendar_group` text,
	`scheduling_mode` text DEFAULT 'legacy' NOT NULL,
	`assigned_member_id` text,
	`assigned_team_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`assigned_team_id`) REFERENCES `team`(`organizationId`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_booking_configs_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "product_booking_configs_duration_check" CHECK(duration_minutes IS NULL OR duration_minutes > 0),
	CONSTRAINT "product_booking_configs_capacity_check" CHECK(default_capacity IS NULL OR default_capacity >= 0),
	CONSTRAINT "product_booking_configs_confirmation_check" CHECK(confirmation_mode IN ('instant', 'review')),
	CONSTRAINT "product_booking_configs_payment_check" CHECK(online_payment_required IN (0, 1)),
	CONSTRAINT "product_booking_configs_calendar_check" CHECK(calendar_group IS NULL OR (length(trim(calendar_group)) > 0 AND online_timezone IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_booking_configs_org_product_unique` ON `product_booking_configs` (`organization_id`,`product_id`);--> statement-breakpoint
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
CREATE TABLE `product_option_values` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_option_id` text NOT NULL,
	`value` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`product_option_id`) REFERENCES `product_options`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_option_values_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "product_option_values_value_not_blank_check" CHECK(trim(value) <> ''),
	CONSTRAINT "product_option_values_sort_order_check" CHECK(sort_order >= 0)
);
--> statement-breakpoint
CREATE INDEX `product_option_values_option_sort_idx` ON `product_option_values` (`product_option_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_option_values_option_id_unique` ON `product_option_values` (`organization_id`,`product_id`,`product_option_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_option_values_option_value_unique` ON `product_option_values` (`organization_id`,`product_option_id`,`value`);--> statement-breakpoint
CREATE TABLE `product_options` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_options_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "product_options_name_not_blank_check" CHECK(trim(name) <> ''),
	CONSTRAINT "product_options_sort_order_check" CHECK(sort_order >= 0)
);
--> statement-breakpoint
CREATE INDEX `product_options_product_sort_idx` ON `product_options` (`product_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_options_product_id_unique` ON `product_options` (`organization_id`,`product_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_options_product_name_unique` ON `product_options` (`organization_id`,`product_id`,`name`);--> statement-breakpoint
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
	`assigned_member_id` text,
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
CREATE UNIQUE INDEX `product_sessions_location_instant_unique` ON `product_sessions` (`product_id`,`location_id`,`starts_at`) WHERE location_id IS NOT NULL AND assigned_member_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_sessions_neutral_instant_unique` ON `product_sessions` (`product_id`,`starts_at`) WHERE location_id IS NULL AND assigned_member_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_sessions_provider_location_instant_unique` ON `product_sessions` (`product_id`,`location_id`,`starts_at`,`assigned_member_id`) WHERE location_id IS NOT NULL AND assigned_member_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_sessions_provider_neutral_instant_unique` ON `product_sessions` (`product_id`,`starts_at`,`assigned_member_id`) WHERE location_id IS NULL AND assigned_member_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `product_sessions_product_start_idx` ON `product_sessions` (`product_id`,`starts_at`,`status`);--> statement-breakpoint
CREATE INDEX `product_sessions_location_start_idx` ON `product_sessions` (`location_id`,`starts_at`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_sessions_org_id_unique` ON `product_sessions` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_sessions_org_product_id_unique` ON `product_sessions` (`organization_id`,`product_id`,`id`);--> statement-breakpoint
CREATE TABLE `product_variant_option_values` (
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_variant_id` text NOT NULL,
	`product_option_id` text NOT NULL,
	`product_option_value_id` text NOT NULL,
	PRIMARY KEY(`product_variant_id`, `product_option_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`product_variant_id`) REFERENCES `product_variants`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`product_option_id`) REFERENCES `product_options`(`organization_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`product_id`,`product_option_id`,`product_option_value_id`) REFERENCES `product_option_values`(`organization_id`,`product_id`,`product_option_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_variant_option_values_variant_idx` ON `product_variant_option_values` (`product_variant_id`);--> statement-breakpoint
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
	CONSTRAINT "products_kind_check" CHECK(kind IN ('dish', 'experience', 'service', 'item')),
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
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`claimed_at` text,
	`processed_at` text,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "public_resource_cache_invalidations_instants_check" CHECK((claimed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+0 days') IS claimed_at) AND (processed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', processed_at, '+0 days') IS processed_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)),
	CONSTRAINT "public_resource_cache_invalidations_attempt_count_check" CHECK(attempt_count >= 0)
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
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`organization_id` text,
	`location_id` text,
	`user_id` text,
	`review_id` text,
	`conversation_state` text,
	`resolved_at` text,
	`archived_at` text,
	`archived_by_user_id` text,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `business_locations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`archived_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requests_instants_check" CHECK((resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at, '+0 days') IS resolved_at) AND (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', archived_at, '+0 days') IS archived_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "requests_payload_check" CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
	CONSTRAINT "requests_guest_payload_check" CHECK((json_type(payload_json, '$.guest.name') IS 'text' AND json_type(payload_json, '$.guest.email') IS 'text' AND (json_type(payload_json, '$.guest.phone') IS 'text' OR json_type(payload_json, '$.guest.phone') IS 'null'))),
	CONSTRAINT "requests_message_payload_check" CHECK(kind <> 'contact' OR json_type(payload_json, '$.message') IS 'text'),
	CONSTRAINT "requests_scope_check" CHECK(organization_id IS NOT NULL),
	CONSTRAINT "requests_state_check" CHECK(conversation_state IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requests_review_owner_unique` ON `requests` (`organization_id`,`id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `requests_scope_id_unique` ON `requests` (`organization_id`,`id`);--> statement-breakpoint
CREATE INDEX `requests_org_activity_idx` ON `requests` (`conversation_state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `requests_org_kind_idx` ON `requests` (`kind`,`location_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `requests_org_user_idx` ON `requests` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `requests_org_archive_activity_idx` ON `requests` (`organization_id`,`archived_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `requests_org_created_idx` ON `requests` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `requests_guest_email_idx` ON `requests` (lower(payload_json ->> '$.guest.email'));--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`location_id` text NOT NULL,
	`user_id` text,
	`request_id` text,
	`timezone` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`party_size` integer NOT NULL,
	`policy_json` text,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`cancelled_at` text,
	`cancellation_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`location_id`) REFERENCES `business_locations`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`request_id`) REFERENCES `requests`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reservations_status_check" CHECK(status IN ('confirmed', 'cancelled')),
	CONSTRAINT "reservations_policy_check" CHECK(policy_json IS NULL OR (json_valid(policy_json) AND json_type(policy_json) = 'object' AND json_type(policy_json, '$.reschedule_allowed') IN ('true', 'false') AND json_type(policy_json, '$.free_cancellation_until_minutes') IN ('null', 'integer') AND json_type(policy_json, '$.reschedule_cutoff_minutes') IN ('null', 'integer')) IS 1),
	CONSTRAINT "reservations_instants_check" CHECK((strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+0 days') IS starts_at) AND (strftime('%Y-%m-%dT%H:%M:%fZ', ends_at, '+0 days') IS ends_at) AND (cancelled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at, '+0 days') IS cancelled_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "reservations_interval_check" CHECK(ends_at > starts_at),
	CONSTRAINT "reservations_party_size_check" CHECK(party_size > 0),
	CONSTRAINT "reservations_timezone_check" CHECK(timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_request_unique` ON `reservations` (`request_id`) WHERE request_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `reservations_location_start_idx` ON `reservations` (`location_id`,`starts_at`,`status`);--> statement-breakpoint
CREATE INDEX `reservations_org_created_idx` ON `reservations` (`created_at`);--> statement-breakpoint
CREATE INDEX `reservations_org_user_idx` ON `reservations` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `resource_localizations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`locale` text NOT NULL,
	`document_role` text GENERATED ALWAYS AS ('representation') VIRTUAL,
	`values_json` text NOT NULL,
	`route_path` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_by_user_id` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by_user_id` text NOT NULL,
	FOREIGN KEY (`organization_id`,`locale`,`document_role`) REFERENCES `organization_locales`(`organization_id`,`locale`,`document_role`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "resource_localizations_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "resource_localizations_values_json_check" CHECK(json_valid(values_json) AND json_type(values_json) = 'object'),
	CONSTRAINT "resource_localizations_route_path_check" CHECK(route_path IS NULL OR (route_path LIKE '/' || locale || '/%' AND route_path NOT LIKE '%?%' AND route_path NOT LIKE '%#%' AND route_path NOT LIKE '%//%'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_localizations_org_locale_route_unique` ON `resource_localizations` (`organization_id`,`locale`,`route_path`) WHERE route_path IS NOT NULL;--> statement-breakpoint
CREATE INDEX `resource_localizations_org_locale_type_idx` ON `resource_localizations` (`organization_id`,`locale`,`resource_type`);--> statement-breakpoint
CREATE INDEX `resource_localizations_resource_idx` ON `resource_localizations` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `resource_localizations_org_resource_locale_unique` ON `resource_localizations` (`organization_id`,`resource_type`,`resource_id`,`locale`);--> statement-breakpoint
CREATE TABLE `review_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`location_id` text,
	`booking_type` text NOT NULL,
	`booking_id` text NOT NULL,
	`token_hash` text NOT NULL,
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
	FOREIGN KEY (`organization_id`,`booking_id`,`booking_type`) REFERENCES `requests`(`organization_id`,`id`,`kind`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_requests_instants_check" CHECK((expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS expires_at) AND (first_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', first_sent_at, '+0 days') IS first_sent_at) AND (reminder_sent_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', reminder_sent_at, '+0 days') IS reminder_sent_at) AND (submitted_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', submitted_at, '+0 days') IS submitted_at) AND (clicked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', clicked_at, '+0 days') IS clicked_at) AND (revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at, '+0 days') IS revoked_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_requests_token_hash_unique` ON `review_requests` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_requests_active_booking_unique` ON `review_requests` (`booking_type`,`booking_id`) WHERE revoked_at IS NULL AND submitted_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_review_requests_send_due` ON `review_requests` (`organization_id`,`first_sent_at`,`reminder_sent_at`,`submitted_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `review_requests_organization_id_idx` ON `review_requests` (`organization_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`location_id` text,
	`booking_id` text,
	`booking_type` text,
	`review_request_id` text,
	`user_id` text,
	`product_id` text,
	`author_name` text,
	`rating` integer NOT NULL,
	`title` text,
	`content` text,
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
	FOREIGN KEY (`review_request_id`) REFERENCES `review_requests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`entered_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`product_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reviews_instants_check" CHECK((owner_reply_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', owner_reply_at, '+0 days') IS owner_reply_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at) AND (updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at)),
	CONSTRAINT "reviews_google_review_metadata_check" CHECK(google_review_metadata IS NULL OR (json_valid(google_review_metadata) AND json_type(google_review_metadata) IS 'object')),
	CONSTRAINT "reviews_rating_check" CHECK(rating BETWEEN 1 AND 5),
	CONSTRAINT "reviews_product_scope_check" CHECK(product_id IS NULL OR organization_id IS NOT NULL),
	CONSTRAINT "reviews_owner_entered_provenance_check" CHECK(source != 'owner_entered' OR (organization_id IS NOT NULL AND location_id IS NULL AND entered_by_user_id IS NOT NULL AND collection_method IS NOT NULL AND publication_authorized = 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_google_review_scope_unique` ON `reviews` (`organization_id`,`location_id`,`google_review_id`);--> statement-breakpoint
CREATE INDEX `idx_reviews_request_id` ON `reviews` (`review_request_id`);--> statement-breakpoint
CREATE INDEX `reviews_org_user_idx` ON `reviews` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_reviews_location_status` ON `reviews` (`location_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reviews_org_status` ON `reviews` (`status`,`created_at`) WHERE location_id IS NULL;--> statement-breakpoint
CREATE INDEX `idx_reviews_product_status_created` ON `reviews` (`product_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `reviews_organization_id_idx` ON `reviews` (`organization_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`activeOrganizationId` text,
	`activeTeamId` text,
	`impersonatedBy` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`userId`);--> statement-breakpoint
CREATE TABLE `stripe_connected_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`stripe_account_id` text,
	`country` text,
	`livemode` integer NOT NULL,
	`status` text DEFAULT 'creating' NOT NULL,
	`card_payments_status` text,
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
	`claimed_at` text,
	`lease_expires_at` text,
	`claim_token` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "stripe_webhook_events_instants_check" CHECK((claimed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+0 days') IS claimed_at) AND (lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at, '+0 days') IS lease_expires_at) AND (created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)),
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
CREATE TABLE `team` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`organizationId` text NOT NULL,
	`memberCount` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_organizationId_idx` ON `team` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_org_id_unique` ON `team` (`organizationId`,`id`);--> statement-breakpoint
CREATE TABLE `teamMember` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`userId` text NOT NULL,
	`membershipKey` text,
	`createdAt` integer,
	FOREIGN KEY (`teamId`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teamMember_membershipKey_unique` ON `teamMember` (`membershipKey`);--> statement-breakpoint
CREATE INDEX `teamMember_teamId_idx` ON `teamMember` (`teamId`);--> statement-breakpoint
CREATE INDEX `teamMember_userId_idx` ON `teamMember` (`userId`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
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
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "usage_events_instants_check" CHECK((created_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at)),
	CONSTRAINT "usage_events_metadata_json_check" CHECK(metadata_json IS NULL OR (json_valid(metadata_json)))
);
--> statement-breakpoint
CREATE INDEX `usage_events_organization_resource_created_idx` ON `usage_events` (`organization_id`,`resource`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_events_org_created_idx` ON `usage_events` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_organization_id_idempotency_key_unique` ON `usage_events` (`organization_id`,`idempotency_key`);--> statement-breakpoint
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
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `category`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_notification_preferences_category_check" CHECK(category IN ('account_security', 'reservations_bookings', 'guest_messages', 'reviews', 'review_requests', 'organization_and_billing', 'product_news')),
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
