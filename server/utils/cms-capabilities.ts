import { HTTPError } from 'nitro';
import { resolveCmsCapabilities, type ProductFeature } from '~/config/cms-registry'
import { queryFirst, type DbClient } from '~/server/db'
import { resolvePublicTemplate } from '~/utils/template-registry'
import { ALL_VERTICALS, normalizeVertical, type OrganizationVertical } from '~/utils/vertical-copy'

export function resolveOrganizationCmsCapabilities(verticalValue: string, themeId: string, organization: { hasStayProduct: boolean } | null) {
  const normalizedVertical = normalizeVertical(verticalValue)
  if (!ALL_VERTICALS.includes(normalizedVertical as OrganizationVertical)) {
    throw new HTTPError({ statusCode: 422, statusMessage: `Unsupported organization vertical: ${verticalValue}` })
  }
  const template = resolvePublicTemplate({ themeId, vertical: normalizedVertical }).slug
  const vertical = normalizedVertical as OrganizationVertical
  try {
    return { vertical, template, capabilities: resolveCmsCapabilities(vertical, template, organization) }
  } catch {
    throw new HTTPError({ statusCode: 422, statusMessage: `Unsupported CMS capability combination: ${vertical}/${template}` })
  }
}

/** The modules this organization has: its vertical's, and `stays` once it has a stay product. */
export async function loadOrganizationFeatures(db: DbClient, organizationId: string): Promise<readonly ProductFeature[]> {
  const row = await queryFirst<{ vertical: string; theme_id: string; has_stay_product: number }>(db, `SELECT vertical, theme_id,
    EXISTS(SELECT 1 FROM products WHERE organization_id = organization.id AND kind = 'stay') AS has_stay_product
    FROM organization WHERE id = ?`, [organizationId])
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Organization not found', data: { code: 'ORGANIZATION_NOT_FOUND' } })
  return resolveOrganizationCmsCapabilities(row.vertical, row.theme_id, { hasStayProduct: row.has_stay_product === 1 }).capabilities.features
}

/** Places to stay, Airbnb and guest automation exist only for an organization with `stays`. */
export async function requireStays(db: DbClient, organizationId: string): Promise<void> {
  if (!(await loadOrganizationFeatures(db, organizationId)).includes('stays')) {
    throw new HTTPError({ statusCode: 422, message: 'This business has no places to stay', data: { code: 'STAYS_REQUIRED' } })
  }
}
