#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnYarn } from './utils/spawn-yarn.mjs'

// The fixtures targeted by tenant guest journeys and MCP owner tools. Scoping by
// the indexed organization column keeps the email marker queries bounded.
const GUEST_BOOKING_ORG_IDS = ['org-user-pottery-house', 'org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX', 'org-ncls-blawby', 'org-demo']

// The onboarding and lodging actors create throwaway `e2e-*` organizations. Both the
// owning actor and slug must match; copied customer organizations are retained.
// Retained/audit tables are explicit because their organization foreign keys
// are often SET NULL (or intentionally polymorphic), so deleting the
// organization alone would leave rows behind in the local database.
// `reservations` and `bookings` restrict their request's deletion, so they are
// swept first. Order here is the order the statements are emitted in.
const RETAINED_ORG_TABLES = [
  'usage_events',
  'stripe_ga4_subscription_intents',
  'mcp_tool_call_events',
  'activity_entries',
  'analytics_events',
  'analytics_summaries',
  'reservations',
  'bookings',
  'requests',
] as const

const isStdout = process.argv.includes('--stdout')

if (process.argv.includes('--staging') || process.argv.includes('--remote')) {
  console.error('E2E cleanup supports only local disposable data.')
  process.exit(1)
}

// No --remote: the onboarding test actor and reserved guest-email markers
// identify disposable local data, never data to remove from a deployed database.

const ageArg = process.argv.find((arg) => arg.startsWith('--older-than-hours='))
const olderThanHours = ageArg ? Number(ageArg.split('=')[1]) : 2
if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
  console.error('--older-than-hours must be a non-negative number.')
  process.exit(1)
}

const cutoffDate = new Date(Date.now() - olderThanHours * 60 * 60 * 1000)
if (Number.isNaN(cutoffDate.getTime())) {
  console.error('--older-than-hours produced an invalid cutoff date.')
  process.exit(1)
}
const cutoff = cutoffDate.toISOString()
// Better Auth's organization.createdAt stores Unix seconds.
const cutoffUnixSeconds = Math.floor(cutoffDate.getTime() / 1000)

const guestBookingOrgIdList = GUEST_BOOKING_ORG_IDS.map((id) => `'${id}'`).join(', ')

const batchArg = process.argv.find((arg) => arg.startsWith('--batch-size='))
const batchSize = batchArg ? Number(batchArg.split('=')[1]) : 500
if (!Number.isInteger(batchSize) || batchSize <= 0) {
  console.error('--batch-size must be a positive integer.')
  process.exit(1)
}

// Repeat the bounded selector in each statement; D1 remote execution does not allow temporary tables.
const eligibleOrgIds = `
  SELECT o.id FROM organization o
  WHERE o.slug LIKE 'e2e-%'
    AND EXISTS (SELECT 1 FROM member m WHERE m.organizationId = o.id
                AND m.userId IN ('user-e2e-onboarding-wizard', 'user-e2e-lodging-native')
                AND instr(',' || replace(m.role, ' ', '') || ',', ',owner,') > 0)
    AND o.createdAt < ${cutoffUnixSeconds}
  LIMIT ${batchSize}
`

const retainedOrgDeletes = RETAINED_ORG_TABLES.map(table => `
DELETE FROM ${table} WHERE organization_id IN (${eligibleOrgIds});
`).join('\n')

// What a guest booked holds its request open: `reservations` and `bookings`
// reference it ON DELETE RESTRICT, so both are cleared before the request is.
const disposableGuestRequestIds = `
  SELECT id FROM requests
  WHERE organization_id IN (${guestBookingOrgIdList})
    AND kind IN ('contact', 'reservation', 'booking')
    AND (payload_json ->> '$.guest.email' LIKE '%@playwright.example'
         OR (organization_id = 'org-demo' AND payload_json ->> '$.guest.email' LIKE '%@example.test'))
    AND created_at < '${cutoff}'
  ORDER BY id LIMIT ${batchSize}
`

