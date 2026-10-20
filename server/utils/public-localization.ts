import type { CloudflareEnv } from '~/server/utils/auth'
import {
  parseLocalizedResourceType,
  RESOURCE_LOCALIZATION_REGISTRY,
  validateLocalizedValues,
  type LocalizedResourceType,
  type LocalizedValues,
} from '~/server/utils/localization-registry'
import { PRODUCT_DETAIL_FIELDS, type ProductKind } from '~/shared/product-details'
import { HTTPError } from 'nitro'
import { queryAll, type DbClient } from '~/server/db'
import { assertPublicOrganizationLanguageEntitlement } from '~/server/utils/localization'
import { isRecord } from '~/server/utils/type-guards'

export interface StoredPublicLocalizationRow {
  resource_type: string
  product_kind?: ProductKind
  resource_id: string
  locale: string
  values_json: string
  route_path: string | null
}

export interface ExactPublicLocalization {
  resourceType: LocalizedResourceType
  resourceId: string
  locale: string
  values: LocalizedValues
  routePath: string | null
}

export async function loadExactPublicLocalizations(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  locale: string,
): Promise<ExactPublicLocalization[]> {
  const entitlement = await assertPublicOrganizationLanguageEntitlement(env, db, organizationId, locale)
  if (entitlement.source) throw new HTTPError({ statusCode: 404, statusMessage: 'Primary-language routes are unprefixed' })
  const rows = await queryAll<StoredPublicLocalizationRow>(db, `
    SELECT rl.resource_type, rl.resource_id, rl.locale, rl.values_json, rl.route_path, p.kind AS product_kind
      FROM resource_localizations rl
      LEFT JOIN products p ON rl.resource_type = 'product' AND p.id = rl.resource_id AND p.organization_id = rl.organization_id
     WHERE rl.organization_id = ?  AND rl.locale = ?
     ORDER BY rl.resource_type, rl.resource_id
  `, [organizationId, locale])
  return indexStoredPublicLocalizations(rows)
}

function localizedSlug(routePath: string | null): string | null {
  if (!routePath) return null
  return routePath.split('/').filter(Boolean).at(-1) ?? null
}

export function indexStoredPublicLocalizations(
  rows: readonly StoredPublicLocalizationRow[],
): ExactPublicLocalization[] {
  return rows.map((row) => {
    const resourceType = parseLocalizedResourceType(row.resource_type)
    const parsedValues: unknown = JSON.parse(row.values_json)
    return {
      resourceType,
      resourceId: row.resource_id,
      locale: row.locale,
      values: validateLocalizedValues(resourceType, parsedValues, row.product_kind),
      routePath: row.route_path,
    }
  })
}

