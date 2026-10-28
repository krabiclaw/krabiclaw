#!/usr/bin/env node
/**
 * Interactive onboarding wrapper — runs the full approved flow with human review gates.
 *
 * Usage:
 *   yarn client:onboard \
 *     --slug pottery-house-krabi \
 *     --organization-id <existing-better-auth-organization-id> \
 *     --vertical experience \
 *     --maps-url "https://maps.google.com/..." \
 *     --images ./photos
 *
 * Flow:
 *   1. dry-run  → fetch Places data, scan images, write manifests
 *   2. GATE     → print manifest paths, wait for "yes" before proceeding
 *   3. approve  → hash and sign the manifests
 *   4. apply    → client:import --apply: seed D1, generate social cards, run client:verify
 *
 * Remote targets need --remote and --base-url <platform origin>.
 */

import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// ── Minimal YAML parser for intake files ──────────────────────────────────────
// Handles the specific subset intake files use: flat key:value,
// list items (  - item), and literal block scalars (key: |).

function parseIntakeYaml(content) {
  const result = {}
  const lines = content.split('\n')
  let currentKey   = null
  let currentList  = null
  let inMultiline  = false
  let multilineLines = []

  const flush = () => {
    if (inMultiline && currentKey) {
      result[currentKey] = multilineLines.join('\n').trim()
      inMultiline  = false
      multilineLines = []
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')

    // Blank or comment — collect in multiline, skip otherwise
    if (line.trim() === '' || line.trim().startsWith('#')) {
      if (inMultiline) multilineLines.push('')
      continue
    }

    // List item
    const listMatch = line.match(/^(\s*)-\s+(.+)$/)
    if (listMatch && currentList) {
      flush()
      result[currentList].push(listMatch[2].trim())
      continue
    }

    // Key: value pair — must start at column 0
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (kvMatch) {
      flush()
      currentKey  = kvMatch[1]
      const value = kvMatch[2].trim()

      if (value === '|') {
        inMultiline    = true
        multilineLines = []
        currentList    = null
      } else if (value === '') {
        currentList      = currentKey
        result[currentKey] = []
      } else {
        result[currentKey] = value
        currentList = null
      }
      continue
    }

    // Multiline continuation line
    if (inMultiline) {
      multilineLines.push(line.replace(/^ {2}/, ''))
    }
  }

  flush()
  return result
}

// ── Parse args ────────────────────────────────────────────────────────────────

const { values: rawArgs } = parseArgs({
  options: {
    slug:              { type: 'string' },
    'brand-name':      { type: 'string' },
    'organization-id': { type: 'string' },
    vertical:          { type: 'string' },
    'maps-url':        { type: 'string', multiple: true, default: [] },
    images:            { type: 'string' },
    'images-place-id': { type: 'string' },
    'base-url':        { type: 'string' },  // platform origin; required with --remote
    remote:            { type: 'boolean', default: false },
    from:              { type: 'string' },  // path to intake YAML
  },
  allowPositionals: false,
})

// Merge intake YAML (--from) under explicit args
const args = { ...rawArgs }
if (args.from) {
  if (!existsSync(args.from)) {
    console.error(`Error: intake file not found: ${args.from}`)
    process.exit(1)
  }
  const intake = parseIntakeYaml(readFileSync(args.from, 'utf8'))
  if (!args['brand-name'] && intake.brand_name) args['brand-name'] = intake.brand_name
  if (!args.slug     && intake.slug)       args.slug = intake.slug
  if (!args.vertical && intake.vertical)   args.vertical = intake.vertical
  if (!args['organization-id'] && intake.organization_id) args['organization-id'] = intake.organization_id
  if (!args.images      && intake.images_dir) args.images = intake.images_dir
  if (!args['images-place-id'] && intake.images_place_id) args['images-place-id'] = intake.images_place_id
  if (!args['maps-url']?.length && intake.maps_urls?.length) {
    args['maps-url'] = intake.maps_urls
  }
}

// Defaults
if (!args.vertical) args.vertical = 'restaurant'

if (!args.slug) {
  console.error('Error: --slug is required (or provide --from <intake.yml>)')
  console.error('Usage: yarn client:onboard --slug <slug> --organization-id <id> --vertical <vertical> [--maps-url <url>] [--images <dir>]')
  console.error('       yarn client:onboard --from client-intake/<slug>.yml   (client-intake/ is gitignored)')
  process.exit(1)
}
if (!args['organization-id']) {
  console.error('Error: --organization-id is required (or provide organization_id in the intake file). Create the organization through Better Auth first.')
  process.exit(1)
}

const SLUG            = args.slug
const VERTICAL        = args.vertical
const REMOTE          = args.remote
const OUT_DIR         = join(process.cwd(), 'client-imports', SLUG)

// ── Helpers ───────────────────────────────────────────────────────────────────

function hr(char = '─', width = 64) { return char.repeat(width) }

function step(n, label) {
  console.log(`\n${hr('═')}`)
  console.log(`  Step ${n}: ${label}`)
  console.log(hr('═'))
}

function run(label, args) {
  const cmdStr = `node ${args.join(' ')}`
  console.log(`\n  $ ${cmdStr}`)
  const result = spawnSync('node', args, { stdio: 'inherit', cwd: process.cwd() })
  if (result.status !== 0) {
    console.error(`\n  ✗ ${label} failed (exit ${result.status ?? 1}) — aborting.`)
    process.exit(result.status ?? 1)
  }
}

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(`\n  ${question} `, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  })
}

