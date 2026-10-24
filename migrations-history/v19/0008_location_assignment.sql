-- Assigned member or team for location management and branch-scoped staff access.
ALTER TABLE `business_locations` ADD `assigned_member_id` text;--> statement-breakpoint
ALTER TABLE `business_locations` ADD `assigned_team_id` text REFERENCES team(id) ON UPDATE no action ON DELETE set null;