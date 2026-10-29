import { expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { E2E_ADMIN_ID, E2E_PASSWORD, findE2eAuthFixture } from '../../../config/development-auth-fixtures'
import { seededTenant } from '../seed/manifest'
import { devLoginHeaders } from '../test-env'

// Auth requests use the platform URL explicitly supplied by their caller.
export function authRequestHeaders(baseURL: string): Record<string, string> {
  return { origin: new URL(baseURL).origin, ...devLoginHeaders() }
}

// Local E2E signs in as seeded actors; with no user named, the seeded platform
// administrator, who owns every seeded business. Deployed checks have no seed
// and sign in as the configured canary account.
function credential(userId: string | undefined) {
  if (!userId && process.env.PLAYWRIGHT_PREVIEW_URL) {
    const email = process.env.CANARY_LOGIN_EMAIL
    const password = process.env.CANARY_LOGIN_PASSWORD
    if (!email || !password) throw new Error('Deployed checks sign in with CANARY_LOGIN_EMAIL and CANARY_LOGIN_PASSWORD.')
    return { fixture: null, email, password, organizationId: process.env.CANARY_ORG_ID }
  }
  const fixture = findE2eAuthFixture(userId ?? E2E_ADMIN_ID)
  const tenant = fixture.memberships?.[0]?.tenant
  return { fixture, email: fixture.email, password: E2E_PASSWORD, organizationId: tenant ? seededTenant(tenant).organizationId : undefined }
}

export async function loginAs(request: APIRequestContext, baseURL: string, userId?: string) {
  const { fixture, email, password, organizationId } = credential(userId)
  const headers = authRequestHeaders(baseURL)
  const res = await request.post(`${baseURL}/api/auth/sign-in/email`, {
    maxRetries: 0,
    timeout: 15_000,
    headers,
    data: {
      email,
      password,
      rememberMe: false,
    },
  })
  expect(res.status(), await res.text()).toBe(200)

  if (organizationId) {
    const activeOrganization = await request.post(`${baseURL}/api/auth/organization/set-active`, {
      headers,
      data: { organizationId },
    })
    expect(activeOrganization.status(), await activeOrganization.text()).toBe(200)
  }

  const session = await request.get(`${baseURL}/api/auth/get-session`)
  expect(session.status(), await session.text()).toBe(200)
  await expect(session.json()).resolves.toMatchObject({ user: fixture ? { id: fixture.id } : { email } })
}