async function gate(message) {
  console.log(`\n  ┌─ REVIEW REQUIRED ${'─'.repeat(46)}`)
  console.log(`  │  ${message}`)
  console.log(`  └${'─'.repeat(63)}`)
  const answer = await prompt('Type "yes" to continue, anything else to abort:')
  if (answer !== 'yes') {
    console.log('\n  Aborted by operator.')
    process.exit(0)
  }
}


if (!args['brand-name']?.trim()) throw new Error('--brand-name or intake brand_name is required')
const importArgs = ['scripts/client-import.mjs', '--slug', SLUG, '--vertical', VERTICAL, '--brand-name', args['brand-name']]
importArgs.push('--organization-id', args['organization-id'])
for (const url of (args['maps-url'] ?? [])) importArgs.push('--maps-url', url)
if (args.images) importArgs.push('--images', args.images)
if (args['images-place-id']) importArgs.push('--images-place-id', args['images-place-id'])
if (REMOTE) importArgs.push('--remote')

if (args['base-url']) importArgs.push('--base-url', args['base-url'])

// ── Step 1: Dry run ───────────────────────────────────────────────────────────

step(1, 'Dry run — fetch Google Places data, scan images, generate manifests')
run('dry-run', [...importArgs, '--dry-run'])

// Print manifest paths for review
const reviewFiles = [
  'client-manifest.json',
  'seed-preview.sql',
  'route-manifest.json',
  'media-manifest.json',
  'missing-fields.json',
  'copy-scan.txt',
]
console.log(`\n  Review these files before continuing:\n`)
for (const f of reviewFiles) {
  const p = join(OUT_DIR, f)
  if (existsSync(p)) console.log(`    ${relative(process.cwd(), p)}`)
}

await gate('Review the manifests above. Check locations, seed SQL, copy scan, and images.')

// ── Step 2: Approve ───────────────────────────────────────────────────────────

step(2, 'Approve — sign manifest hash to gate the apply step')
run('approve', [...importArgs, '--approve'])

// ── Step 3: Apply ─────────────────────────────────────────────────────────────

step(3, `Apply — seed ${REMOTE ? 'remote' : 'local'} D1, generate social cards, verify`)
run('apply', [...importArgs, '--apply'])

// ── Done ──────────────────────────────────────────────────────────────────────

const reportPath = join(OUT_DIR, 'verify-report.txt')
console.log(`\n${hr('═')}`)
console.log(`  Onboarding complete: ${SLUG}`)
if (existsSync(reportPath)) {
  console.log(`  Verify report: ${relative(process.cwd(), reportPath)}`)
}
if (!REMOTE) {
  console.log(`\n  To apply this approved import to a remote environment:`)
  console.log(`    node ${importArgs.join(' ')} --apply --remote --base-url <platform origin>`)
}
console.log(hr('═'))
