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
	`assigned_team_id` text,
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
	FOREIGN KEY (`organization_id`,`assigned_team_id`) REFERENCES `team`(`organizationId`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_kind_check" CHECK(kind IN ('turnover', 'guest_reply', 'message_delivery', 'review_reply', 'opportunity', 'custom')
    AND (subject_type IS NULL) = (subject_id IS NULL)
    AND (subject_type IS NULL OR subject_type IN ('stay', 'request', 'scheduled_guest_message', 'review', 'article', 'post', 'product'))
    AND (kind <> 'custom' OR subject_type IS NULL)
    AND ((kind = 'opportunity') = (opportunity_id IS NOT NULL))),
	CONSTRAINT "tasks_text_check" CHECK((title IS NULL OR length(trim(title)) BETWEEN 1 AND 200) AND (kind NOT IN ('custom', 'opportunity') OR title IS NOT NULL)
    AND (notes IS NULL OR length(trim(notes)) BETWEEN 1 AND 5000) AND (outcome_note IS NULL OR length(trim(outcome_note)) BETWEEN 1 AND 5000)
    AND length(trim(dedupe_key)) > 0 AND timezone <> '' AND timezone NOT GLOB '*[^A-Za-z0-9/_+-]*'),
	CONSTRAINT "tasks_assignee_check" CHECK(assigned_member_id IS NULL OR assigned_team_id IS NULL),
	CONSTRAINT "tasks_window_check" CHECK(starts_at IS NULL OR due_at IS NULL OR starts_at <= due_at),
	CONSTRAINT "tasks_status_check" CHECK(status IN ('open', 'done', 'skipped', 'cancelled') AND (status = 'open') = (closed_at IS NULL) AND (status <> 'open' OR closed_by_user_id IS NULL) AND (status <> 'skipped' OR outcome_note IS NOT NULL) AND version >= 1),
	CONSTRAINT "tasks_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (starts_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', starts_at, '+0 days') IS starts_at) AND (due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at, '+0 days') IS due_at) AND (closed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', closed_at, '+0 days') IS closed_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_dedupe_key_unique` ON `tasks` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_opportunity_unique` ON `tasks` (`opportunity_id`) WHERE opportunity_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `tasks_status_due_idx` ON `tasks` (`organization_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_member_status_due_idx` ON `tasks` (`organization_id`,`assigned_member_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_team_status_due_idx` ON `tasks` (`organization_id`,`assigned_team_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_subject_idx` ON `tasks` (`subject_type`,`subject_id`);--> statement-breakpoint
-- Every recommendation_feedback row becomes the business's opportunity at its
-- evidence revision. Feedback was per person; the latest decision about a
-- reference is the business's. accept -> accepted with its task, dismiss and
-- correct -> dismissed keeping the note, defer -> open until defer_until.
INSERT INTO `opportunities` (`id`, `organization_id`, `operation`, `subject_id`, `evidence_revision`, `goal_id`, `goal_revision`, `status`, `available_at`, `decision_note`, `decided_at`, `decided_by_user_id`, `created_at`, `updated_at`)
SELECT `id`, `organization_id`, `operation`, `subject_id`, `evidence_revision`, `goal_id`, `goal_revision`,
  CASE `decision` WHEN 'accept' THEN 'accepted' WHEN 'dismiss' THEN 'dismissed' WHEN 'correct' THEN 'dismissed' WHEN 'defer' THEN 'open' END,
  `defer_until`, `note`,
  CASE WHEN `decision` IN ('accept', 'dismiss', 'correct') THEN `updated_at` END,
  CASE WHEN `decision` IN ('accept', 'dismiss', 'correct') THEN `user_id` END,
  `created_at`, `updated_at`
