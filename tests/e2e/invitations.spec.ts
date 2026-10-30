import { execFileSync } from 'node:child_process'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { waitForNuxtHydration } from './helpers'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { seededTenant } from './seed/manifest'
import { testBaseUrl } from './test-env'
import { findE2eAuthFixture } from '../../config/development-auth-fixtures'

// Someone invited by email answers on the invitation page by signing in with a
// code sent to the invited address: no other sign-in is offered first, and the
// page offers Apple and Google as extra logins only once they have joined.

const writableEnvironment = ['localhost', '127.0.0.1'].includes(new URL(testBaseUrl()).hostname)
test.skip(!writableEnvironment, 'Invitations write only local disposable data')

/** The owner of a seeded business invites a fresh address and gets the invitation id back. */
async function invite(request: APIRequestContext, baseURL: string, email: string) {
  await loginAs(request, baseURL)
  const restaurant = seededTenant('restaurant')
  const response = await request.post(`${baseURL}/api/auth/organization/invite-member`, {
    headers: authRequestHeaders(baseURL), data: { organizationId: restaurant.organizationId, email, role: 'member' },
  })
  expect(response.status(), await response.text()).toBe(200)
  return { invitationId: (await response.json() as { id: string }).id, restaurant }
}

/** The code Better Auth stored for this sign-in, read from the local Worker's D1 as the email would carry it. */
function storedSignInCode(email: string): string {
  const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
  const output = execFileSync('node_modules/.bin/wrangler', [
    'd1', 'execute', 'DB', '--local', '--env', 'e2e', '--persist-to', `.wrangler/e2e-state-${port}`, '--json',
    '--command', `SELECT value FROM verification WHERE identifier = 'sign-in-otp-${email}'`,
  ], { encoding: 'utf8' })
  const [{ results }] = JSON.parse(output) as Array<{ results: Array<{ value: string }> }>
  expect(results).toHaveLength(1)
  return results[0]!.value.split(':')[0]!
}

test('an invitee signs in with an emailed code, accepts, and is offered Apple and Google afterwards', async ({ browser, request, baseURL }) => {
  const email = `invitee-${Date.now()}@example.test`
  const { invitationId, restaurant } = await invite(request, baseURL!, email)

  // A browser that already answered the notification prompt, so joining ends on the account offers.
  const context = await browser.newContext({ baseURL, permissions: ['notifications'] })
  const page = await context.newPage()
  await page.goto(`/accept-invitation/${invitationId}`)
  await waitForNuxtHydration(page)
  await expect(page.getByRole('heading', { name: `Join ${restaurant.name}`, exact: true })).toBeVisible()
  await expect(page.getByText(`The invitation is for ${email}`)).toBeVisible()
  // The invited address is the only way in; nothing offers another account or a business of one's own.
  await expect(page.getByRole('button', { name: /Google|Apple/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Create|Sign up/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Email me a code', exact: true }).click()
  await page.getByLabel('Code').fill(storedSignInCode(email))
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Decline', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Accept invitation', exact: true }).click()

  await expect(page.getByRole('heading', { name: `You've joined ${restaurant.name}`, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Also sign in with Apple', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Also sign in with Google', exact: true })).toBeVisible()

  // The membership is read back through the invitee's own organization list, not the page that wrote it.
  const organizations = await page.request.get('/api/auth/organization/list')
  expect(organizations.status()).toBe(200)
  expect((await organizations.json() as Array<{ id: string }>).map(organization => organization.id)).toContain(restaurant.organizationId)
  const reopened = await page.request.get(`/api/invitations/${invitationId}`)
  expect(reopened.status()).toBe(410)
  expect((await reopened.json() as { data: { code: string } }).data.code).toBe('INVITATION_ACCEPTED')
  await context.close()
})

test('someone signed in as another address signs out in place and continues with the invited one', async ({ page, request, baseURL }) => {
  const email = `invitee-switch-${Date.now()}@example.test`
  const { invitationId } = await invite(request, baseURL!, email)
  const other = findE2eAuthFixture('user-e2e-oauth-private-cimd')
  await loginAs(page.request, baseURL!, other.id)

  await page.goto(`/accept-invitation/${invitationId}`)
  await waitForNuxtHydration(page)
  await expect(page.getByText(`You're signed in as ${other.email}, but this invitation is for ${email}.`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: `Sign out and continue as ${email}`, exact: true }).click()
  // The reactive session updates without a reload: the same page now offers the code.
  await expect(page.getByRole('button', { name: 'Email me a code', exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/accept-invitation/${invitationId}$`))
  expect((await page.request.get('/api/auth/get-session')).status()).toBe(200)
  expect(await (await page.request.get('/api/auth/get-session')).json()).toBeNull()
})