const sql = `-- Sweeps E2E-generated rows from local D1 so they don't accumulate forever.
-- Targets only e2e-* organizations owned by the onboarding or lodging test actor and the
-- reserved guest-email markers used by the local tests.

PRAGMA foreign_keys = ON;

-- Better Auth subscription rows are not organization children, so remove them
-- explicitly.
DELETE FROM subscription WHERE referenceId IN (${eligibleOrgIds});

${retainedOrgDeletes}

UPDATE user_workspace_state
SET whatsapp_pending_confirmation = NULL, whatsapp_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE json_extract(whatsapp_pending_confirmation, '$.organizationId') IN (${eligibleOrgIds})
   OR EXISTS (SELECT 1 FROM json_each(whatsapp_pending_confirmation, '$.candidates') candidate
              WHERE json_extract(candidate.value, '$.organizationId') IN (${eligibleOrgIds}));

UPDATE user_workspace_state
SET organization_id = NULL, location_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE organization_id IN (${eligibleOrgIds})
   OR location_id IN (SELECT id FROM business_locations WHERE organization_id IN (${eligibleOrgIds}));

DELETE FROM organization WHERE id IN (${eligibleOrgIds});

DELETE FROM reservations WHERE request_id IN (${disposableGuestRequestIds});
DELETE FROM bookings WHERE request_id IN (${disposableGuestRequestIds});
DELETE FROM requests WHERE id IN (${disposableGuestRequestIds});

-- Rate counters are transient local request state; each run exercises the real
-- limits from an unspent quota without changing the application's limits.
DELETE FROM rate_limits;
`

// An organization the sweep deletes may own a Stripe customer, created when a
// test drove checkout. Stripe never learns the organization is gone, so the
// customer is deleted here, before the rows that name it. Only a test-mode key
// may run this: the sweep exists for local databases, and a live
// key here would be a configuration fault, not a cleanup.
async function deleteStripeCustomersOfSweptOrganizations(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is required: swept organizations may own Stripe customers')
  if (!/^(?:sk|rk)_test_/.test(key)) throw new Error('reset-e2e-artifacts refuses a live Stripe key')
  // `--file` against a remote database goes through D1's import path, which
  // returns an import summary instead of the rows; `--command` returns them.
  const query = `SELECT stripeCustomerId FROM organization WHERE stripeCustomerId IS NOT NULL AND id IN (${eligibleOrgIds});`
  const result = spawnYarn(['wrangler', 'd1', 'execute', 'DB', '--local', '--command', query, '--json'], { encoding: 'utf8' })
  if (result.error) throw result.error
  const stdout = String(result.stdout ?? '')
  if (result.status !== 0) throw new Error((String(result.stderr ?? '') || stdout || `Wrangler exited ${result.status}`).trim())
  const rows = (JSON.parse(stdout.slice(stdout.indexOf('[')))[0]?.results ?? []) as Array<Record<string, unknown>>
  const customerIds = rows.map((row) => {
    const id = row.stripeCustomerId
    if (typeof id !== 'string' || !id.startsWith('cus_')) throw new Error(`Unexpected D1 row while listing Stripe customers: ${JSON.stringify(row)}`)
    return id
  })
  for (const id of customerIds) {
    const response = await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${key}` } })
    if (response.status === 404) continue
    if (!response.ok) throw new Error(`Stripe customer ${id} was not deleted: ${response.status} ${await response.text()}`)
  }
  console.log(`[reset-e2e-artifacts] Deleted ${customerIds.length} Stripe test customer(s) of swept organizations.`)
}

if (isStdout) {
  process.stdout.write(sql)
} else {
  await deleteStripeCustomersOfSweptOrganizations()
  const dir = mkdtempSync(join(tmpdir(), 'krabiclaw-reset-e2e-'))
  const sqlPath = join(dir, 'reset-e2e-artifacts.sql')

  try {
    writeFileSync(sqlPath, sql, 'utf8')
    const args = ['wrangler', 'd1', 'execute', 'DB', '--local', '--file', sqlPath]
    console.log(`[reset-e2e-artifacts] Applying: corepack yarn ${args.join(' ')}`)
    const result = spawnYarn(args)
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
    console.log('[reset-e2e-artifacts] Done.')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