FROM (SELECT *, row_number() OVER (PARTITION BY `organization_id`, `operation`, `subject_id`, `evidence_revision`, coalesce(`goal_id`, '') ORDER BY `updated_at` DESC, `id` DESC) AS `latest` FROM `recommendation_feedback`)
WHERE `latest` = 1;--> statement-breakpoint
INSERT INTO `tasks` (`id`, `organization_id`, `kind`, `subject_type`, `subject_id`, `product_id`, `opportunity_id`, `title`, `assigned_member_id`, `timezone`, `status`, `dedupe_key`, `version`, `created_by_user_id`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), o.`organization_id`, 'opportunity',
  CASE WHEN o.`operation` IN ('article.update', 'article.publish', 'article.distribute') THEN 'article' WHEN o.`operation` = 'post.publish' THEN 'post'
    WHEN o.`operation` = 'product.payment' AND p.`id` IS NOT NULL THEN 'product' WHEN o.`operation` = 'stay.gap' AND p.`id` IS NOT NULL THEN 'product'
    WHEN o.`operation` = 'guest_thread.reply' THEN 'request' END,
  CASE WHEN o.`operation` IN ('article.update', 'article.publish', 'article.distribute', 'post.publish', 'guest_thread.reply') THEN o.`subject_id`
    WHEN o.`operation` IN ('product.payment', 'stay.gap') THEN p.`id` END,
  p.`id`, o.`id`,
  CASE o.`operation` WHEN 'article.create' THEN 'Write a blog article' WHEN 'article.update' THEN 'Update the article' WHEN 'article.publish' THEN 'Publish the blog draft'
    WHEN 'article.distribute' THEN 'Share the article' WHEN 'post.create' THEN 'Prepare a photo post' WHEN 'post.publish' THEN 'Finish sharing the post'
    WHEN 'social.connect' THEN 'Connect your social account' WHEN 'google_ads.connect' THEN 'Connect Google Ads' WHEN 'payments.connect' THEN 'Finish your payment setup'
    WHEN 'product.payment' THEN 'Take payment at booking' WHEN 'stay.gap' THEN 'Fill the calendar gap' WHEN 'guest_thread.reply' THEN 'Reply to the guest' END,
  m.`id`, org.`timezone`, 'open', 'opportunity:' || o.`id`, 1, o.`decided_by_user_id`, o.`decided_at`, o.`decided_at`
FROM `opportunities` o JOIN `organization` org ON org.`id` = o.`organization_id`
LEFT JOIN `member` m ON m.`organizationId` = o.`organization_id` AND m.`userId` = o.`decided_by_user_id`
LEFT JOIN `products` p ON p.`organization_id` = o.`organization_id` AND p.`id` = CASE WHEN o.`operation` = 'stay.gap' THEN json_extract(o.`subject_id`, '$[0]') WHEN o.`operation` = 'product.payment' THEN o.`subject_id` END
WHERE o.`status` = 'accepted';--> statement-breakpoint
DROP TABLE `recommendation_feedback`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_media_placements` (
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
	CONSTRAINT "media_placements_owner_type_check" CHECK(owner_type IN ('organization', 'business_location', 'product', 'collection', 'content_document', 'content_block', 'review', 'review_request', 'activity_entry', 'team_message', 'task')),
	CONSTRAINT "media_placements_sort_order_check" CHECK(sort_order >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_media_placements`("id", "organization_id", "owner_type", "owner_id", "slot", "asset_id", "sort_order", "status", "presentation_json", "created_at", "updated_at") SELECT "id", "organization_id", "owner_type", "owner_id", "slot", "asset_id", "sort_order", "status", "presentation_json", "created_at", "updated_at" FROM `media_placements`;--> statement-breakpoint
DROP TABLE `media_placements`;--> statement-breakpoint
ALTER TABLE `__new_media_placements` RENAME TO `media_placements`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `media_placements_asset_idx` ON `media_placements` (`organization_id`,`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_placements_org_owner_slot_asset_unique` ON `media_placements` (`owner_type`,`owner_id`,`slot`,`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_placements_org_owner_slot_order_unique` ON `media_placements` (`owner_type`,`owner_id`,`slot`,`sort_order`);