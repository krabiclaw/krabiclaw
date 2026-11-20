import { assertCalendarDate, localNow, MINUTE_TIME_PATTERN } from '~/utils/timezone'
import { HTTPError } from 'nitro'
import { execute, queryFirst, type DbClient } from '~/server/db'
import { isOrganizationFontPreset, resolveOrganizationFontPreset, type OrganizationFontPreset } from '~/shared/organization-fonts'
import { parseSitePalette, type SitePalette } from '~/shared/site-palette'
import { isSiteRecipeKey, isSiteRecipeValue, parseSiteRecipe, type SiteRecipe } from '~/shared/site-recipe'
import { publicTenantVisibilitySql } from '~/server/utils/public-base'

export interface OrganizationConfig {
  palette?: SitePalette
  font_preset?: OrganizationFontPreset
  button_shape?: SiteRecipe['button_shape']
  button_casing?: SiteRecipe['button_casing']
  button_color?: SiteRecipe['button_color']
  heading_casing?: SiteRecipe['heading_casing']
  press_email?: string
  partnerships_email?: string
  catering_email?: string
  careers_email?: string
  /**
   * Read-only here. It is the Google Analytics integration's measurement id,
   * and choosing a GA4 property is the one thing that writes it — which is why
   * it is absent from WritableOrganizationConfigKey below.
   */
  google_analytics_measurement_id?: string
}

/**
 * The single-value settings a caller may set. `google_analytics_measurement_id`
 * is not one; the palette is an object and is written whole by
 * updateOrganizationSettingsFields.
 */
export type WritableOrganizationConfigKey = Exclude<keyof OrganizationConfig, 'google_analytics_measurement_id' | 'palette'>

const CONFIG_COLUMNS = `
  json_extract(o.settings_json, '$.config.palette') AS palette,
  json_extract(o.settings_json, '$.config.font_preset') AS font_preset,
  json_type(o.settings_json, '$.config.font_preset') AS font_preset_type,
  json_extract(o.settings_json, '$.config.button_shape') AS button_shape,
  json_extract(o.settings_json, '$.config.button_casing') AS button_casing,
  json_extract(o.settings_json, '$.config.button_color') AS button_color,
  json_extract(o.settings_json, '$.config.heading_casing') AS heading_casing,
  json_extract(o.settings_json, '$.config.press_email') AS press_email,
  json_extract(o.settings_json, '$.config.partnerships_email') AS partnerships_email,
  json_extract(o.settings_json, '$.config.catering_email') AS catering_email,
  json_extract(o.settings_json, '$.config.careers_email') AS careers_email,
  (SELECT i.measurement_id FROM organization_integrations i WHERE i.organization_id = o.id AND i.provider = 'google_analytics') AS google_analytics_measurement_id`

type ConfigRow = Record<keyof OrganizationConfig | 'font_preset_type', unknown>

export const getConfig = async (db: DbClient, organizationId: string): Promise<OrganizationConfig> => {
  const row = await queryFirst<ConfigRow>(db, `SELECT ${CONFIG_COLUMNS} FROM organization o WHERE o.id = ?`, [organizationId])
  if (!row) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  return parseConfig(row)
}

function parseConfig(row: ConfigRow): OrganizationConfig {
  const config: OrganizationConfig = {}
  for (const key of ["press_email","partnerships_email","catering_email","careers_email","google_analytics_measurement_id"] as const) {
    const value = row[key]
    if (value == null) continue
    if (typeof value !== 'string') throw new Error('Invalid stored site setting: ' + key)
    config[key] = value
  }
  Object.assign(config, parseSiteRecipe(row))
  // A missing optional setting is the Default. An explicit null or an
  // unsupported stored value is not a valid preset.
  config.font_preset = resolveOrganizationFontPreset(row.font_preset_type === null ? undefined : row.font_preset)
  if (row.palette != null) config.palette = parseSitePalette(JSON.parse(String(row.palette)))
  return config
}

export const resolveLocationTimezone = async (
  db: DbClient,
  organizationId: string,
  locationId: string | null,
): Promise<string> => {
  const location = await queryFirst<{ timezone: string }>(db,
    'SELECT timezone FROM business_locations WHERE id = ? AND organization_id = ?',
    [locationId, organizationId])
  if (!location) throw new HTTPError({ statusCode: 404, statusMessage: 'Location not found' })
  return location.timezone
}

