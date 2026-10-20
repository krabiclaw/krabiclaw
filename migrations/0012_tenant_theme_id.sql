-- A legal practice's site wore Blawby's palette, heading face and button and
-- heading styling by default. Those defaults are gone, so each choice a legal
-- site had not made itself is stored as its own, and it looks as it did.
UPDATE `organization`
   SET `settings_json` = json_patch(coalesce(`settings_json`, '{}'), json_object('config', json_object(
         'palette', coalesce(json_extract(`settings_json`, '$.config.palette'), json('{"light":{"ground":"#FBFAF7","surface":"#FFFFFF","text":"#162033","muted":"#565D6A","action":"#25356C","accent":"#C19855"},"dark":{"ground":"#0E0E10","surface":"#18181B","text":"#F4F4F5","muted":"#A1A1AA","action":"#9DB1E6","accent":"#C19855"}}')),
         'font_preset', CASE WHEN coalesce(json_extract(`settings_json`, '$.config.font_preset'), 'default') = 'default' THEN 'marcellus' ELSE json_extract(`settings_json`, '$.config.font_preset') END,
         'button_shape', coalesce(json_extract(`settings_json`, '$.config.button_shape'), 'rounded'),
         'button_casing', coalesce(json_extract(`settings_json`, '$.config.button_casing'), 'uppercase'),
         'button_color', coalesce(json_extract(`settings_json`, '$.config.button_color'), 'accent'),
         'heading_casing', coalesce(json_extract(`settings_json`, '$.config.heading_casing'), 'uppercase'))))
 WHERE `theme_id` = 'blawby-theme-v1';
--> statement-breakpoint
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
--> statement-breakpoint
-- The shield is the hero's own edge now. A divider straight after a hero was
-- drawn as that hero's shield; the hero takes the edge and the divider goes.
-- A divider anywhere else stays a plain section break. Translated documents
-- lose their copy of the divider through its source block.
UPDATE `content_blocks`
   SET `data_json` = json_set(`data_json`, '$.edge', 'shield'), `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE `type` = 'hero' AND `parent_block_id` IS NULL
   AND EXISTS (
     SELECT 1 FROM `content_blocks` `divider`
      WHERE `divider`.`document_id` = `content_blocks`.`document_id` AND `divider`.`parent_block_id` IS NULL AND `divider`.`type` = 'divider'
        AND `divider`.`position` = (SELECT min(`next`.`position`) FROM `content_blocks` `next`
                                      WHERE `next`.`document_id` = `content_blocks`.`document_id` AND `next`.`parent_block_id` IS NULL AND `next`.`position` > `content_blocks`.`position`));
--> statement-breakpoint
DELETE FROM `content_blocks`
 WHERE `type` = 'divider' AND `parent_block_id` IS NULL
   AND EXISTS (
     SELECT 1 FROM `content_blocks` `hero`
      WHERE `hero`.`document_id` = `content_blocks`.`document_id` AND `hero`.`parent_block_id` IS NULL AND `hero`.`type` = 'hero'
        AND `hero`.`position` = (SELECT max(`previous`.`position`) FROM `content_blocks` `previous`
                                   WHERE `previous`.`document_id` = `content_blocks`.`document_id` AND `previous`.`parent_block_id` IS NULL AND `previous`.`position` < `content_blocks`.`position`));
