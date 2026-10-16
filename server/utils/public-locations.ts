import { PUBLIC_STAY_SQL } from '~/server/domain/stays'

// Published products offered at location `alias`, except `except` when given.
const offeredAtSql = (alias: string, except?: string) => `SELECT 1 FROM product_locations opl
    JOIN product_publications opub ON opub.organization_id = opl.organization_id AND opub.product_id = opl.product_id AND opub.published = 1
   WHERE opl.organization_id = ${alias}.organization_id AND opl.location_id = ${alias}.id AND opl.published = 1${except ? ` AND opl.product_id <> ${except}` : ''}`

/**
 * Whether business location `alias` is on the public site. An active location
 * is, unless the site lets homes and the location offers nothing: a host's own
 * address with no home at it is not a property a guest can stay at.
 */
export function publicLocationSql(alias: string): string {
  return `${alias}.status = 'active' AND (EXISTS (${offeredAtSql(alias)})
    OR NOT EXISTS (SELECT 1 FROM products p JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
                    WHERE p.organization_id = ${alias}.organization_id AND ${PUBLIC_STAY_SQL}))`
}

/**
 * The slug of the one published home location `alias` offers, when that home
 * is all it offers, else NULL. Such a location's public page is its home's.
 */
export function publicLocationHomeSlugSql(alias: string): string {
  return `(SELECT p.slug FROM products p JOIN product_stay_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
     WHERE c.organization_id = ${alias}.organization_id AND c.location_id = ${alias}.id AND ${PUBLIC_STAY_SQL}
       AND NOT EXISTS (${offeredAtSql(alias, 'p.id')})
     LIMIT 1)`
}
