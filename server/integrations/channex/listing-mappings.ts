/** A listing's provider mapping and the home inventory it shares with other listings. */
export const AIRBNB_MAPPINGS = `(
  SELECT l.listing_id, l.channel_id, l.organization_id, l.product_id, i.provider, i.property_id, i.room_type_id,
    COALESCE(l.rate_plan_id, i.rate_plan_id) AS rate_plan_id, l.rate_plan_id AS listing_rate_plan_id,
    CASE WHEN l.import_stage = 'property' AND i.import_stage = 'complete' THEN 'content'
      WHEN l.import_stage = 'property' THEN i.import_stage ELSE l.import_stage END AS import_stage,
    l.import_stage AS listing_stage, i.import_stage AS inventory_stage, i.import_property,
    l.import_content, l.import_written, l.enabled, l.created_at, l.updated_at
  FROM product_airbnb_listings l JOIN product_channel_mappings i
    ON i.organization_id = l.organization_id AND i.product_id = l.product_id AND i.provider = 'channex'
)`

/** A provider property still identifies its reservations after the host merges its home. */
export const CHANNEX_PROPERTY_HOME = `WITH RECURSIVE home(organization_id, product_id, property_id, distance) AS (
  SELECT organization_id, product_id, property_id, 0 FROM product_channel_mappings
  WHERE provider = 'channex' AND property_id = ?
  UNION ALL
  SELECT home.organization_id, json_extract(merge.payload_json, '$.entityId'), home.property_id, home.distance + 1
  FROM home JOIN activity_entries merge ON merge.organization_id = home.organization_id AND merge.event_name = 'stay.updated'
    AND json_extract(merge.payload_json, '$.metadata.merged_product_id') = home.product_id
)
SELECT home.organization_id, home.product_id, home.property_id, mapped.enabled, mapped.import_stage
FROM home JOIN product_channel_mappings mapped ON mapped.organization_id = home.organization_id
  AND mapped.product_id = home.product_id AND mapped.provider = 'channex'
ORDER BY home.distance DESC LIMIT 1`
