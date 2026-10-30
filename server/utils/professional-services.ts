import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { HTTPError } from 'nitro';
import { z } from 'zod'
import type {
  PublicCompliance,
  PublicComplianceContactPoint,
  PublicConsultationSettings,
} from '~/types/public-site'

const consultationSettingsSchema = z.object({
  mode: z.enum(['native', 'external_url', 'native_disabled']),
  cta_label: z.string().trim().min(1),
  external_url: z.url({ protocol: /^https?$/, normalize: true, abort: true }).refine(value => {
    const destination = new URL(value)
    return !destination.username && !destination.password
  }, 'external_url must be an absolute HTTP or HTTPS URL without credentials').nullable(),
  schedule_path: z.string().trim().startsWith('/'),
  confirmation_path: z.string().trim().startsWith('/'),
  metadata_json: z.looseObject({}).nullable().optional(),
}).superRefine((settings, context) => {
  if (settings.mode === 'external_url' && settings.external_url === null) {
    context.addIssue({ code: 'custom', path: ['external_url'], message: 'An external scheduler URL is required' })
  }
})


export async function initializePublicConsultationSettings(db: DbClient, organizationId: string, settings: Omit<NonNullable<import('~/shared/organization-settings').OrganizationSettings['consultation']>, 'created_at' | 'updated_at' | 'updated_by'>, writeGuard?: BatchQuery) {
  const validated = consultationSettingsSchema.parse(settings)
  await executeBatch(db, [...(writeGuard ? [writeGuard] : []), {
    query: `UPDATE organization SET consultation_settings_json = json(?), updated_at = ? WHERE id = ? AND consultation_settings_json IS NULL`,
    params: [JSON.stringify({ ...validated, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: null }), new Date().toISOString(), organizationId],
  }, publicResourceCacheInvalidationQuery(organizationId, 'consultation_settings_initialized')], { operation: 'Initialize consultation settings' })
}

/** Only this adapter writes consultation settings. */
export async function setPublicConsultationMode(db: DbClient, organizationId: string, mode: PublicConsultationSettings['mode'], externalUrl?: unknown): Promise<PublicConsultationSettings> {
  const settings = await getPublicConsultationSettings(db, organizationId)
  const validated = consultationSettingsSchema.safeParse({ ...settings, mode, external_url: externalUrl === undefined ? settings.external_url : externalUrl })
  if (!validated.success) {
    throw new HTTPError({ statusCode: 400, statusMessage: validated.error.issues[0]!.message, data: { code: 'INVALID_CONSULTATION_SETTINGS', issues: validated.error.issues }, cause: validated.error })
  }
  const external = validated.data.external_url
  const now = new Date().toISOString()
  await executeBatch(db, [{
    query: `UPDATE organization SET consultation_settings_json = json_set(consultation_settings_json, '$.mode', ?, '$.external_url', ?, '$.updated_at', ?), updated_at = ? WHERE id = ?`,
    params: [mode, external, now, now, organizationId],
  }, publicResourceCacheInvalidationQuery(organizationId, 'consultation_mode_changed')], { operation: 'Set consultation mode' })
  return { ...settings, mode, external_url: external }
}

export async function getOptionalPublicConsultationSettings(db: DbClient, organizationId: string): Promise<PublicConsultationSettings | null> {
  const row = await queryFirst<{ consultation_settings_json: string }>(db, `
    SELECT consultation_settings_json
      FROM organization
     WHERE id = ? AND json_type(consultation_settings_json) = 'object'
     LIMIT 1
  `, [organizationId])

  if (!row) return null
  let settings: z.output<typeof consultationSettingsSchema>
  try {
    settings = consultationSettingsSchema.parse(JSON.parse(row.consultation_settings_json) as unknown)
  } catch (error) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'Stored professional-service consultation settings are invalid', data: { code: 'INVALID_STORED_CONTENT' }, cause: error })
  }
  const { metadata_json: _metadata, ...consultation } = settings
  return consultation
}

