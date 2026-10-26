#!/usr/bin/env node
import { chromium } from 'playwright'
import { spawnYarn } from './utils/spawn-yarn.mjs'

const nowIso = () => new Date().toISOString()

function env(name, opts = {}) {
  const value = process.env[name]
  if (!value || !value.trim()) {
    if (opts.optional) return ''
    throw new Error(`Missing required env var: ${name}`)
  }
  return value.trim()
}

function d1Query(sql) {
  const res = spawnYarn(['-s', 'wrangler', 'd1', 'execute', 'DB', '--remote', '--json', '--command', sql], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error(res.stderr || `d1Query exited ${res.status}`)
  return JSON.parse(res.stdout)?.[0]?.results ?? []
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''")
}

async function fetchJson(request, url, options = {}) {
  const res = await request.fetch(url, options)
  const text = await res.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  return { res, body, text }
}

async function main() {
  const baseUrl = env('CANARY_BASE_URL')
  const phone = env('CANARY_PHONE_E164')
  const expectedOrgId = env('CANARY_ORG_ID')

  const membershipCheck = d1Query(`
    SELECT u.id AS user_id, m.role AS role, m.organizationId AS organization_id
    FROM user u
    JOIN member m ON m.userId = u.id
    WHERE u.phoneNumber = '${sqlEscape(phone)}'
      AND m.organizationId = '${sqlEscape(expectedOrgId)}'
    LIMIT 1
  `)[0]

  if (!membershipCheck) {
    throw new Error(`Canary account is not scoped to the canary organization. Expected phone ${phone} to be a member of ${expectedOrgId}.`)
  }

  const before = {
    reservations: Number(d1Query(`SELECT COUNT(*) as c FROM requests WHERE kind = 'reservation' AND organization_id = '${sqlEscape(expectedOrgId)}'`)[0]?.c ?? 0),
    contacts: Number(d1Query(`SELECT COUNT(*) as c FROM requests WHERE kind = 'contact' AND organization_id = '${sqlEscape(expectedOrgId)}'`)[0]?.c ?? 0),
  }

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ baseURL: baseUrl })
  const request = context.request
  const page = await context.newPage()

  try {
    const send = await fetchJson(request, `${baseUrl}/api/auth/phone-number/send-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      data: { phoneNumber: phone },
    })
    if (send.res.status() >= 400) {
      throw new Error(`OTP send failed (${send.res.status()}): ${send.text}`)
    }

    const digits = phone.replace(/\D/g, '')
    let otp = ''
    const otpDeadline = Date.now() + 25_000
    while (Date.now() < otpDeadline) {
      const rows = d1Query(`
        SELECT value, identifier, createdAt
        FROM verification
        WHERE (identifier = '${sqlEscape(phone)}' OR replace(identifier, '+', '') = '${sqlEscape(digits)}' OR replace(identifier, ' ', '') = '${sqlEscape(phone.replace(/\s+/g, ''))}')
          AND expiresAt > unixepoch()
        ORDER BY createdAt DESC
        LIMIT 5
      `)
      const candidate = rows.find((row) => /^\d{6}(?::\d+)?$/.test(String(row.value ?? '').trim()))
      if (candidate) {
        otp = String(candidate.value).trim().split(':')[0] || ''
        break
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (!otp) {
      throw new Error('Failed to read OTP from D1 verification table for canary phone number')
    }

    const verify = await fetchJson(request, `${baseUrl}/api/auth/phone-number/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      data: { phoneNumber: phone, code: otp },
    })
    if (verify.res.status() >= 400) {
      throw new Error(`OTP verify failed (${verify.res.status()}): ${verify.text}`)
    }

    const session = await fetchJson(request, `${baseUrl}/api/auth/get-session`)
    if (session.res.status() >= 400 || !session.body?.user?.id) {
      throw new Error(`Authenticated session missing after OTP login (${session.res.status()})`)
    }

    const contextRes = await fetchJson(request, `${baseUrl}/api/dashboard/context`)
    if (contextRes.res.status() !== 200 || !contextRes.body?.organization?.id) {
      throw new Error(`Dashboard context failed (${contextRes.res.status()}): ${contextRes.text}`)
    }

    const orgId = String(contextRes.body.organization.id)
    if (orgId !== expectedOrgId) {
      throw new Error(`Canary org mismatch: expected ${expectedOrgId}, got ${orgId}`)
    }

    const dashboard = await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' })
    if (!dashboard || dashboard.status() >= 400) {
      throw new Error(`Dashboard page load failed (${dashboard?.status() ?? 'no_response'})`)
    }

    const bodyText = (await page.locator('body').innerText()).toLowerCase()
    if (!bodyText.includes('overview') && !bodyText.includes('dashboard')) {
      throw new Error('Dashboard tenant marker missing (overview/dashboard text not found)')
    }

    const after = {
      reservations: Number(d1Query(`SELECT COUNT(*) as c FROM requests WHERE kind = 'reservation' AND organization_id = '${sqlEscape(expectedOrgId)}'`)[0]?.c ?? 0),
      contacts: Number(d1Query(`SELECT COUNT(*) as c FROM requests WHERE kind = 'contact' AND organization_id = '${sqlEscape(expectedOrgId)}'`)[0]?.c ?? 0),
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
      user_id: session.body.user.id,
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
