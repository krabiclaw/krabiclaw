#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import { credentialSession } from './utils/e2e-auth.mjs'

try {
  process.loadEnvFile()
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const { values: args } = parseArgs({ options: {
  'base-url': { type: 'string', default: 'http://localhost:3000' },
  'organization-id': { type: 'string' },
  'refresh-id': { type: 'string' },
  platform: { type: 'boolean', default: false },
  email: { type: 'string', default: process.env.CANARY_LOGIN_EMAIL },
  password: { type: 'string' },
} })
const baseURL = args['base-url']
if (args['refresh-id'] && (!args['organization-id'] || args.platform)) throw new Error('Specify the refresh ID with its exact organization ID.')
const password = args.password || process.env.CANARY_LOGIN_PASSWORD
if (!args.email || !password) throw new Error('Set CANARY_LOGIN_EMAIL and CANARY_LOGIN_PASSWORD, or pass an explicit email and password.')
const { cookie } = await credentialSession(baseURL, { email: args.email, password })
const headers = { cookie, origin: new URL(baseURL).origin, 'content-type': 'application/json' }
const endpointFor = id => `/api/editor/organizations/${encodeURIComponent(id)}/social-cards/regenerate`
const tenants = []
if (args.platform) tenants.push({ id: 'platform', endpoint: endpointFor('platform') })
if (args['organization-id']) tenants.push({ id: args['organization-id'], endpoint: endpointFor(args['organization-id']) })
if (!args.platform && !args['organization-id']) {
  const list = await fetch(new URL('/api/auth/organization/list', baseURL), { headers })
  if (!list.ok) throw new Error(`Could not list organizations: ${list.status}`)
  const organizations = await list.json()
  if (!Array.isArray(organizations) || !organizations.length) throw new Error('The account belongs to no organizations.')
  for (const organization of organizations) {
    const context = await fetch(new URL(`/api/dashboard/context?org=${encodeURIComponent(organization.slug)}`, baseURL), { headers })
    if (!context.ok) throw new Error(`${organization.slug}: context ${context.status}`)
    const payload = await context.json()
    if (!payload.organization?.id) throw new Error(`${organization.slug}: invalid dashboard context`)
    tenants.push({ id: payload.organization.id, endpoint: endpointFor(payload.organization.id) })
  }
}
if (!tenants.length) throw new Error('No organizations are available for social-card generation.')
let generated = 0
let reused = 0
let skipped = 0
let failed = 0
for (const organization of tenants) {
  let after = null
  let waitingSince = Date.now()
  let pending = false
  try {
    do {
      const body = args['refresh-id'] ? { refresh_id: args['refresh-id'] } : { after }
      const response = await fetch(new URL(organization.endpoint, baseURL), { method: 'POST', headers, body: JSON.stringify(body) })
      if (!response.ok) throw new Error(`Regeneration returned ${response.status}: ${await response.text()}`)
      const page = await response.json()
      if (!Array.isArray(page.results) || !(page.next_cursor === null || typeof page.next_cursor === 'string')) throw new Error('Invalid regeneration response')
      if (args['refresh-id']) {
        if (page.refresh?.id !== args['refresh-id'] || !['complete', 'pending', 'failed'].includes(page.refresh.status)) throw new Error('Invalid refresh receipt')
        if (page.refresh.status === 'failed') throw new Error(page.refresh.error || 'Social-card refresh failed')
        pending = page.refresh.status === 'pending'
        if (!page.results.length && pending) {
          if (Date.now() - waitingSince > 6 * 60 * 1000) throw new Error('Social-card refresh remains pending')
          await setTimeout(2000)
        } else waitingSince = Date.now()
      }
      for (const result of page.results) {
        if (result.kind === 'generated' || result.kind === 'reused') {
          const image = await fetch(result.public_url)
          if (!image.ok) throw new Error(`${result.owner.owner_type}/${result.owner.owner_id}: PNG fetch ${image.status}`)
          const bytes = Buffer.from(await image.arrayBuffer())
          if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== 1200 || bytes.readUInt32BE(20) !== 630) throw new Error(`${result.public_url}: expected a 1200x630 PNG`)
          if (result.kind === 'generated') generated++
          else reused++
          console.log(`[local:cards] ${organization.id} ${result.owner.owner_type}/${result.owner.owner_id}: ${result.kind} ${result.public_url}`)
        } else if (result.kind === 'skipped') {
          if (result.reason === 'images_unavailable') failed++
          else skipped++
          console.warn(`[local:cards] ${organization.id} ${result.owner.owner_type}/${result.owner.owner_id}: skipped (${result.reason})`)
        } else if (result.kind === 'failed') {
          failed++
          console.error(`[local:cards] ${organization.id} ${result.owner.owner_type}/${result.owner.owner_id}: failed (${result.error})`)
        } else throw new Error('Unknown social-card outcome')
      }
      if (!args['refresh-id'] && page.next_cursor && page.next_cursor === after) throw new Error('Regeneration cursor did not advance')
      after = page.next_cursor
    } while (args['refresh-id'] ? pending : after)
  } catch (error) {
    failed++
    console.error(`[local:cards] ${organization.id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`[local:cards] ${generated} generated, ${reused} reused, ${skipped} skipped, ${failed} failed.`)
process.exitCode = failed ? 1 : 0
