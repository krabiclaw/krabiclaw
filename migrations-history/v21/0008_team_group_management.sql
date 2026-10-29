ALTER TABLE `team_threads` ADD `name` text;--> statement-breakpoint
ALTER TABLE `team_threads` ADD `is_group` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `team_threads` SET `is_group` = 1
WHERE `stay_id` IS NULL AND `location_id` IS NULL
  AND (SELECT COUNT(*) FROM `team_thread_members` WHERE `thread_id` = `team_threads`.`id`) >= 3;
