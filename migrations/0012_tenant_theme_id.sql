-- Every customer site renders with the same components now; its theme id says
-- only that it is a customer site rather than KrabiClaw's own. The column's
-- 'saya-theme-v1' default changes with the next replacement database, since
-- SQLite rebuilds a table to change a default.
UPDATE `organization` SET `theme_id` = 'tenant-theme-v1' WHERE `theme_id` IN ('saya-theme-v1', 'blawby-theme-v1');
--> statement-breakpoint
-- A block's picture is its `media` slot, the one the editor and MCP write.
-- Customer call-to-action blocks were drawn from a `background` slot instead;
-- the picture a visitor saw there becomes the block's media, replacing any
-- media that block never showed.
DELETE FROM `media_placements`
 WHERE `owner_type` = 'content_block' AND `slot` = 'media'
   AND `owner_id` IN (SELECT `id` FROM `content_blocks` WHERE `type` IN ('cta', 'contact_cta', 'booking_cta'))
   AND `owner_id` IN (SELECT `owner_id` FROM `media_placements` WHERE `owner_type` = 'content_block' AND `slot` = 'background');
--> statement-breakpoint
UPDATE `media_placements` SET `slot` = 'media'
 WHERE `owner_type` = 'content_block' AND `slot` = 'background'
   AND `owner_id` IN (SELECT `id` FROM `content_blocks` WHERE `type` IN ('cta', 'contact_cta', 'booking_cta'));
--> statement-breakpoint
-- No other block ever drew a background picture, and the slot is retired.
DELETE FROM `media_placements` WHERE `owner_type` = 'content_block' AND `slot` = 'background';
