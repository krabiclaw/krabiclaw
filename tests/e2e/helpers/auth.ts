import { expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { findE2eAuthFixture } from '../../../config/development-auth-fixtures'
import { devLoginHeaders } from '../test-env'

// Auth requests use the platform URL explicitly supplied by their caller.
export function authRequestHeaders(baseURL: string): Record<string, string> {
  return { origin: new URL(baseURL).origin, ...devLoginHeaders() }
}

export async function loginAs(request: APIRequestContext, baseURL: string, userId?: string) {
  const fixture = userId ? findE2eAuthFixture(userId) : null
  const email = fixture?.email ?? process.env.CANARY_LOGIN_EMAIL
  const password = process.env.CANARY_LOGIN_PASSWORD
  if (!email || !password) throw new Error('The requested sign-in credential is not configured.')
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

  const organizationId = fixture ? fixture.memberships?.[0]?.organizationId : process.env.CANARY_ORG_ID
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
