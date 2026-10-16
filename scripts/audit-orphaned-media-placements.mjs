#!/usr/bin/env node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnYarn } from './utils/spawn-yarn.mjs'

export const CONTENT_DOCUMENT_SCOPE_QUERY = `
  SELECT d.id, d.organization_id FROM content_documents d
    JOIN organization o ON o.id = d.organization_id
`

const OWNER_TABLES = {
  organization: 'organization', business_location: 'business_locations', collection: 'collections',
  content_document: 'content_documents', review: 'reviews', review_request: 'review_requests',
}

export const MEDIA_PLACEMENT_OWNER_AUDIT_QUERY = `WITH document_scope AS (${CONTENT_DOCUMENT_SCOPE_QUERY})
  SELECT mp.owner_type, COUNT(*) AS orphaned_count FROM media_placements mp
   WHERE NOT (
     ${Object.entries(OWNER_TABLES).map(([ownerType, table]) => `(mp.owner_type = '${ownerType}' AND EXISTS (SELECT 1 FROM ${table} o WHERE o.id = mp.owner_id AND ${ownerType === 'organization' ? 'o.id' : 'o.organization_id'} = mp.organization_id))`).join(' OR ')}
     OR (mp.owner_type = 'content_block' AND EXISTS (SELECT 1 FROM content_blocks b JOIN document_scope d ON d.id = b.document_id WHERE b.id = mp.owner_id AND d.organization_id = mp.organization_id))
     OR (mp.owner_type = 'product' AND EXISTS (SELECT 1 FROM products p JOIN product_publications pp ON pp.product_id = p.id AND pp.organization_id = p.organization_id WHERE p.id = mp.owner_id AND p.organization_id = mp.organization_id))
   ) GROUP BY mp.owner_type ORDER BY mp.owner_type
`

function main() {
  const targets = process.argv.slice(2)
  let failed = false
  for (const target of targets.length ? targets : ['local']) {
    if (!['local', 'staging', 'production'].includes(target)) throw new Error(`Unsupported environment: ${target}`)
    const args = ['wrangler', 'd1', 'execute', 'DB']
    if (target === 'local') args.push('--local')
    else { if (target !== 'production') args.push('--env', target); args.push('--remote') }
    const result = spawnYarn([...args, '--command', MEDIA_PLACEMENT_OWNER_AUDIT_QUERY, '--json'], { encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || `Wrangler exited ${result.status}`).trim())
    const records = JSON.parse(result.stdout)[0]?.results ?? []
    if (records.length === 0) { console.log(`ok  ${target}: every media placement has an owner in the same scope`); continue }
    failed = true
    for (const row of records) console.error(`not ok  ${target}: ${row.orphaned_count} missing or out-of-scope owners for ${row.owner_type}`)
  }
  if (failed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
