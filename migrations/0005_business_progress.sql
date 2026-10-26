CREATE TABLE `organization_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`intent` text NOT NULL,
	`constraints` text,
	`target_at` text,
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
CREATE TABLE `recommendation_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`operation` text NOT NULL,
	`subject_id` text NOT NULL,
	`evidence_revision` text NOT NULL,
	`goal_id` text,
	`goal_revision` text,
	`decision` text NOT NULL,
	`note` text,
	`defer_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`goal_id`) REFERENCES `organization_goals`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "recommendation_feedback_operation_check" CHECK(operation IN ('article.update', 'article.publish', 'guest_thread.reply') AND length(trim(subject_id)) > 0),
	CONSTRAINT "recommendation_feedback_revision_check" CHECK(length(evidence_revision) = 64 AND evidence_revision NOT GLOB '*[^a-f0-9]*' AND ((goal_id IS NULL AND goal_revision IS NULL) OR (goal_id IS NOT NULL AND length(trim(goal_id)) > 0 AND goal_revision IS NOT NULL))),
	CONSTRAINT "recommendation_feedback_decision_check" CHECK(decision IN ('accept', 'dismiss', 'defer', 'correct') AND ((decision = 'defer' AND defer_until IS NOT NULL) OR (decision <> 'defer' AND defer_until IS NULL)) AND (decision <> 'correct' OR note IS NOT NULL) AND (note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000)),
	CONSTRAINT "recommendation_feedback_instants_check" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS created_at AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS updated_at AND (goal_revision IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', goal_revision, '+0 days') IS goal_revision) AND (defer_until IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', defer_until, '+0 days') IS defer_until))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recommendation_feedback_reference_unique` ON `recommendation_feedback` (`organization_id`,`user_id`,`operation`,`subject_id`,`evidence_revision`) WHERE "recommendation_feedback"."goal_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `recommendation_feedback_goal_reference_unique` ON `recommendation_feedback` (`organization_id`,`user_id`,`operation`,`subject_id`,`evidence_revision`,`goal_id`,`goal_revision`) WHERE "recommendation_feedback"."goal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `recommendation_feedback_actor_idx` ON `recommendation_feedback` (`organization_id`,`user_id`,`updated_at`);