export async function getPublicConsultationSettings(db: DbClient, organizationId: string): Promise<PublicConsultationSettings> {
  const consultation = await getOptionalPublicConsultationSettings(db, organizationId)
  if (!consultation) throw new HTTPError({ statusCode: 500, statusMessage: 'Professional-service consultation settings are missing', data: { code: 'CONSULTATION_SETTINGS_MISSING' } })
  return consultation
}

export async function getPublicCompliance(db: DbClient, organizationId: string): Promise<PublicCompliance | null> {
  const row = await queryFirst<ApiRecord>(db, `
    SELECT json_extract(settings_json, '$.compliance.entity_name') AS entity_name,
           json_extract(settings_json, '$.compliance.dba_name') AS dba_name,
           json_extract(settings_json, '$.compliance.entity_type') AS entity_type,
           json_extract(settings_json, '$.compliance.nonprofit_status') AS nonprofit_status,
           json_extract(settings_json, '$.compliance.registration_number') AS registration_number,
           json_extract(settings_json, '$.compliance.service_area') AS service_area,
           json_extract(settings_json, '$.compliance.service_area_type') AS service_area_type,
           json_extract(settings_json, '$.compliance.disclaimer') AS disclaimer,
           json_extract(settings_json, '$.compliance.footer_disclaimer') AS footer_disclaimer,
           json_extract(settings_json, '$.compliance.founder_name') AS founder_name,
           json_extract(settings_json, '$.compliance.founding_date') AS founding_date,
           json_extract(settings_json, '$.compliance.same_as') AS same_as,
           json_extract(settings_json, '$.compliance.contact_points') AS contact_points,
           json_extract(settings_json, '$.compliance.address_visibility') AS address_visibility
      FROM organization
     WHERE id = ? AND json_type(settings_json, '$.compliance') = 'object'
     LIMIT 1
  `, [organizationId])
  if (!row) return null
  const mediaRows = await queryAll<ApiRecord>(db, `
    SELECT ma.id, ma.public_url, ma.kind, ma.alt_text, ma.file_name,
           mp.slot
      FROM media_placements mp
      JOIN media_assets ma ON ma.id = mp.asset_id AND ma.status = 'active'
     WHERE mp.organization_id = ? AND mp.owner_type = 'organization' AND mp.owner_id = ?
       AND mp.slot = 'compliance_document' AND mp.status = 'active'
     ORDER BY mp.sort_order
  `, [organizationId, organizationId])
  return {
    entity_name: typeof row.entity_name === 'string' ? row.entity_name : null,
    dba_name: typeof row.dba_name === 'string' ? row.dba_name : null,
    entity_type: typeof row.entity_type === 'string' ? row.entity_type : null,
    nonprofit_status: typeof row.nonprofit_status === 'string' ? row.nonprofit_status : null,
    registration_number: typeof row.registration_number === 'string' ? row.registration_number : null,
    service_area: typeof row.service_area === 'string' ? row.service_area : null,
    service_area_type: typeof row.service_area_type === 'string' ? row.service_area_type : null,
    disclaimer: typeof row.disclaimer === 'string' ? row.disclaimer : null,
    footer_disclaimer: typeof row.footer_disclaimer === 'string' ? row.footer_disclaimer : null,
    media: mediaRows.map(item => ({
      asset_id: String(item.id),
      slot: String(item.slot),
      public_url: typeof item.public_url === 'string' && item.public_url ? item.public_url : null,
      kind: typeof item.kind === 'string' ? item.kind : null,
      alt_text: typeof item.alt_text === 'string' ? item.alt_text : null,
      file_name: typeof item.file_name === 'string' ? item.file_name : null,
    })),
    founder_name: typeof row.founder_name === 'string' ? row.founder_name : null,
    founding_date: typeof row.founding_date === 'string' ? row.founding_date : null,
    same_as: row.same_as ? JSON.parse(row.same_as) as string[] : [],
    contact_points: row.contact_points ? JSON.parse(row.contact_points) as PublicComplianceContactPoint[] : [],
    address_visibility: row.address_visibility === 'visible' ? 'visible' : 'hidden',
  }
}
