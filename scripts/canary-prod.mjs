#!/usr/bin/env node
import { chromium } from 'playwright'
import { credentialSession } from './utils/e2e-auth.mjs'
import { spawnYarn } from './utils/spawn-yarn.mjs'

const nowIso = () => new Date().toISOString()

function env(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function d1Query(sql) {
  const res = spawnYarn(['wrangler', 'd1', 'execute', 'DB', '--remote', '--json', '--command', sql], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error('Production auth canary database read failed', { cause: res.stderr || res.stdout })
  const [response] = JSON.parse(res.stdout)
  if (!response?.success || !Array.isArray(response.results)) throw new Error('Unexpected production auth canary database response')
  return response.results
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''")
}

async function main() {
  const baseUrl = env('CANARY_BASE_URL')
  const email = env('CANARY_LOGIN_EMAIL')
  const expectedOrgId = env('CANARY_ORG_ID')

  const membershipCheck = d1Query(`
    SELECT u.id AS user_id, o.slug AS organization_slug
    FROM user u
    JOIN member m ON m.userId = u.id
    JOIN organization o ON o.id = m.organizationId
    WHERE u.email = '${sqlEscape(email)}'
      AND m.organizationId = '${sqlEscape(expectedOrgId)}'
    LIMIT 1
  `)[0]

  if (!membershipCheck) {
    throw new Error('Canary account is not a member of the configured canary organization')
  }

  const before = {
    bookings: Number(d1Query(`SELECT COUNT(*) as c FROM conversations WHERE kind = 'booking' AND organization_id = '${sqlEscape(expectedOrgId)}'`)[0]?.c ?? 0),
    contacts: Number(d1Query(`SELECT COUNT(*) as c FROM conversations WHERE kind = 'contact' AND organization_id = '${sqlEscape(expectedOrgId)}'`)[0]?.c ?? 0),
  }

  const { cookie } = await credentialSession(baseUrl, { email, organizationId: expectedOrgId })
  const browser = await chromium.launch({ headless: true })

  try {
    const context = await browser.newContext({ baseURL: baseUrl })
    await context.addCookies(cookie.split('; ').map((entry) => {
      const separator = entry.indexOf('=')
      return { name: entry.slice(0, separator), value: entry.slice(separator + 1), url: baseUrl }
    }))
    const session = await context.request.get('/api/auth/get-session')
    if (!session.ok() || (await session.json())?.user?.id !== membershipCheck.user_id) {
      throw new Error(`Session does not match the configured canary account (${session.status()})`)
    }

    const organizationSlug = encodeURIComponent(membershipCheck.organization_slug)
    const contextRes = await context.request.get(`/api/dashboard/context?org=${organizationSlug}`)
    if (contextRes.status() !== 200) throw new Error(`Dashboard context failed (${contextRes.status()})`)
    const dashboardContext = await contextRes.json()

    const orgId = dashboardContext.organization?.id
    if (orgId !== expectedOrgId) {
      throw new Error(`Canary org mismatch: expected ${expectedOrgId}, got ${orgId}`)
    }

    const page = await context.newPage()
    const dashboardPath = `/dashboard/${organizationSlug}`
    const dashboard = await page.goto(dashboardPath, { waitUntil: 'networkidle' })
    const loadedPath = new URL(page.url()).pathname
    if (!dashboard?.ok() || (loadedPath !== dashboardPath && !loadedPath.startsWith(`${dashboardPath}/`))) {
      throw new Error(`Dashboard page load failed (${dashboard?.status() ?? 'no_response'})`)
    }

    const bodyText = (await page.locator('body').innerText()).toLowerCase()
    if (!bodyText.includes('overview') && !bodyText.includes('dashboard')) {
      throw new Error('Dashboard tenant marker missing (overview/dashboard text not found)')
    }

    const after = {
      bookings: Number(d1Query(`SELECT COUNT(*) as c FROM conversations WHERE kind = 'booking' AND organization_id = '${sqlEscape(expectedOrgId)}'`)[0]?.c ?? 0),
      contacts: Number(d1Query(`SELECT COUNT(*) as c FROM conversations WHERE kind = 'contact' AND organization_id = '${sqlEscape(expectedOrgId)}'`)[0]?.c ?? 0),
    }

    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`Read-only canary check failed: domain table counts changed. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
    }

    const summary = {
      status: 'pass',
      checked_at: nowIso(),
      base_url: baseUrl,
      organization_id: orgId,
      read_only_counts: before,
      user_id: membershipCheck.user_id,
    }

    console.log(JSON.stringify(summary, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error('canary:prod failed')
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
