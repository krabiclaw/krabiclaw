#!/usr/bin/env node
/**
 * Carries Airbnb listing content onto homes imported before the import had a
 * content stage: for each of an organization's completed imports without a
 * content report, runs the content step through the API and prints its report.
 *
 * Usage:
 *   node scripts/airbnb-content-backfill.mjs --organization-id <id> --base-url https://app.krabiclaw.com --dry-run
 *   node scripts/airbnb-content-backfill.mjs --organization-id <id> --base-url https://app.krabiclaw.com
 *
 * Signs in with CANARY_LOGIN_EMAIL / CANARY_LOGIN_PASSWORD (an owner or admin of
 * the organization), like the other API scripts. --all also refreshes homes
 * that already have a content report.
 */
import { parseArgs } from 'node:util'
import { credentialSession } from './utils/e2e-auth.mjs'

const { values } = parseArgs({
  options: {
    'organization-id': { type: 'string' },
    'base-url': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
  },
  strict: true,
})
const organizationId = values['organization-id']
const baseUrl = values['base-url']
if (!organizationId || !baseUrl) {
  console.error('Usage: node scripts/airbnb-content-backfill.mjs --organization-id <id> --base-url <origin> [--dry-run] [--all]')
  process.exit(1)
}
try { process.loadEnvFile() } catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const { cookie } = await credentialSession(baseUrl, { organizationId })
const api = `${new URL(baseUrl).origin}/api/organizations/${encodeURIComponent(organizationId)}/integrations/airbnb`
const call = async (path, method = 'GET') => {
  const response = await fetch(`${api}${path}`, { method, headers: { cookie, accept: 'application/json', origin: new URL(baseUrl).origin } })
  const body = await response.json()
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${JSON.stringify(body)}`)
  return body
}

const { listings } = await call('/listings')
const imported = listings.filter(listing => listing.import.status === 'imported')
const pending = imported.filter(listing => listing.import.stage === 'complete' && (values.all || listing.import.content === null))
const inProgress = imported.filter(listing => listing.import.stage !== 'complete')
console.log(`${listings.length} listing(s) on the account, ${imported.length} imported, ${pending.length} to fill, ${inProgress.length} still importing (content lands at their content stage).`)
for (const listing of pending) {
  const label = `${listing.id} "${listing.title}" → home ${listing.import.product_id}`
  if (values['dry-run']) {
    console.log(`would fill ${label}`)
    continue
  }
  const result = await call(`/imports/${encodeURIComponent(listing.import.product_id)}/content`, 'POST')
  console.log(`filled ${label}`)
  console.log(JSON.stringify(result.content, null, 2))
}
