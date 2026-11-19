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
export const CHANNEX_PROPERTY_HOMES = `(
  SELECT origin.property_id, origin.organization_id, current.product_id, current.enabled, current.import_stage
  FROM product_channel_mappings origin
  LEFT JOIN activity_entries merge ON merge.organization_id = origin.organization_id AND merge.event_name = 'stay.updated'
    AND json_extract(merge.payload_json, '$.metadata.merged_product_id') = origin.product_id
  JOIN product_channel_mappings current ON current.organization_id = origin.organization_id AND current.provider = origin.provider
    AND current.product_id = COALESCE(json_extract(merge.payload_json, '$.entityId'), origin.product_id)
  WHERE origin.provider = 'channex' AND origin.property_id IS NOT NULL
)`
