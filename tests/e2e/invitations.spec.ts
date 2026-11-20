import { expect, test } from '@playwright/test'
import { E2E_PASSWORD, findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'
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
  for (const [key, specialtyRoles] of [['legal', ['attorney', 'paralegal']], ['experience', []]] as const) {
    const workspace = seededTenant(key)
    const form = await request.get('/api/dashboard/members', { params: { org: workspace.slug, view: 'invite' } })
    expect(form.status(), await form.text()).toBe(200)
    const { organization_id, roles } = await form.json() as { organization_id: string; roles: Array<{ value: string }> }
    expect(organization_id).toBe(workspace.organizationId)
    expect(roles.map(role => role.value).sort()).toEqual(['member', 'owner', 'admin', 'maintenance', ...specialtyRoles].sort())
  }
  const owner = await browser.newContext({ baseURL, viewport: { width: 360, height: 780 } })
  let invitationId: string
  try {
    await loginAs(owner.request, baseURL!)
    const team = await owner.newPage()
    await team.goto('/dashboard/' + restaurant.slug + '/team')
    await waitForNuxtHydration(team)
    await expect(team.getByRole('heading', { name: 'Members', exact: true })).toBeVisible()
    await expect(team.getByRole('heading', { name: 'Pending invitations', exact: true })).toBeVisible()
    await team.getByRole('link', { name: 'Invite a team member' }).click()
    await team.getByLabel('Email address').fill(invitee.email)
    // The role is its own step, never under the keyboard of the email field.
    await expect(team.getByRole('checkbox', { name: /^General Staff/ })).toHaveCount(0)
    await team.getByRole('button', { name: 'Next', exact: true }).click()
    // Nothing is chosen for the owner: Send waits for a role.
    await expect(team.getByRole('checkbox', { name: /^General Staff/ })).not.toBeChecked()
    await expect(team.getByRole('button', { name: 'Send invite', exact: true })).toBeDisabled()
    await expect(team.getByRole('checkbox', { name: /^Restaurant Manager/ })).toBeVisible()
    await expect(team.getByRole('checkbox', { name: /^Cleaner/ })).toHaveCount(0)
    await team.getByRole('checkbox', { name: /^Kitchen/ }).check()
    // A member can hold several roles; Better Auth stores them together.
    await team.getByRole('checkbox', { name: /^Host/ }).check()
    const table = Object.values(restaurant.products).find(product => product.kind === 'table')
    if (!table) throw new Error('No restaurant table in the fixture')
    await team.getByRole('combobox', { name: table.name, exact: true }).click()
    await team.getByRole('option', { name: 'Tasks', exact: true }).click()
    await team.getByRole('button', { name: 'Send invite', exact: true }).click()
    const pending = team.getByRole('listitem').filter({ hasText: invitee.email })
    await expect(pending).toContainText('Email: recorded locally')
    await expect(pending).toContainText('Kitchen, Host')
    const pendingActions = pending.getByRole('button', { name: `Actions for ${invitee.email}` })
    await expect(pendingActions).toBeVisible()
    const list = await request.get('/api/auth/organization/list-invitations', { params: { organizationId: restaurant.organizationId } })
    expect(list.status()).toBe(200)
    const sent = (await list.json() as Array<{ email: string; id: string; status: string; role: string }>).find(invitation => invitation.email === invitee.email)
    expect(sent).toMatchObject({ status: 'pending', role: 'kitchen,host' })
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
    expect.objectContaining({ id: restaurant.organizationId, role: 'kitchen,host' }),
  ]) })
  const catalog = await page.request.get('/api/dashboard/catalog', { params: { org: restaurant.slug, location_id: restaurant.locations.brooklyn!.id } })
  expect(catalog.status(), await catalog.text()).toBe(200)
  expect(await catalog.json()).toMatchObject({
    title: 'Menu',
    rows: [{ label: 'Brooklyn Clam Pie' }, { label: 'Burrata' }, { label: 'Garlic Knots' },
      { label: 'Margherita' }, { label: 'Pepperoni' }, { label: 'Wild Mushroom' }],
  })
  const foreignMenu = await page.request.get('/api/dashboard/catalog', {
    params: { org: restaurant.slug, location_id: Object.values(seededTenant('experience').locations)[0]!.id },
  })
  expect(foreignMenu.status()).toBe(404)
  const team = await page.request.get('/api/dashboard/members', { params: { org: restaurant.slug } })
  expect(team.status()).toBe(200)
  const teamData = await team.json() as { inviteRoles: unknown[]; invitations: unknown[]; members: Array<{ canRemove: boolean; roleChoices: unknown[] }> }
  expect(teamData.inviteRoles).toEqual([])
  expect(teamData.invitations).toEqual([])
  expect(teamData.members.length).toBeGreaterThan(0)
  expect(teamData.members.every(member => !member.canRemove && !member.roleChoices.length)).toBe(true)
  const ownInviteForm = await page.request.get('/api/dashboard/members', { params: { org: restaurant.slug, view: 'invite' } })
  expect(ownInviteForm.status(), await ownInviteForm.text()).toBe(403)
  for (const key of ['legal', 'experience'] as const) {
    const foreignInviteForm = await page.request.get('/api/dashboard/members', { params: { org: seededTenant(key).slug, view: 'invite' } })
    expect(foreignInviteForm.status(), await foreignInviteForm.text()).toBe(404)
  }
  const reopened = await page.request.get('/api/auth/organization/get-invitation', { params: { id: invitationId } })
  expect(reopened.status()).toBe(400)
  await expect(reopened.json()).resolves.toMatchObject({ message: 'Invitation not found!' })
})
