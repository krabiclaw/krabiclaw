#!/usr/bin/env node
import { chromium } from 'playwright'
import { credentialSession } from './utils/e2e-auth.mjs'
import { spawnYarn } from './utils/spawn-yarn.mjs'

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

function conversationCounts(organizationId) {
  const [counts] = d1Query(`
    SELECT COUNT(CASE WHEN kind = 'booking' THEN 1 END) AS bookings,
      COUNT(CASE WHEN kind = 'contact' THEN 1 END) AS contacts
    FROM conversations WHERE organization_id = '${sqlEscape(organizationId)}'
      AND kind IN ('booking', 'contact')
  `)
  if (!Number.isSafeInteger(counts?.bookings) || !Number.isSafeInteger(counts?.contacts)) {
    throw new Error('Production auth canary did not receive both conversation counts')
  }
  return counts
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

  if (!membershipCheck?.user_id || !membershipCheck.organization_slug) {
    throw new Error('Canary account is not a member of the configured canary organization')
  }

  const before = conversationCounts(expectedOrgId)

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

    if (dashboardContext.organization?.id !== expectedOrgId) {
      throw new Error('The dashboard context does not match the configured canary organization')
    }

    const page = await context.newPage()
    const dashboardPath = `/dashboard/${organizationSlug}`
    const dashboard = await page.goto(dashboardPath, { waitUntil: 'domcontentloaded' })
    const loadedPath = new URL(page.url()).pathname
    if (!dashboard?.ok() || (loadedPath !== dashboardPath && !loadedPath.startsWith(`${dashboardPath}/`))) {
      throw new Error(`Dashboard page load failed (${dashboard?.status() ?? 'no_response'})`)
    }

    await page.getByRole('navigation', { name: 'Dashboard', exact: true })
      .getByRole('link', { name: 'Today', exact: true })
      .waitFor({ state: 'visible', timeout: 20_000 })

    const after = conversationCounts(expectedOrgId)

    if (before.bookings !== after.bookings || before.contacts !== after.contacts) {
      throw new Error('The canary organization’s booking or contact count changed')
    }

    const summary = {
      status: 'pass',
      checked_at: new Date().toISOString(),
      base_url: baseUrl,
      account_verified: true,
      organization_verified: true,
      dashboard_verified: true,
      conversation_counts_unchanged: true,
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
