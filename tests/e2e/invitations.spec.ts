import { expect, test } from '@playwright/test'
import { E2E_PASSWORD, findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { waitForNuxtHydration } from './helpers'
import { acceptOrganizationInvitation, authRequestHeaders, loginAs, sendOrganizationInvitation } from './helpers/auth'
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
    await team.getByRole('link', { name: 'Invite a team member' }).click()
    await team.getByLabel('Email address').fill(invitee.email)
    await expect(team.getByRole('radio', { name: /^General Staff/ })).toBeChecked()
    await expect(team.getByRole('radio', { name: /^Restaurant Manager/ })).toBeVisible()
    await expect(team.getByRole('radio', { name: /^Cleaner/ })).toHaveCount(0)
    await team.getByRole('radio', { name: /^Kitchen/ }).check()
    const table = Object.values(restaurant.products).find(product => product.kind === 'table')
    if (!table) throw new Error('No restaurant table in the fixture')
    await team.getByRole('combobox', { name: table.name, exact: true }).click()
    await team.getByRole('option', { name: 'Tasks', exact: true }).click()
    await team.getByRole('button', { name: 'Send invite', exact: true }).click()
    const pending = team.getByRole('listitem').filter({ hasText: invitee.email })
    await expect(pending).toContainText('Email: recorded locally')
    const pendingActions = pending.getByRole('button', { name: `Actions for ${invitee.email}` })
    await expect(pendingActions).toBeVisible()
    const list = await request.get('/api/auth/organization/list-invitations', { params: { organizationId: restaurant.organizationId } })
    expect(list.status()).toBe(200)
    const sent = (await list.json() as Array<{ email: string; id: string; status: string; role: string }>).find(invitation => invitation.email === invitee.email)
    expect(sent).toMatchObject({ status: 'pending', role: 'kitchen' })
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
    expect.objectContaining({ id: restaurant.organizationId, role: 'kitchen' }),
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

for (const [key, role, kind] of [['legal', 'paralegal', 'service'], ['experience', 'member', 'experience'], ['restaurant', 'kitchen', 'table']] as const) {
  test(`invite grants and task scope in ${key}`, async ({ request, playwright, baseURL }) => {
    const tenant = seededTenant(key)
    const listing = Object.values(tenant.products).find(product => product.kind === kind)
    if (!listing) throw new Error(`No ${kind} in the fixture`)
    const headers = authRequestHeaders(baseURL!)
    const options = { headers, params: { organization_id: tenant.organizationId } }
    await loginAs(request, baseURL!)
    const screenResponse = await request.get('/api/dashboard/members', { params: { org: tenant.slug, view: 'invite' } })
    expect(screenResponse.status(), await screenResponse.text()).toBe(200)
    const screen = await screenResponse.json()
    expect(screen.roles.map((item: { value: string }) => item.value)).toContain(role)
    expect(screen.listings).toContainEqual(expect.objectContaining({ listing_id: listing.id }))
    expect(screen).not.toHaveProperty('members')
    expect(screen).not.toHaveProperty('invitations')

    const users = await Promise.all(['user-e2e-oauth-cimd', 'user-e2e-mcp-fresh-cross-a'].map(async id => {
      const user = await playwright.request.newContext({ baseURL })
      await loginAs(user, baseURL!, id)
      return { user, email: findE2eAuthFixture(id).email }
    }))
    try {
      const invite = (email: string, requestedRole: string, listingID = listing.id) => request.post('/api/auth/organization/invite-member', {
        headers, data: { organizationId: tenant.organizationId, email, role: requestedRole, listing_access: JSON.stringify([{ listing_id: listingID, access: 'tasks' }]) },
      })
      const invalid = await invite(users[0]!.email, 'cleaner')
      expect(invalid.status(), await invalid.text()).toBe(400)
      const missingListing = await invite(users[0]!.email, role, crypto.randomUUID())
      expect(missingListing.status(), await missingListing.text()).toBe(400)

      const memberships = await Promise.all(users.map(async ({ user, email }) => {
        const sent = await invite(email, role)
        expect(sent.status(), await sent.text()).toBe(200)
        const invitation = await sent.json()
        const membership = await acceptOrganizationInvitation(user, baseURL!, invitation.id)
        expect(membership.role).toBe(role)
        return membership
      }))
      const grantsPath = `/api/messages/listings/${listing.id}/participants`
      const grants = await request.get(grantsPath, options)
      expect(grants.status(), await grants.text()).toBe(200)
      expect(await grants.json()).toMatchObject({ grants: expect.arrayContaining(memberships.map(member => ({ member_id: member.id, access: 'tasks' }))) })
      if (key !== 'restaurant') return

      const tasks = `/api/organizations/${tenant.organizationId}/tasks`
      const created = await request.post(tasks, { headers, data: {
        title: 'Prepare for dinner service', notes: 'Private work instructions', product_id: listing.id, claim_role: role, idempotency_key: crypto.randomUUID(),
      } })
      expect(created.status(), await created.text()).toBe(201)
      const { task } = await created.json()
      for (const { user } of users) {
        const visible = await user.get(`${tasks}/${task.id}`)
        expect(visible.status(), await visible.text()).toBe(200)
        expect(await visible.json()).toMatchObject({ task: { notes: null, action: { type: 'claim' } } })
        const today = await user.get('/api/dashboard/today', { params: { org: tenant.slug } })
        expect(today.status(), await today.text()).toBe(200)
        expect(await today.json()).toMatchObject({ cards: expect.arrayContaining([expect.objectContaining({ id: `task:${task.id}`, claim: expect.objectContaining({ version: task.version }) })]) })
      }
      const outcomes = await Promise.all(users.map(({ user }) => user.patch(`${tasks}/${task.id}`, { headers, data: { version: task.version, claim: true } })))
      expect(outcomes.map(response => response.status()).sort()).toEqual([200, 409])
      const winner = outcomes.findIndex(response => response.status() === 200)
      const persisted = await request.get(`${tasks}/${task.id}`)
      expect(await persisted.json()).toMatchObject({ task: { notes: 'Private work instructions', assignee: { id: memberships[winner]!.id } } })
      const denied = await users[1 - winner]!.user.get(`${tasks}/${task.id}`)
      expect(denied.status()).toBe(404)
      const revoked = await request.put(grantsPath, { ...options, data: { member_id: memberships[winner]!.id, access: null } })
      expect(revoked.status(), await revoked.text()).toBe(200)
      expect((await users[winner]!.user.get(`${tasks}/${task.id}`)).status()).toBe(404)
      const afterRevoke = await request.get(`${tasks}/${task.id}`)
      expect(afterRevoke.status(), await afterRevoke.text()).toBe(200)
      expect(await afterRevoke.json()).toMatchObject({ task: { assignee: { id: memberships[winner]!.id } } })

      const manager = await playwright.request.newContext({ baseURL })
      try {
        const operator = findE2eAuthFixture('user-e2e-oauth-private-cimd')
        await loginAs(manager, baseURL!, operator.id)
        const sent = await request.post('/api/auth/organization/invite-member', { headers, data: {
          organizationId: tenant.organizationId, email: operator.email, role: 'restaurant_manager',
        } })
        expect(sent.status(), await sent.text()).toBe(200)
        const joined = await acceptOrganizationInvitation(manager, baseURL!, (await sent.json()).id)
        expect(joined.role).toBe('restaurant_manager')
        const calendar = await manager.get('/api/dashboard/bookings/calendar', { params: {
          org: tenant.slug, unit: 'slot', from: '2026-11-01', to: '2026-11-03',
        } })
        expect(calendar.status(), await calendar.text()).toBe(200)
        expect(await calendar.json()).toMatchObject({ manage: true, places: expect.arrayContaining([expect.objectContaining({ place: expect.objectContaining({ kind: 'location' }) })]) })
        const settings = await manager.get('/api/dashboard/settings', { params: { org: tenant.slug } })
        expect(settings.status(), await settings.text()).toBe(404)
        const inviteScreen = await manager.get('/api/dashboard/members', { params: { org: tenant.slug, view: 'invite' } })
        expect(inviteScreen.status(), await inviteScreen.text()).toBe(403)
      } finally {
        await manager.dispose()
      }
    } finally {
      await Promise.all(users.map(({ user }) => user.dispose()))
    }
  })
}
