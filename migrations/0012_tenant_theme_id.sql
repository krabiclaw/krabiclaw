-- Every customer site renders with the same components now; its theme id says
-- only that it is a customer site rather than KrabiClaw's own. The column's
-- 'saya-theme-v1' default changes with the next replacement database, since
-- SQLite rebuilds a table to change a default.
UPDATE `organization` SET `theme_id` = 'tenant-theme-v1' WHERE `theme_id` IN ('saya-theme-v1', 'blawby-theme-v1');
