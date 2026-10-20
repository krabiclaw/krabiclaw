-- NCLS's six service pages adopt the Product each one describes (#1287).
--
-- A service is a Product, and its page is the source page bound to it by the
-- root row's product_id. NCLS's service-detail pages were written before that
-- relationship existed, so each gets the missing Product here and is bound to
-- it; the page document itself — its id, path, title, blocks, media,
-- translations and redirects — is not touched.
--
-- Each Product states only what the page already says: the page's title as its
-- name, the path's last segment as its slug, kind service, one default variant
-- named like the product with no price, sale inactive and no booking
-- configuration. Nothing is inferred from the prose. It is published on the
-- site, because a bound page is public while its Product is published and
-- every one of these pages is public now; sale inactive and no location keep
-- it out of every public catalog list. The author is whoever last edited the
-- page.
--
-- Pinned to the six pages by id, and only while unbound: a database without
-- them changes nothing, and a page already bound is left alone, so a replay
-- adds nothing. A page that has moved off the path it was verified at, a blank
-- title, or a slug or id another Product already holds fails this migration
-- (NOT NULL, CHECK or UNIQUE) instead of adopting a document it was not
-- written for.
WITH adoption(page_id, path) AS (VALUES
  ('page-offering_ncls_family', '/services/family'),
  ('page-offering_ncls_small-business-and-nonprofits', '/services/small-business-and-nonprofits'),
  ('page-offering_ncls_employment', '/services/employment'),
  ('page-offering_ncls_tenant-rights', '/services/tenant-rights'),
  ('page-offering_ncls_probate-and-estate', '/services/probate-and-estate'),
  ('page-offering_ncls_special-education-and-iep-advocacy', '/services/special-education-and-iep-advocacy')
)
INSERT INTO products (id, organization_id, kind, name, slug, description, active, details_json, marketing_features, metadata, source, created_by, updated_by)
SELECT 'product-' || substr(a.page_id, 15), d.organization_id, 'service',
       CASE WHEN d.path = a.path THEN trim(d.title) END,
       substr(a.path, 11), '', 0, '{}', '[]', '{}', 'manual',
       COALESCE(d.updated_by, d.created_by), COALESCE(d.updated_by, d.created_by)
  FROM adoption a
  JOIN content_documents d ON d.id = a.page_id
 WHERE d.organization_id = 'org-ncls-blawby' AND d.kind = 'page' AND d.row_role = 'root' AND d.product_id IS NULL;
--> statement-breakpoint
INSERT INTO product_variants (id, organization_id, product_id, name, sku, active, sort_order, created_at, updated_at, created_by, updated_by)
SELECT 'variant-' || substr(p.id, 9), p.organization_id, p.id, p.name, NULL, 1, 0, p.created_at, p.updated_at, p.created_by, p.updated_by
  FROM products p
  JOIN content_documents d ON d.organization_id = p.organization_id AND d.id = 'page-offering_' || substr(p.id, 9)
 WHERE p.organization_id = 'org-ncls-blawby' AND p.id LIKE 'product-ncls\_%' ESCAPE '\'
   AND d.kind = 'page' AND d.row_role = 'root' AND d.product_id IS NULL;
--> statement-breakpoint
INSERT INTO product_publications (organization_id, product_id, published, created_at, updated_at, created_by, updated_by)
SELECT p.organization_id, p.id, 1, p.created_at, p.updated_at, p.created_by, p.updated_by
  FROM products p
  JOIN content_documents d ON d.organization_id = p.organization_id AND d.id = 'page-offering_' || substr(p.id, 9)
 WHERE p.organization_id = 'org-ncls-blawby' AND p.id LIKE 'product-ncls\_%' ESCAPE '\'
   AND d.kind = 'page' AND d.row_role = 'root' AND d.product_id IS NULL;
--> statement-breakpoint
UPDATE content_documents
   SET product_id = 'product-' || substr(id, 15)
 WHERE organization_id = 'org-ncls-blawby' AND kind = 'page' AND row_role = 'root' AND product_id IS NULL
   AND id IN (
     'page-offering_ncls_family',
     'page-offering_ncls_small-business-and-nonprofits',
     'page-offering_ncls_employment',
     'page-offering_ncls_tenant-rights',
     'page-offering_ncls_probate-and-estate',
     'page-offering_ncls_special-education-and-iep-advocacy'
   );