export function projectExactLocalizedResource<T extends { id: string }>(
  resourceType: LocalizedResourceType,
  canonical: T,
  localization: ExactPublicLocalization,
): T {
  if (localization.resourceType !== resourceType || localization.resourceId !== canonical.id) {
    throw new Error('Localized resource does not match its canonical resource')
  }
  const definition = RESOURCE_LOCALIZATION_REGISTRY[resourceType]
  const canonicalDetails = (canonical as { details?: unknown }).details
  const unlocalizedDetails = Object.fromEntries(PRODUCT_DETAIL_FIELDS.filter(field => !field.localizable).flatMap(field =>
    isRecord(canonicalDetails) && Object.hasOwn(canonicalDetails, field.key) ? [[field.key, canonicalDetails[field.key]]] : []))
  // Clearing a field is the empty state of its declared type. A map of
  // translated attributes empties to a map with nothing in it: "this product
  // has no translated attributes" is a readable answer, an absent map is not.
  // Text empties to '' (or stays null where the resource's own field is
  // nullable) and a list to []: a Product with no translated description is
  // a Product whose description is empty, not one missing the field its
  // contract requires — which is how every /ja page carrying such a product 502'd.
  // An address is not cleared: its translated parts sit on the location's own.
  const clearedValues = Object.fromEntries(
    Object.entries(definition.fields).flatMap(([field, shape]): Array<[string, unknown]> => {
      if (shape === 'details') return [[field, unlocalizedDetails]]
      if (shape === 'string_array') return [[field, []]]
      if (shape === 'text') return [[field, (canonical as Record<string, unknown>)[field] === null ? null : '']]
      return []
    }),
  )
  const projectedValues = { ...localization.values }
  if (isRecord(projectedValues.details)) projectedValues.details = { ...unlocalizedDetails, ...projectedValues.details }
  const titleField: Partial<Record<LocalizedResourceType, string>> = {
    organization: 'name',
    business_location: 'title',
    product: 'name',
    collection: 'name',
  }
  const descriptionField: Partial<Record<LocalizedResourceType, string>> = {
    organization: 'brand_description',
    business_location: 'description',
    product: 'description',
    collection: 'description',
  }
  const localizedTitle = titleField[resourceType] ? projectedValues[titleField[resourceType]] : undefined
  const localizedDescription = descriptionField[resourceType] ? projectedValues[descriptionField[resourceType]] : undefined
  if ('seo_title' in canonical) projectedValues.seo_title = typeof localizedTitle === 'string' ? localizedTitle : null
  if ('seo_description' in canonical) projectedValues.seo_description = typeof localizedDescription === 'string' ? localizedDescription : null
  const slug = localizedSlug(localization.routePath)
  // An address localizes the parts that are words. The ISO region code and the
  // postcode read the same in every language and are not in the translation, so
  // the translated parts sit on top of the location's own address instead of
  // replacing it — otherwise a localized page loses the country it is in.
  const canonicalAddress = (canonical as { address?: unknown }).address
  const addressFields = isRecord(projectedValues.address) && isRecord(canonicalAddress)
    ? { address: { ...canonicalAddress, ...projectedValues.address } }
    : {}

  const routeFields = {
    ...(slug && 'slug' in canonical ? { slug } : {}),
    ...(localization.routePath && 'public_path' in canonical ? { public_path: localization.routePath } : {}),
    ...(localization.routePath && 'canonical_url' in canonical ? { canonical_url: null } : {}),
  }
  return {
    ...canonical,
    ...clearedValues,
    ...projectedValues,
    ...addressFields,
    ...routeFields,
  }
}

export function projectExactLocalizedCollection<T extends { id: string }>(
  resourceType: LocalizedResourceType,
  canonical: readonly T[],
  localizations: readonly ExactPublicLocalization[],
): T[] {
  const byResourceId = new Map(
    localizations
      .filter(localization => localization.resourceType === resourceType)
      .map(localization => [localization.resourceId, localization]),
  )
  return canonical.flatMap((resource) => {
    const localization = byResourceId.get(resource.id)
    return localization
      ? [projectExactLocalizedResource(resourceType, resource, localization)]
      : []
  })
}

export function resolveLocalizedRouteResourceId(
  localizations: readonly ExactPublicLocalization[],
  resourceType: LocalizedResourceType,
  routePath: string,
): string | null {
  return localizations.find(localization =>
    localization.resourceType === resourceType && localization.routePath === routePath,
  )?.resourceId ?? null
}

export function projectLocalizedMediaAlt<T extends { asset_id: string; alt_text: string | null }>(
  media: readonly T[],
  localizations: readonly ExactPublicLocalization[] | null,
): T[] {
  if (localizations === null) return [...media]
  const byResourceId = new Map(
    localizations
      .filter(localization => localization.resourceType === 'media_asset')
      .map(localization => [localization.resourceId, localization]),
  )
  return media.map((asset) => {
    const altText = byResourceId.get(asset.asset_id)?.values.alt_text
    return { ...asset, alt_text: typeof altText === 'string' ? altText : null }
  })
}
