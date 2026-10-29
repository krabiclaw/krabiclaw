import { E2E_PASSWORD, findE2eAuthFixture } from '../../config/development-auth-fixtures.ts'
import { seededTenant } from '../../tests/e2e/seed/manifest.ts'

function responseCookies(response) {
  return response.headers.getSetCookie()
    .map(value => value.split(';')[0])
    .filter(Boolean)
}

function mergeCookieHeader(current, response) {
  const cookies = new Map()
  for (const value of String(current || '').split(';')) {
    const entry = value.trim()
    if (!entry) continue
    const separator = entry.indexOf('=')
    if (separator > 0) cookies.set(entry.slice(0, separator), entry)
  }
  for (const entry of responseCookies(response)) {
    const separator = entry.indexOf('=')
    if (separator > 0) cookies.set(entry.slice(0, separator), entry)
  }
  return [...cookies.values()].join('; ')
}

async function expectOk(response, label) {
  if (response.ok) return response
  throw new Error(`${label} failed with ${response.status}: ${await response.text()}`)
}

export async function credentialSession(baseURL, options = {}) {
  const fixture = options.userId ? findE2eAuthFixture(options.userId) : null
  const email = options.email || fixture?.email || process.env.CANARY_LOGIN_EMAIL
  const password = options.password || (fixture ? E2E_PASSWORD : process.env.CANARY_LOGIN_PASSWORD)
  if (!email || !password) throw new Error('Configure CANARY_LOGIN_EMAIL and CANARY_LOGIN_PASSWORD, or supply the requested explicit credential.')

  const origin = new URL(baseURL).origin
  const signIn = await expectOk(await fetch(new URL('/api/auth/sign-in/email', baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, password, rememberMe: false }),
  }), 'Better Auth credential sign-in')
  let cookie = mergeCookieHeader('', signIn)
  if (!cookie) throw new Error('Better Auth credential sign-in did not return a session cookie.')

  const organizationId = options.organizationId || (fixture?.memberships?.[0] ? seededTenant(fixture.memberships[0].tenant).organizationId : fixture ? undefined : process.env.CANARY_ORG_ID)
  if (organizationId) {
    const activeOrganization = await expectOk(await fetch(new URL('/api/auth/organization/set-active', baseURL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ organizationId }),
    }), 'Better Auth active-organization selection')
    cookie = mergeCookieHeader(cookie, activeOrganization)
  }

  return { cookie }
}

export async function credentialCookie(baseURL, options = {}) {
  return (await credentialSession(baseURL, options)).cookie
}
