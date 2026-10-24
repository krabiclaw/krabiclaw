-- A heading's level is its block's `level` column. Headings written before the
-- writer dropped `data.level` still carry it there, and the MCP page contract
-- refuses that shape, so their pages could not be read or edited through MCP.
-- A stored column level stands; otherwise an integer level from 1 to 6 moves
-- into the column.
UPDATE `content_blocks`
   SET `level` = CASE
         WHEN `level` IS NOT NULL THEN `level`
         WHEN json_type(`data_json`, '$.level') = 'integer' AND json_extract(`data_json`, '$.level') BETWEEN 1 AND 6 THEN json_extract(`data_json`, '$.level')
         ELSE NULL
       END,
       `data_json` = json_remove(`data_json`, '$.level')
 WHERE `type` = 'heading' AND json_type(`data_json`, '$.level') IS NOT NULL;
