-- Location-scoped team dispatch threads for branch floor and kitchen coordination.
ALTER TABLE `team_threads` ADD `location_id` text REFERENCES business_locations(id) ON UPDATE no action ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `team_threads_org_location_idx` ON `team_threads` (`organization_id`,`location_id`);
