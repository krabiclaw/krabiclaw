import { HTTPError } from 'nitro'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'

/**
 * The services a business asked KrabiClaw's people for. Managed ads: Chris and
 * Julia run the Google Ads campaigns, billed at the ad-spend rate on the
 * Payments rate card. Agreeing writes the consent; ending it closes the row.
 */
export const SERVICES = ['managed_ads'] as const
export type Service = typeof SERVICES[number]
/** Bump when the terms a business agrees to change; the row keeps the version it agreed to. */
export const SERVICE_TERMS_VERSION: Record<Service, string> = { managed_ads: '2026-10-18' }

export interface ServiceAgreement { id: string; service: Service; terms_version: string; agreed_by_user_id: string | null; agreed_at: string; ended_at: string | null }

export function isService(value: unknown): value is Service {
  return typeof value === 'string' && (SERVICES as readonly string[]).includes(value)
}

/** The current agreement per service, when there is one. */
export async function listServices(db: DbClient, organizationId: string): Promise<Record<Service, ServiceAgreement | null>> {
  const rows = await queryAll<ServiceAgreement>(db, 'SELECT id,service,terms_version,agreed_by_user_id,agreed_at,ended_at FROM organization_services WHERE organization_id=? AND ended_at IS NULL', [organizationId])
  return Object.fromEntries(SERVICES.map(service => [service, rows.find(row => row.service === service) ?? null])) as Record<Service, ServiceAgreement | null>
}

/** The organizations currently on a service, for the work that bills or performs it. */
export async function organizationsOnService(db: DbClient, service: Service): Promise<string[]> {
  return (await queryAll<{ organization_id: string }>(db, 'SELECT organization_id FROM organization_services WHERE service=? AND ended_at IS NULL ORDER BY organization_id', [service])).map(row => row.organization_id)
}

export async function agreeToService(db: DbClient, organizationId: string, service: Service, userId: string): Promise<ServiceAgreement> {
  const current = await queryFirst<{ id: string }>(db, 'SELECT id FROM organization_services WHERE organization_id=? AND service=? AND ended_at IS NULL', [organizationId, service])
  if (current) throw new HTTPError({ statusCode: 409, statusMessage: 'This service is already on' })
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  await execute(db, 'INSERT INTO organization_services(id,organization_id,service,terms_version,agreed_by_user_id,agreed_at) VALUES(?,?,?,?,?,?)', [id, organizationId, service, SERVICE_TERMS_VERSION[service], userId, now])
  const written = (await listServices(db, organizationId))[service]
  if (!written || written.id !== id) throw new Error('Service agreement was not recorded')
  return written
}

export async function endService(db: DbClient, organizationId: string, service: Service, userId: string): Promise<void> {
  const now = new Date().toISOString()
  const result = await execute(db, 'UPDATE organization_services SET ended_at=?,ended_by_user_id=? WHERE organization_id=? AND service=? AND ended_at IS NULL', [now, userId, organizationId, service])
  if (!result.meta.changes) throw new HTTPError({ statusCode: 409, statusMessage: 'This service is not on' })
}
