/** Public address metadata: venue branches and the addresses of published homes. */
export function publicLocationSql(alias: string): string {
  return `${alias}.status = 'active' AND (EXISTS (SELECT 1 FROM organization o WHERE o.id = ${alias}.organization_id AND o.vertical <> 'lodging')
    OR EXISTS (SELECT 1 FROM product_stay_configs c
      JOIN product_publications pub ON pub.organization_id = c.organization_id AND pub.product_id = c.product_id AND pub.published = 1
      WHERE c.organization_id = ${alias}.organization_id AND c.location_id = ${alias}.id))`
}
