import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)

function argValue(flag: string) {
  const index = args.indexOf(flag)
  if (index === -1) return null
  return args[index + 1] ?? null
}

const organization = argValue('--organization')
if (args.includes('--organization') && (!organization || !/^\S+$/.test(organization) || organization.startsWith('--'))) {
  throw new Error('--organization requires an organization ID')
}
const platformOnly = args.includes('--platform-only')
if (platformOnly && organization) throw new Error('--platform-only and --organization cannot be combined')

// Stored content edits already trigger indexing through the application. A code
// deployment only needs a rebuild when it changes the indexed corpus or renderer.
const changedSince = argValue('--changed-since')
if (args.includes('--changed-since') && !changedSince) throw new Error('--changed-since requires a commit')
if (organization && changedSince) throw new Error('--organization and --changed-since cannot be combined')
if (platformOnly && changedSince) throw new Error('--platform-only and --changed-since cannot be combined')
if (changedSince) {
  const head = argValue('--changed-until') ?? 'HEAD'
  const changedFiles = execFileSync('git', /^0+$/.test(changedSince)
    ? ['ls-tree', '-r', '--name-only', head]
    : ['diff', '--name-only', changedSince, head], { encoding: 'utf8' }).trim().split('\n')
  const indexInputs = new Set([
    'config/platform-knowledge.ts',
    'server/utils/public-search.ts',
    'server/utils/platform-llm.ts',
    'server/utils/content/documents.ts',
    'server/utils/content/publishing.ts',
    'server/utils/platform-organization.ts',
    'server/utils/mcp-documentation.ts',
    'server/utils/mcp-catalog.ts',
    'server/utils/mcp-catalog-snapshots/tenant.json',
  ])
  // Published MCP reference text is projected from the deployed registry. The
  // catalog snapshot also catches schema fragments imported from other modules.
  const changedInputs = changedFiles.filter(file => indexInputs.has(file) || file.startsWith('server/utils/mcp-tools/'))
  if (changedInputs.length === 0) {
    console.log('AI Search refresh skipped: indexed content definitions and rendering are unchanged.')
    process.exit(0)
  }
  console.log(`AI Search refresh required by: ${changedInputs.join(', ')}`)
}
if (args.includes('--dry-run')) {
  console.log('AI Search refresh planned; dry run made no remote requests.')
  process.exit(0)
}

const baseUrl = (argValue('--base-url') ?? process.env.KRABICLAW_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const secret = argValue('--secret') ?? process.env.PLATFORM_SEARCH_REINDEX_SECRET ?? ''

if (!secret) {
  console.error('Missing PLATFORM_SEARCH_REINDEX_SECRET or --secret')
  process.exit(1)
}

// Each pass is its own request so none meets the Workers request ceiling: the
// platform's corpus first, then every live business's slice, one at a time.
async function reindex(organization?: string) {
  const url = new URL('/api/internal/search/reindex', baseUrl)
  if (organization) url.searchParams.set('organization', organization)
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-krabiclaw-search-secret': secret,
    },
    signal: AbortSignal.timeout(11 * 60 * 1000),
  })
  const body = await response.text()
  const target = organization ? `site ${organization}` : 'platform'
  if (response.status !== 200) throw new Error(`${target} returned HTTP ${response.status}: ${body}`)
  let payload: unknown
  try { payload = JSON.parse(body) } catch { throw new Error(`${target} returned invalid JSON`) }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !('ok' in payload) || payload.ok !== true
    || !('pending' in payload) || typeof payload.pending !== 'number' || !Number.isSafeInteger(payload.pending) || payload.pending < 0
    || (!organization && (!('organizations' in payload) || !Array.isArray(payload.organizations)
      || !payload.organizations.every(value => typeof value === 'string' && value.length > 0)))) {
    throw new Error(`${target} returned an invalid AI Search sync result: ${body}`)
  }
  console.log(JSON.stringify({ organization: organization ?? 'platform', ...payload }, null, 2))
  return payload as { pending: number; organizations?: string[] }
}

// A pass sends a bounded batch of uploads per request and says what is left;
// it is repeated until nothing is.
async function reindexUntilDone(organization?: string) {
  let payload = await reindex(organization)
  while (payload.pending > 0) payload = await reindex(organization)
  return payload
}

try {
  if (organization) {
    await reindexUntilDone(organization)
  } else {
    const platform = await reindexUntilDone()
    if (!platformOnly) {
      for (const organizationId of platform.organizations!) await reindexUntilDone(organizationId)
    }
  }
} catch (error) {
  const message = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    ? 'Request timed out'
    : error instanceof Error
      ? error.message
      : 'Unknown request error'
  console.error('AI Search sync failed', { error: message })
  process.exit(1)
}
