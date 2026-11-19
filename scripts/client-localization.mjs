#!/usr/bin/env node
// Publishes an explicitly authored local bundle through the canonical tenant MCP.
// Client content belongs in ignored client-imports/, never in the public repository.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { normalizeTenantPageBlocks } from '../utils/tenant-page-blocks.ts'

const { values: options } = parseArgs({ options: {
  'base-url': { type: 'string' },
  'token-file': { type: 'string' },
  'client-id': { type: 'string' },
  bundle: { type: 'string' },
  auth: { type: 'boolean' },
  apply: { type: 'boolean' },
  verify: { type: 'boolean' },
} })
const base = new URL(options['base-url'] || 'https://staging.blawby.com')
if (base.protocol !== 'https:' || base.pathname !== '/') throw new Error('--base-url must be an HTTPS origin')
if (!options['token-file']) throw new Error('--token-file is required (keep it outside Git)')
const resource = new URL('/api/mcp', base).href
const json = async path => JSON.parse(await readFile(path, 'utf8'))

async function authorize() {
  const clientId = options['client-id']
  if (!clientId || new URL(clientId).protocol !== 'https:') throw new Error('--client-id must name the published HTTPS OAuth client metadata')
  const verifier = randomBytes(48).toString('base64url')
  const state = randomBytes(24).toString('base64url')
  const redirect = 'http://127.0.0.1:9471/callback'
  const url = new URL('/api/auth/oauth2/authorize', base)
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'openid tenant',
    state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', resource, prompt: 'consent',
  }).toString()
  await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const callback = new URL(req.url, redirect)
      if (callback.pathname !== '/callback' || callback.searchParams.get('state') !== state) {
        res.writeHead(400).end('Invalid OAuth callback'); return
      }
      try {
        const code = callback.searchParams.get('code')
        if (!code) throw new Error(`OAuth authorization failed: ${callback.searchParams.get('error') || 'missing code'}`)
        const response = await fetch(new URL('/api/auth/oauth2/token', base), {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code,
            redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource }),
          signal: AbortSignal.timeout(30000),
        })
        if (!response.ok) throw new Error(`OAuth token exchange returned HTTP ${response.status}`)
        const token = await response.json()
        if (!token.access_token || !Number.isFinite(token.expires_in)) throw new Error('OAuth response omitted access_token or expires_in')
        const temporaryPath = `${options['token-file']}.${randomBytes(16).toString('hex')}.tmp`
        const file = await open(temporaryPath, 'wx', 0o600)
        try {
          try {
            await file.writeFile(JSON.stringify({ origin: base.origin,
              access_token: token.access_token, expires_at: Date.now() + token.expires_in * 1000 }))
          } finally { await file.close() }
          await rename(temporaryPath, options['token-file'])
        } finally { await rm(temporaryPath, { force: true }) }
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Authorization saved locally. You can close this tab.')
        server.close(); clearTimeout(timeout); resolve()
      } catch (error) {
        res.writeHead(500).end('Authorization failed. See the local publisher output.')
        server.close(); clearTimeout(timeout); reject(error)
      }
    })
    const timeout = setTimeout(() => { server.close(); reject(new Error('Authorization timed out after 10 minutes')) }, 600000)
    server.on('error', error => { clearTimeout(timeout); reject(error) })
    server.listen(9471, '127.0.0.1', () => console.log(`Authorize the publisher in your browser:\n${url}`))
  })
  console.log('OAuth authorization saved; no content was changed.')
}

