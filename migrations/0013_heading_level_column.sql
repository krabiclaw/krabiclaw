-- A heading's level is its block's `level` column. Headings written before the
-- writer dropped `data.level` still carry it there, and the MCP page contract
-- refuses that shape, so their pages could not be read or edited through MCP.
UPDATE `content_blocks`
   SET `level` = coalesce(`level`, CAST(json_extract(`data_json`, '$.level') AS INTEGER)),
       `data_json` = json_remove(`data_json`, '$.level')
 WHERE json_type(`data_json`, '$.level') IS NOT NULL;
