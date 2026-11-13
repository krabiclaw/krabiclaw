import { expect, test } from '@playwright/test'
import { E2E_PASSWORD, findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { waitForNuxtHydration } from './helpers'
import { authRequestHeaders, loginAs, sendOrganizationInvitation } from './helpers/auth'
import { seededTenant } from './seed/manifest'
import { testBaseUrl } from './test-env'

const writableEnvironment = ['localhost', '127.0.0.1'].includes(new URL(testBaseUrl()).hostname)
test.skip(!writableEnvironment, 'Invitations write only local disposable data')

test('the email link returns through normal sign-in and only the invited account can join', async ({ page, request, baseURL }) => {
  const restaurant = seededTenant('restaurant')
  const invitee = findE2eAuthFixture('user-e2e-lodging-invitee')
  const other = findE2eAuthFixture('user-e2e-oauth-private-cimd')
  await loginAs(request, baseURL!)
  const invitationId = await sendOrganizationInvitation(request, baseURL!, restaurant.organizationId, invitee.email, 'member')
  const path = '/accept-invitation/' + invitationId

  const unsigned = await page.goto(path)
  expect(unsigned?.status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Join a workspace' })).toBeVisible()
  await expect(page.getByText(invitee.email)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0)
  const signup = new URL(await page.getByRole('link', { name: 'Create an account' }).getAttribute('href') ?? '', baseURL)
  expect(signup.pathname).toBe('/signup')
  expect(signup.searchParams.get('redirect')).toBe(path)

  await loginAs(page.request, baseURL!, other.id)
  await page.goto(path)
  await waitForNuxtHydration(page)
  await expect(page.getByText('Use the account that received the invitation.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Use a different account' }).click()
  await expect(page).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('redirect') === path)
  await waitForNuxtHydration(page)
  await page.getByLabel('Email', { exact: true }).fill(invitee.email)
  await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD)
  await page.getByRole('button', { name: /^Sign in with email/ }).click()
  await expect(page).toHaveURL(path)
  await expect(page.getByRole('heading', { name: 'Join ' + restaurant.name })).toBeVisible()

  await page.context().grantPermissions(['notifications'])
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(page.getByRole('heading', { name: "You've joined " + restaurant.name })).toBeVisible()
  const organizations = await page.request.get('/api/account/organizations')
  expect(organizations.status()).toBe(200)
  expect(await organizations.json()).toMatchObject({ organizations: expect.arrayContaining([
    expect.objectContaining({ id: restaurant.organizationId, role: 'member' }),
  ]) })
  const reopened = await page.request.get('/api/auth/organization/get-invitation', { params: { id: invitationId } })
  expect(reopened.status()).toBe(400)
  await expect(reopened.json()).resolves.toMatchObject({ message: 'Invitation not found!' })
})

test('an invitee can decline a pending email invitation without joining the workspace', async ({ page, request, baseURL }) => {
  const legal = seededTenant('legal')
  const invitee = findE2eAuthFixture('user-e2e-lodging-invitee')
  await loginAs(request, baseURL!)
  const invitationId = await sendOrganizationInvitation(request, baseURL!, legal.organizationId, invitee.email, 'member')
  await loginAs(page.request, baseURL!, invitee.id)
  await page.goto('/accept-invitation/' + invitationId)
  await waitForNuxtHydration(page)
  await page.getByRole('button', { name: 'Decline', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Invitation declined' })).toBeVisible()

  const list = await request.get('/api/auth/organization/list-invitations', { params: { organizationId: legal.organizationId } })
  expect(list.status()).toBe(200)
  expect(await list.json()).toContainEqual(expect.objectContaining({ id: invitationId, status: 'rejected' }))
  const accept = await page.request.post('/api/auth/organization/accept-invitation', { headers: authRequestHeaders(baseURL!), data: { invitationId } })
  expect(accept.status()).toBe(400)
  await expect(accept.json()).resolves.toMatchObject({ code: 'INVITATION_NOT_FOUND' })
})
