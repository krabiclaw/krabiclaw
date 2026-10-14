import { assertCalendarDate, localNow, MINUTE_TIME_PATTERN } from '~/utils/timezone'
import { HTTPError } from 'nitro'
import { execute, queryFirst, type DbClient } from '~/server/db'
import { isOrganizationFontPreset, resolveOrganizationFontPreset, type OrganizationFontPreset } from '~/shared/organization-fonts'
import { parseSitePalette, type SitePalette } from '~/shared/site-palette'

export interface OrganizationConfig {
  palette?: SitePalette
  font_preset?: OrganizationFontPreset
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

export const getConfig = async (
  db: DbClient,
  organizationId: string,
): Promise<OrganizationConfig> => {
  const row = await queryFirst<Record<keyof OrganizationConfig | 'font_preset_type', unknown>>(db, `
    SELECT json_extract(settings_json, '$.config.palette') AS palette,
           json_extract(settings_json, '$.config.font_preset') AS font_preset,
           json_type(settings_json, '$.config.font_preset') AS font_preset_type,
           json_extract(settings_json, '$.config.press_email') AS press_email,
           json_extract(settings_json, '$.config.partnerships_email') AS partnerships_email,
           json_extract(settings_json, '$.config.catering_email') AS catering_email,
           json_extract(settings_json, '$.config.careers_email') AS careers_email,
           (SELECT i.measurement_id FROM organization_integrations i WHERE i.organization_id = organization.id AND i.provider = 'google_analytics') AS google_analytics_measurement_id
      FROM organization WHERE id = ?
  `, [organizationId])
  if (!row) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  const config: OrganizationConfig = {}
  for (const key of ["press_email","partnerships_email","catering_email","careers_email","google_analytics_measurement_id"] as const) {
    const value = row[key]
    if (value == null) continue
    if (typeof value !== 'string') throw new Error('Invalid stored site setting: ' + key)
    config[key] = value
  }
  // A missing optional setting preserves the template. An explicit null or an
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

/** Canonical public site settings and announcement, shared by API and SSR. */
export async function getPublicConfig(db: DbClient, organizationId: string) {
  const organization = await queryFirst<{
    id: string
    default_currency: string
    announcement_json: string | null
    announcement_public_url: string | null
  }>(db, `
    SELECT o.id, o.default_currency,
           json_extract(o.settings_json, '$.config.announcement') AS announcement_json,
           ama.public_url AS announcement_public_url
      FROM organization o
      LEFT JOIN media_placements amp ON amp.organization_id = o.id AND amp.owner_type = 'organization'
        AND amp.owner_id = o.id AND amp.slot = 'announcement' AND amp.sort_order = 0 AND amp.status = 'active'
      LEFT JOIN media_assets ama ON ama.id = amp.asset_id AND ama.status = 'active'
     WHERE o.id = ? AND o.status = 'active' AND o.onboarding_status = 'active'
     LIMIT 1
  `, [organizationId])

  if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })

  const parsedAnnouncement = organization.announcement_json ? JSON.parse(organization.announcement_json) : null
  const announcement = parsedAnnouncement && parsedAnnouncement.enabled === true
    ? {
        headline: parsedAnnouncement.headline ?? null,
        description: parsedAnnouncement.description ?? null,
        cta_label: parsedAnnouncement.cta_label ?? null,
        cta_url: parsedAnnouncement.cta_url ?? null,
        dismissible: parsedAnnouncement.dismissible ?? true,
        image_url: organization.announcement_public_url,
      }
    : null

  const config = { ...await getConfig(db, organization.id), default_currency: organization.default_currency }
  return { success: true, config, announcement }
}
