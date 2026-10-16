import { queryFirst, type DbClient } from '~/server/db'
import { PLATFORM_TEMPLATE } from '~/utils/template-registry'

export interface PlatformTenantIdentity {
  id: string
}

/**
 * KrabiClaw's own tenant is the one organization running the platform template.
 * Request handlers already have it as `event.context.organizationId` once the
 * platform host has resolved; this lookup is for work that runs outside a
 * request for that host (search corpus, llms.txt, analytics roll-ups).
 */
export async function getPlatformOrganization(db: DbClient): Promise<PlatformTenantIdentity> {
  const tenant = await queryFirst<PlatformTenantIdentity>(
    db,
    "SELECT id FROM organization WHERE theme_id = ? AND status = 'active' LIMIT 1",
    [PLATFORM_TEMPLATE.themeId],
  )
  if (!tenant) throw new Error('No active organization runs the platform template')
  return tenant
}
