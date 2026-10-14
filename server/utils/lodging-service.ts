import { APIError } from 'better-auth'

import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { LODGING_INTERNAL_CALLER } from '~/server/utils/internal-secret'
import type { CloudflareEnv } from '~/server/utils/auth'

// The lodging Worker keeps homes, stays and team data keyed by Krabiclaw user
// and organization ids, with no foreign keys of its own. When Krabiclaw deletes
// or changes one of those, it tells the lodging Worker before reporting success
// (docs/shared-auth-contract.md §4.5). Only lodging organizations have anything
// there; no other tenant depends on the lodging Worker.

export async function isLodgingOrganization(db: DbClient, organizationId: string): Promise<boolean> {
  const organization = await queryFirst<{ vertical: string }>(db, 'SELECT vertical FROM organization WHERE id = ?', [organizationId])
  return organization?.vertical === 'lodging'
}

export async function hasLodgingMembership(db: DbClient, userId: string): Promise<boolean> {
  const rows = await queryAll<{ id: string }>(db, `
    SELECT m.id FROM member m JOIN organization o ON o.id = m."organizationId"
    WHERE m."userId" = ? AND o.vertical = 'lodging' LIMIT 1
  `, [userId])
  return rows.length > 0
}

async function callLodging(env: CloudflareEnv, method: 'DELETE' | 'POST', path: string, body?: Record<string, string>): Promise<void> {
  const baseUrl = env.LODGING_API_URL?.trim().replace(/\/$/, '')
  const secret = env.LODGING_SERVICE_SECRET?.trim()
  if (!baseUrl || !secret) {
    throw new APIError('INTERNAL_SERVER_ERROR', { code: 'LODGING_SERVICE_NOT_CONFIGURED', message: 'LODGING_API_URL and LODGING_SERVICE_SECRET are required to change a lodging organization.' })
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: { [LODGING_INTERNAL_CALLER.header]: secret, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    throw new APIError('BAD_GATEWAY', {
      code: 'LODGING_SERVICE_FAILED',
      message: `The lodging service answered ${response.status} to ${method} ${path}: ${(await response.text()).slice(0, 500)}`,
    })
  }
}

export async function deleteLodgingUser(env: CloudflareEnv, userId: string) {
  await callLodging(env, 'DELETE', `/internal/users/${encodeURIComponent(userId)}`)
}

export async function deleteLodgingOrganization(env: CloudflareEnv, organizationId: string) {
  await callLodging(env, 'DELETE', `/internal/organizations/${encodeURIComponent(organizationId)}`)
}

export async function notifyLodgingMembershipChanged(
  env: CloudflareEnv,
  change: { organizationId: string; userId: string } & ({ change: 'removed' } | { change: 'role_changed'; role: string }),
) {
  await callLodging(env, 'POST', '/internal/membership-changed', change)
}
