import { expect, test } from '@playwright/test'
import { E2E_PASSWORD, findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { waitForNuxtHydration } from './helpers'
import { authRequestHeaders, loginAs, sendOrganizationInvitation } from './helpers/auth'
import { seededTenant } from './seed/manifest'
import { testBaseUrl } from './test-env'

const writableEnvironment = ['localhost', '127.0.0.1'].includes(new URL(testBaseUrl()).hostname)
test.skip(!writableEnvironment, 'Invitations write only local disposable data')

test('the email link returns through normal sign-in and only the invited account can join', async ({ page, request, baseURL, browser }) => {
  test.setTimeout(60_000)
  const restaurant = seededTenant('restaurant')
  const invitee = findE2eAuthFixture('user-e2e-lodging-invitee')
  const other = findE2eAuthFixture('user-e2e-oauth-private-cimd')
  await loginAs(request, baseURL!)
  const owner = await browser.newContext({ baseURL, viewport: { width: 360, height: 780 } })
  let invitationId: string
  try {
    await loginAs(owner.request, baseURL!)
    const team = await owner.newPage()
    await team.goto('/dashboard/' + restaurant.slug + '/team')
    await waitForNuxtHydration(team)
    await expect(team.getByRole('heading', { name: 'Members', exact: true })).toBeVisible()
    await expect(team.getByRole('heading', { name: 'Pending invitations', exact: true })).toBeVisible()
    await expect(team.getByText('No pending invitations.', { exact: true })).toBeVisible()
    await team.getByRole('link', { name: 'Invite a team member' }).click()
    await team.getByLabel('Email address').fill(invitee.email)
    await team.getByRole('combobox', { name: 'Role', exact: true }).click()
    await expect(team.getByRole('option')).toHaveText(['Member', 'Admin', 'Owner'])
    await team.getByRole('option', { name: 'Member', exact: true }).click()
    await team.getByRole('button', { name: 'Send invite', exact: true }).click()
    const pending = team.getByRole('listitem').filter({ hasText: invitee.email })
    await expect(pending).toContainText('Email: recorded locally')
    const pendingActions = pending.getByRole('button', { name: `Actions for ${invitee.email}` })
    await expect(pendingActions).toBeVisible()
    const list = await request.get('/api/auth/organization/list-invitations', { params: { organizationId: restaurant.organizationId } })
    expect(list.status()).toBe(200)
    const sent = (await list.json() as Array<{ email: string; id: string; status: string; role: string }>).find(invitation => invitation.email === invitee.email)
    expect(sent).toMatchObject({ status: 'pending', role: 'member' })
    if (!sent) throw new Error('Better Auth did not return the invitation sent by Team')
    invitationId = sent.id
    const teamRefresh = team.waitForResponse(response => new URL(response.url()).pathname === '/api/dashboard/members')
    await pendingActions.click()
    await team.getByRole('menuitem', { name: 'Resend invitation' }).click()
    const refreshed = await teamRefresh
    expect(refreshed.status()).toBe(200)
    const roster = await refreshed.json() as { invitations: unknown[] }
    expect(roster.invitations).toContainEqual(expect.objectContaining({
      id: invitationId, email: invitee.email, delivery: { sent: true, failed: false, message: 'Email: recorded locally' },
    }))
    await expect(pending).toContainText('Email: recorded locally')
  } finally {
    await owner.close()
  }
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
  const team = await page.request.get('/api/dashboard/members', { params: { org: restaurant.slug } })
  expect(team.status()).toBe(200)
  const teamData = await team.json() as { inviteRoles: unknown[]; invitations: unknown[]; members: Array<{ canRemove: boolean; roleChoices: unknown[] }> }
  expect(teamData.inviteRoles).toEqual([])
  expect(teamData.invitations).toEqual([])
  expect(teamData.members.length).toBeGreaterThan(0)
  expect(teamData.members.every(member => !member.canRemove && !member.roleChoices.length)).toBe(true)
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