/**
 * Returns true if `dateStr` (YYYY-MM-DD) is strictly before "today" as observed in `timezone`.
 * Workers always run on a UTC clock, so the "today" check must use the venue's zone.
 */
export const isDateBeforeTimezoneToday = (date: string, timezone: string): boolean => {
  assertCalendarDate(date)
  return date < localNow(timezone).date
}
export const isTimeSlotInPast = (date: string, time: string, timezone: string, now = new Date()): boolean => {
  assertCalendarDate(date)
  if (!MINUTE_TIME_PATTERN.test(time)) throw new Error('Invalid booking time')
  const current = localNow(timezone, now)
  return date === current.date ? time <= current.time : date < current.date
}

export const setConfig = async (
  db: DbClient,
  organizationId: string,
  key: WritableOrganizationConfigKey,
  value: string
) => {
  if (key === 'font_preset' && !isOrganizationFontPreset(value)) throw new HTTPError({ statusCode: 422, statusMessage: 'Unsupported organization font preset' })
  if (isSiteRecipeKey(key) && !isSiteRecipeValue(key, value)) throw new HTTPError({ statusCode: 422, statusMessage: `Unsupported ${key.replace('_', ' ')}` })
  const result = await execute(
    db,
    `UPDATE organization SET settings_json = json_set(settings_json, ?, ?),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
    ['$.config.' + key, value, organizationId],
  )
  if (result.meta?.changes !== 1) throw new HTTPError({ statusCode: 409, statusMessage: 'Organization ownership changed. Reload before saving.' })
}

export const deleteConfig = async (
  db: DbClient,
  organizationId: string,
  key: WritableOrganizationConfigKey
) => {
  const result = await execute(
    db,
    `UPDATE organization SET settings_json = json_remove(settings_json, ?),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
    ['$.config.' + key, organizationId],
  )
  if (result.meta?.changes !== 1) throw new HTTPError({ statusCode: 409, statusMessage: 'Organization ownership changed. Reload before saving.' })
}

export const PUBLIC_CONFIG_COLUMNS = `${CONFIG_COLUMNS},
  json_extract(o.settings_json, '$.config.announcement') AS announcement_json,
  (SELECT ma.public_url FROM media_placements mp
    JOIN media_assets ma ON ma.id = mp.asset_id AND ma.status = 'active'
    WHERE mp.organization_id = o.id AND mp.owner_type = 'organization' AND mp.owner_id = o.id
      AND mp.slot = 'announcement' AND mp.sort_order = 0 AND mp.status = 'active' LIMIT 1) AS announcement_public_url`

export type PublicConfigRow = ConfigRow & {
  default_currency: string | null
  announcement_json: string | null
  announcement_public_url: string | null
}

/** Canonical public site settings and announcement, shared by API and SSR. */
export async function getPublicConfig(db: DbClient, organizationId: string, options: { previewAuthorized?: boolean } = {}) {
  const organization = await queryFirst<PublicConfigRow>(db, `
    SELECT ${PUBLIC_CONFIG_COLUMNS}, o.default_currency FROM organization o
     WHERE o.id = ? AND ${publicTenantVisibilitySql('o', options.previewAuthorized)}
     LIMIT 1
  `, [organizationId])
  if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  return publicConfigFromRow(organization)
}

export function publicConfigFromRow(organization: PublicConfigRow) {
  const parsedAnnouncement = organization.announcement_json ? JSON.parse(organization.announcement_json) : null
  const announcement = parsedAnnouncement && parsedAnnouncement.enabled === true
    ? {
        headline: parsedAnnouncement.headline ?? null,
        description: parsedAnnouncement.description ?? null,
        cta_label: parsedAnnouncement.cta_label ?? null,
        cta_url: parsedAnnouncement.cta_url ?? null,
        dismissible: parsedAnnouncement.dismissible ?? true,
        format: parsedAnnouncement.format === 'banner' ? 'banner' : 'modal',
        image_url: organization.announcement_public_url,
      }
    : null

  const config = { ...parseConfig(organization), default_currency: organization.default_currency }
  return { success: true, config, announcement }
}
