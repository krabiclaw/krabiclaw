export interface PublicTenantRedirect {
  toPath: string | null
  statusCode: number | null
  behavior: string
}

export function publicTenantRedirectQuery(organization: string | { sql: string }, path: string) {
  const organizationSql = typeof organization === 'string' ? '?' : organization.sql
  return { query: `WITH request AS (
    SELECT ${organizationSql} AS organization_id, ? AS path, ? AS prefix
  ), route AS (
    SELECT r.organization_id, r.path, COALESCE(localized.locale, source.locale) AS locale,
      CASE WHEN localized.locale IS NULL THEN r.path
        ELSE COALESCE(NULLIF(substr(r.path, length(localized.locale) + 2), ''), '/') END AS page_path
    FROM request r
    JOIN organization_locales source ON source.organization_id = r.organization_id AND source.is_source = 1
    LEFT JOIN organization_locales localized ON localized.organization_id = r.organization_id
      AND localized.locale = r.prefix AND localized.is_source = 0 AND localized.status = 'published'
  )
  SELECT d.to_path AS toPath, d.status_code AS statusCode, d.behavior
    FROM route r JOIN organization_redirects d ON d.organization_id = r.organization_id AND d.locale = r.locale AND d.from_path = r.path
   WHERE NOT EXISTS (
     SELECT 1 FROM content_documents p WHERE p.kind = 'page' AND p.row_role IN ('root','representation')
       AND p.organization_id = r.organization_id AND p.locale = r.locale AND p.path = r.page_path
   )
   LIMIT 1`, params: [...(typeof organization === 'string' ? [organization] : []), path, path.split('/')[1] ?? ''] }
}