async function publish() {
  if (!options.bundle) throw new Error('--bundle is required')
  if (options.apply && options.verify) throw new Error('Choose --apply or --verify')
  const bundle = await json(options.bundle)
  if (bundle.origin !== base.origin) throw new Error('Bundle origin does not match --base-url; prepare a separate bundle for this environment')
  if (!bundle.organization_id || !bundle.locale || !Array.isArray(bundle.products) || !Array.isArray(bundle.resources) || !Array.isArray(bundle.pages)) throw new Error('Invalid localization bundle')
  for (const page of bundle.pages) page.blocks = normalizeTenantPageBlocks(page.blocks)
  const token = await json(options['token-file'])
  if (token.origin !== base.origin || !Number.isFinite(token.expires_at) || token.expires_at <= Date.now()) throw new Error('OAuth authorization is expired or belongs to another environment')
  let sequence = 0
  async function rpc(method, params) {
    const response = await fetch(resource, {
      method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}: ${(await response.text()).slice(0,600)}`)
    const body = await response.text()
    const envelope = response.headers.get('content-type')?.includes('text/event-stream')
      ? body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(item => item.id === sequence)
      : JSON.parse(body)
    if (!envelope || envelope.error || envelope.result?.isError) throw new Error(JSON.stringify(envelope?.error || envelope?.result || 'Missing MCP result'))
    return envelope.result
  }
  async function call(name, args = {}) {
    const result = await rpc('tools/call', { name, arguments: { ...args, organization_id: bundle.organization_id } })
    if (result.structuredContent) return result.structuredContent
    const content = result.content?.find(item => item.type === 'text')?.text
    if (!content) throw new Error(`${name} omitted its result`)
    return JSON.parse(content)
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'client-localization', version: '1' } })
  const catalog = await call('get_product_catalog_localization', { locale: bundle.locale })
  const expectedIds = bundle.products.map(item => item.product_id).sort()
  if (new Set(expectedIds).size !== expectedIds.length) throw new Error('Bundle contains duplicate product IDs')
  const actualIds = catalog.products.map(item => item.id).sort()
  if (!isDeepStrictEqual(actualIds, expectedIds)) throw new Error(`Catalog membership changed: bundle ${expectedIds.length}, server ${actualIds.length}. Re-export and translate before publishing.`)
  for (const product of catalog.products) {
    const intended = bundle.products.find(item => item.product_id === product.id)
    if (!isDeepStrictEqual(product.source, intended.source)) throw new Error(`English source changed for ${product.id}; retranslate before publishing`)
  }
  // Read every relevant page before any writes. Existing translations are verified,
  // never silently overwritten; edits should use the normal concurrency-aware editor.
  const pages = []
  let cursor
  do {
    const response = await call('list_site_pages', { locale: bundle.locale, limit: 100, ...(cursor ? { cursor } : {}) })
    pages.push(...response.pages)
    cursor = response.page_info.has_more ? response.page_info.next_cursor : null
  } while (cursor)
  const existingPages = new Map(pages.map(page => [page.page_id, page]))
  function comparableBlocks(blocks) {
    return normalizeTenantPageBlocks(blocks).map(({ id, ...block }) => block)
  }
  async function verifyPage(actual, intended) {
    const { page } = await call('get_site_page', { variant_id: actual.id })
    if (page.page_id !== intended.page_id || page.path !== intended.path || page.title !== intended.title) throw new Error(`Page metadata differs: ${intended.path}`)
    if (!isDeepStrictEqual(comparableBlocks(page.blocks), comparableBlocks(intended.blocks))) throw new Error(`Page content differs: ${intended.path}; edit the existing translation through the concurrency-aware page editor`)
    if (page.summary !== (intended.summary ?? null)) throw new Error(`Page summary differs: ${intended.path}`)
  }
  for (const page of bundle.pages) {
    if (existingPages.has(page.page_id)) await verifyPage(existingPages.get(page.page_id), page)
  }
  console.log(`${base.origin} · ${bundle.organization_id} · ${bundle.locale}: ${expectedIds.length} products, ${bundle.resources.length} resources, ${bundle.pages.length} pages`)
  if (!options.apply && !options.verify) { console.log('Preflight passed. No writes. Use --apply to publish this exact bundle.'); return }
  if (options.apply) {
    // Products are resources; the bundle keeps them in their own list because
    // they carry the English source it verified above, not because they are
    // written differently.
    const groups = new Map()
    for (const { source, product_id: resourceId, ...item } of bundle.products) {
      groups.set('product', [...(groups.get('product') ?? []), { ...item, resource_id: resourceId }])
    }
    for (const { resource_type: resourceType, ...item } of bundle.resources) {
      groups.set(resourceType, [...(groups.get(resourceType) ?? []), item])
    }
    for (const [resourceType, all] of groups) {
      for (let offset = 0; offset < all.length; offset += 200) {
        const items = all.slice(offset, offset + 200)
        await call('replace_resource_localizations', { resource_type: resourceType, locale: bundle.locale, items })
        console.log(`Saved ${resourceType} ${offset + 1}–${offset + items.length}`)
      }
    }
    for (const page of bundle.pages) {
      if (existingPages.has(page.page_id)) continue
      const { page: created } = await call('create_site_page', { ...page, locale: bundle.locale })
      existingPages.set(page.page_id, created)
      console.log(`Created Thai page ${page.path}`)
    }
  }
  const saved = await call('get_product_catalog_localization', { locale: bundle.locale })
  for (const intended of bundle.products) {
    const actual = saved.products.find(item => item.id === intended.product_id)?.localization
    if (!actual || !isDeepStrictEqual(actual.values, intended.values) || actual.route_path !== intended.route_path) throw new Error(`Verification failed: product ${intended.product_id}`)
  }
  for (const intended of bundle.resources) {
    const { localization } = await call('get_resource_localization', { locale: bundle.locale, resource_type: intended.resource_type, resource_id: intended.resource_id })
    if (!isDeepStrictEqual(localization.values, intended.values) || localization.route_path !== (intended.route_path ?? null)) throw new Error(`Verification failed: ${intended.resource_type} ${intended.resource_id}`)
  }
  for (const intended of bundle.pages) {
    const actual = existingPages.get(intended.page_id)
    if (!actual) throw new Error(`Verification failed: page ${intended.path}`)
    await verifyPage(actual, intended)
  }
  console.log('Canonical persistence verified. Verify the public Kikuzuki routes and footer before reporting delivery.')
}

try { await (options.auth ? authorize() : publish()) }
catch (error) { console.error(error.message); process.exitCode = 1 }
