ALTER TABLE `post_publications` ADD `initiating_activity_id` text REFERENCES activity_entries(id) ON DELETE SET NULL;
