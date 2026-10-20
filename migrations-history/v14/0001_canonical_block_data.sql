UPDATE content_blocks
SET data_json = json_remove(data_json, '$.section', '$.field')
WHERE json_type(data_json, '$.section') IS NOT NULL OR json_type(data_json, '$.field') IS NOT NULL;
--> statement-breakpoint
UPDATE content_blocks
SET data_json = json_remove(data_json, '$.variant', '$.background')
WHERE type = 'hero' AND (json_type(data_json, '$.variant') IS NOT NULL OR json_type(data_json, '$.background') IS NOT NULL);
--> statement-breakpoint
UPDATE content_blocks
SET data_json = CASE
  WHEN json_extract(data_json, '$.text') = trim(json_extract(data_json, '$.markdown'), '# *')
    THEN json_remove(data_json, '$.markdown')
  ELSE NULL END
WHERE type = 'heading' AND json_type(data_json, '$.markdown') IS NOT NULL;
--> statement-breakpoint
UPDATE content_blocks
SET data_json = CASE
  WHEN json_extract(data_json, '$.source') = 'organization_reviews'
    THEN json_remove(data_json, '$.source')
  ELSE NULL END
WHERE type = 'testimonial_grid' AND json_type(data_json, '$.source') IS NOT NULL;
--> statement-breakpoint
UPDATE content_blocks
SET data_json = CASE
  WHEN json_type(data_json, '$.content') = 'null' THEN json_remove(data_json, '$.content')
  ELSE NULL END
WHERE type = 'hero' AND json_type(data_json, '$.content') IS NOT NULL;
--> statement-breakpoint
UPDATE content_blocks
SET data_json = CASE
  WHEN json_type(data_json, '$.effective_date') = 'null' THEN json_remove(data_json, '$.effective_date')
  ELSE NULL END
WHERE type = 'feature_grid' AND json_type(data_json, '$.effective_date') IS NOT NULL;
--> statement-breakpoint
UPDATE content_blocks
SET data_json = CASE
  WHEN json_type(data_json, '$.updated_at') = 'null' THEN json_remove(data_json, '$.updated_at')
  ELSE NULL END
WHERE type = 'callout' AND json_type(data_json, '$.updated_at') IS NOT NULL;
