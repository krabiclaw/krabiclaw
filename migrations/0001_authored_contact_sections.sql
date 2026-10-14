-- Contact sections are authored blocks. Preserve the sections the former
-- hero-only Blawby projection rendered before removing its placement flag.
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM organization
   WHERE json_type(consultation_settings_json, '$.metadata_json.contact_form_enabled') IS NOT NULL
     AND json_type(consultation_settings_json, '$.metadata_json.contact_form_enabled') NOT IN ('true', 'false')
) THEN json('Stored contact form placement flag is invalid') END;
--> statement-breakpoint
WITH contacts AS MATERIALIZED (
  SELECT d.id, d.root_id, d.row_role, d.organization_id, d.locale, hero.position,
         json_type(o.consultation_settings_json, '$.metadata_json.contact_form_enabled') IS NOT 'false' AS form_enabled
    FROM content_documents d
    JOIN organization o ON o.id = d.organization_id
    JOIN content_blocks hero ON hero.document_id = d.id AND hero.type = 'hero'
   WHERE d.kind = 'page' AND d.path = '/contact'
     AND o.vertical = 'service' AND o.theme_id = 'blawby-theme-v1'
     AND (SELECT count(*) FROM content_blocks cb WHERE cb.document_id = d.id) = 1
), locations AS MATERIALIZED (
  SELECT contact.id AS document_id, bl.id
    FROM contacts contact
    JOIN business_locations bl ON bl.organization_id = contact.organization_id AND bl.status = 'active'
   WHERE bl.address IS NOT NULL
      OR trim(COALESCE(bl.description, '')) <> ''
      OR trim(COALESCE(bl.short_description, '')) <> ''
      OR EXISTS (
        SELECT 1 FROM media_placements mp
        JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = bl.organization_id AND ma.status = 'active'
         WHERE mp.organization_id = bl.organization_id AND mp.owner_type = 'business_location'
           AND mp.owner_id = bl.id AND mp.slot = 'hero' AND mp.sort_order = 0 AND mp.status = 'active'
      )
   ORDER BY bl.title, bl.id
), grids AS MATERIALIZED (
  SELECT document_id, json_group_array(id) AS location_ids, count(*) AS location_count
    FROM locations GROUP BY document_id
)
INSERT INTO content_blocks (id, source_block_id, document_id, type, position, data_json)
SELECT 'block-contact-locations-' || contact.id,
       CASE WHEN contact.row_role = 'representation' AND EXISTS (SELECT 1 FROM contacts source WHERE source.id = contact.root_id)
            THEN 'block-contact-locations-' || contact.root_id END,
       contact.id, 'location_grid', contact.position + 1,
       CASE contact.locale
         WHEN 'en' THEN json_object('title', 'Our locations', 'description', 'Contact', 'location_ids', json(grid.location_ids))
         WHEN 'th' THEN json_object('title', grid.location_count || ' จุดให้บริการ ทีมเดียวกัน', 'description', 'ติดต่อ', 'location_ids', json(grid.location_ids))
         WHEN 'ja' THEN json_object('title', grid.location_count || 'の拠点で、ひとつのチームが対応します。', 'description', 'お問い合わせ', 'location_ids', json(grid.location_ids))
         WHEN 'vi' THEN json_object('title', grid.location_count || ' địa điểm, một đội ngũ hỗ trợ.', 'description', 'Liên hệ', 'location_ids', json(grid.location_ids))
       END
  FROM contacts contact JOIN grids grid ON grid.document_id = contact.id
UNION ALL
SELECT 'block-contact-form-' || contact.id,
       CASE WHEN contact.row_role = 'representation' AND EXISTS (SELECT 1 FROM contacts source WHERE source.id = contact.root_id AND source.form_enabled)
            THEN 'block-contact-form-' || contact.root_id END,
       contact.id, 'contact_form', contact.position + 1 + (grid.document_id IS NOT NULL), '{}'
  FROM contacts contact LEFT JOIN grids grid ON grid.document_id = contact.id
 WHERE contact.form_enabled;
--> statement-breakpoint
UPDATE content_documents
   SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE EXISTS (
   SELECT 1 FROM content_blocks cb WHERE cb.document_id = content_documents.id
     AND cb.id IN ('block-contact-locations-' || content_documents.id, 'block-contact-form-' || content_documents.id)
 );
--> statement-breakpoint
INSERT INTO public_resource_cache_invalidations (id, organization_id, reason)
SELECT lower(hex(randomblob(16))), o.id, 'authored_contact_sections'
  FROM organization o
 WHERE json_type(o.consultation_settings_json, '$.metadata_json.contact_form_enabled') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM content_documents d JOIN content_blocks cb ON cb.document_id = d.id
       WHERE d.organization_id = o.id
         AND cb.id IN ('block-contact-locations-' || d.id, 'block-contact-form-' || d.id)
    );
--> statement-breakpoint
UPDATE organization
   SET consultation_settings_json = json_remove(consultation_settings_json, '$.metadata_json.contact_form_enabled'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE json_type(consultation_settings_json, '$.metadata_json.contact_form_enabled') IS NOT NULL;
