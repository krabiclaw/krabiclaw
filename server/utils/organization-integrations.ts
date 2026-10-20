import { HTTPError } from 'nitro'
import type { IntegrationProvider, OrganizationIntegration } from '~/shared/organization-settings'
import { execute, queryAll, queryFirst, type DbClient } from '~/server/db'

/**
 * What an organization connected, one row per provider in
 * `organization_integrations`. The database holds both rules: one Facebook,
 * Instagram, Discord, Analytics and Search Console connection per organization, and
 * each provider resource on at most one organization.
 */

const NAMES: Record<IntegrationProvider, string> = {
  google_calendar: 'Google Calendar connection',
  facebook: 'Facebook connection',
  instagram: 'Instagram connection',
  discord: 'Discord connection',
  google_analytics: 'Google Analytics connection',
  google_ads: 'Google Ads connection',
  google_search_console: 'Search Console connection',
}

const TARGETS: Record<IntegrationProvider, string> = {
  google_calendar: 'That calendar',
  facebook: 'That Page',
  instagram: 'That Instagram account',
  discord: 'That Discord channel',
  google_analytics: 'That Google Analytics property',
  google_ads: 'That Google Ads account',
  google_search_console: 'That Search Console site',
}

const COLUMNS = 'organization_id, provider, account_id, target_id, target_name, measurement_id, verified, verification_token, status, last_error, revision, created_at, updated_at'

type Row = Omit<OrganizationIntegration, 'verified'> & { verified: number | null }
const project = (row: Row): OrganizationIntegration => ({ ...row, verified: row.verified === null ? null : row.verified === 1 })

export async function readIntegration(db: DbClient, organizationId: string, provider: IntegrationProvider): Promise<OrganizationIntegration | null> {
  const row = await queryFirst<Row>(db, `SELECT ${COLUMNS} FROM organization_integrations WHERE organization_id = ? AND provider = ?`, [organizationId, provider])
  return row ? project(row) : null
}

export async function listIntegrations(db: DbClient, organizationId: string): Promise<OrganizationIntegration[]> {
  return (await queryAll<Row>(db, `SELECT ${COLUMNS} FROM organization_integrations WHERE organization_id = ? ORDER BY provider`, [organizationId])).map(project)
}

/** The organizations connected through one linked account. */
export async function integrationsThroughAccount(db: DbClient, provider: IntegrationProvider, accountId: string): Promise<string[]> {
  return (await queryAll<{ organization_id: string }>(db, 'SELECT organization_id FROM organization_integrations WHERE provider = ? AND account_id = ? ORDER BY organization_id', [provider, accountId]))
    .map(row => row.organization_id)
}

export interface IntegrationSelection {
  account_id: string
  target_id: string
  target_name: string
  measurement_id?: string | null
  verified?: boolean | null
  verification_token?: string | null
}

/**
 * Records the organization's selection. With `expected`, the write applies
 * only over that revision: `null` creates a connection only where there is
 * none, and a revision replaces only that row, so a selection read before a
 * disconnect cannot bring the connection back. Without `expected`, the
 * selection replaces whatever is there.
 */
export async function storeIntegration(
  db: DbClient,
  organizationId: string,
  provider: IntegrationProvider,
  selection: IntegrationSelection,
  expected?: { revision: string | null },
): Promise<string> {
  const now = new Date().toISOString()
  const revision = crypto.randomUUID()
  const fields = [selection.account_id, selection.target_id, selection.target_name, selection.measurement_id ?? null,
    selection.verified === undefined || selection.verified === null ? null : Number(selection.verified), selection.verification_token ?? null, revision]
  const replace = `account_id = ?, target_id = ?, target_name = ?, measurement_id = ?, verified = ?, verification_token = ?, revision = ?, updated_at = ?`
  const insert = `INSERT INTO organization_integrations (account_id, target_id, target_name, measurement_id, verified, verification_token, revision, updated_at, id, organization_id, provider, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  const statement = expected?.revision
    ? { query: `UPDATE organization_integrations SET ${replace} WHERE organization_id = ? AND provider = ? AND revision = ?`, params: [...fields, now, organizationId, provider, expected.revision] }
    : expected
      // Only where nothing is connected: a row already there is a conflict.
      ? { query: `${insert} ON CONFLICT (organization_id, provider) DO NOTHING`, params: [...fields, now, crypto.randomUUID(), organizationId, provider, now] }
      : { query: `${insert} ON CONFLICT (organization_id, provider) DO UPDATE SET account_id = excluded.account_id, target_id = excluded.target_id, target_name = excluded.target_name,
          measurement_id = excluded.measurement_id, verified = excluded.verified, verification_token = excluded.verification_token,
          revision = excluded.revision, updated_at = excluded.updated_at`, params: [...fields, now, crypto.randomUUID(), organizationId, provider, now] }
  let changes: number | undefined
  try {
    changes = (await execute(db, statement.query, statement.params)).meta?.changes
  } catch (error) {
    if (/UNIQUE constraint failed: organization_integrations\.provider, organization_integrations\.target_id/.test(messages(error))) {
      throw new HTTPError({ statusCode: 409, message: `${TARGETS[provider]} is already connected to another KrabiClaw site. Disconnect it there first.` })
    }
    throw error
  }
  if (changes !== 1) throw new HTTPError({ statusCode: 409, message: `The ${NAMES[provider]} changed. Reload before saving.` })
  return revision
}

/** Drizzle reports the query and carries D1's own message as its cause. */
function messages(error: unknown): string {
  const parts: string[] = []
  for (let current: unknown = error; current instanceof Error; current = current.cause) parts.push(current.message)
  return parts.join('\n')
}

/** Removes the selection; true when there was one. The linked account is its user's and stays. */
export async function deleteIntegration(db: DbClient, organizationId: string, provider: IntegrationProvider, expected?: { revision: string }): Promise<boolean> {
  const result = await execute(db, `DELETE FROM organization_integrations WHERE organization_id = ? AND provider = ?${expected ? ' AND revision = ?' : ''}`,
    expected ? [organizationId, provider, expected.revision] : [organizationId, provider])
  return (result.meta?.changes ?? 0) > 0
}

/** What the dashboard shows of a connection: names and ids, never the verification token. */
export function integrationSummary(integration: OrganizationIntegration | null) {
  return integration && {
    account_id: integration.account_id, target_id: integration.target_id, target_name: integration.target_name,
    measurement_id: integration.measurement_id, verified: integration.verified,
    status: integration.status, last_error: integration.last_error,
    // Choosing a property, Page or account writes the row, so `created_at` is when this connection was made.
    connected_at: integration.created_at,
  }
}
export type IntegrationSummary = NonNullable<ReturnType<typeof integrationSummary>>
