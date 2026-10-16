import { expect, test, type Page } from '@playwright/test'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { isAccountActivityResponse } from '../../shared/account-activity'
import { isBookingDetailsResponse } from '../../composables/useBookingDetails'
import type { DashboardArticleCategory } from '../../composables/useArticleCategories'
import type { NotificationPreferenceMap } from '../../composables/useNotificationPreferences'
import type { SessionAvailability } from '../../server/utils/availability'
import type { OrganizationMembersData } from '../../utils/organization-members'
import { localNow, timezoneLabel } from '../../utils/timezone'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import type { Collection, Product } from '../../server/types/products'
import type { DashboardLocation } from '../../composables/useDashboardOrganization'
import type { TodayFeedPayload } from '../../shared/dashboard-today'

// The dashboard's pane topology is the nested route tree (DESIGN.md, Route
// hierarchy). On a wide screen a level renders beside the parent its Back goes
// to, an index of deterministic settings opens its first one, and a list of
// records opens nothing. Below `lg` an index is one screen and a leaf is a
// modal drawer over its own index.

const ORG = '/dashboard/ember-slice-demo'
const WIDE = { width: 1440, height: 900 }
const NARROW = { width: 900, height: 900 }
const PHONE = { width: 390, height: 844 }
// A short phone, so the demo owner's real Today cards overflow and the scroll end is measurable.
const SHORT_PHONE = { width: 390, height: 600 }

/** The panes on screen, left to right, by the id each DashboardIndexPanel/LeafPanel is given. */
async function visiblePanes(page: Page): Promise<string[]> {
  return page.locator('[id^="dashboard-panel-"]').evaluateAll(elements => elements
    .filter(element => element.getBoundingClientRect().width > 0)
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
    .map(element => element.id.replace('dashboard-panel-', '')))
}

async function expectPanes(page: Page, panes: string[]) {
  await expect.poll(() => visiblePanes(page)).toEqual(panes)
}

async function open(page: Page, path: string) {
  const response = await page.goto(path)
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
}

test.describe('dashboard pane hierarchy', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await dismissPreviewToolbar(page)
    await loginAs(page.request, baseURL!)
  })

  test('each Menu destination is a root at its own URL, and Website content nests under Website', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await open(page, `${ORG}/menu`)
    const segments = ['website/pages', 'website/blog', 'website/qa', 'website/brand', 'website/pages/links', 'website/posts', 'locations', 'team', 'products', 'products/menu', 'products/services']
    const resolved = await page.evaluate(({ org, segments }) => {
      const router = (document.querySelector('#__nuxt') as Element & {
        __vue_app__: { config: { globalProperties: { $router: { resolve: (path: string) => { path: string; matched: Array<{ path: string; meta: { tab?: unknown; back?: unknown } }> } } } } }
      }).__vue_app__.config.globalProperties.$router
      return Object.fromEntries(segments.map((segment) => {
        const location = router.resolve(`${org}/${segment}`)
        // A directory's index.vue shares its parent's path; it is one level.
        const levels = location.matched.map(record => record.path).filter((path, at, all) => at === 0 || path !== all[at - 1])
        return [segment, { path: location.path, levels, tab: location.matched[0]?.meta.tab ?? null, back: location.matched[0]?.meta.back ?? null }]
      }))
    }, { org: ORG, segments })

    // Menu is a launcher: no destination nests under it. Each declares Menu as
    // its tab and exits to Menu; Catalog is a primary destination with no exit.
    const o = '/dashboard/:orgSlug()'
    const website = { tab: 'menu', back: 'menu' }
    expect(resolved).toEqual({
      'website/pages': { path: `${ORG}/website/pages`, levels: [`${o}/website`, `${o}/website/pages`], ...website },
      'website/blog': { path: `${ORG}/website/blog`, levels: [`${o}/website`, `${o}/website/blog`], ...website },
      'website/qa': { path: `${ORG}/website/qa`, levels: [`${o}/website`, `${o}/website/qa`], ...website },
      'website/brand': { path: `${ORG}/website/brand`, levels: [`${o}/website`, `${o}/website/brand`], ...website },
      'website/pages/links': { path: `${ORG}/website/pages/links`, levels: [`${o}/website`, `${o}/website/pages`, `${o}/website/pages/links`], ...website },
      'website/posts': { path: `${ORG}/website/posts`, levels: [`${o}/website`, `${o}/website/posts`], ...website },
      'locations': { path: `${ORG}/locations`, levels: [`${o}/locations`], ...website },
      'team': { path: `${ORG}/team`, levels: [`${o}/team`], ...website },
      'products': { path: `${ORG}/products`, levels: [`${o}/products`], tab: 'catalog', back: null },
      'products/menu': { path: `${ORG}/products/menu`, levels: [`${o}/products`, `${o}/products/menu`], tab: 'catalog', back: null },
    })
  })

  test('a record list renders beside its parent and selects nothing; a Menu destination stands alone', async ({ page }) => {
    await page.setViewportSize(WIDE)
    for (const [path, parent, pane] of [
      ['website/pages', 'organization-website', 'organization-pages'],
      ['website/blog', 'organization-website', 'organization-blog'],
      ['website/posts', 'organization-website', 'organization-posts'],
    ] as const) {
      await open(page, `${ORG}/${path}`)
      await expectPanes(page, [parent, pane])
      await expect(page).toHaveURL(`${ORG}/${path}`)
      // The parent names the open row.
      await expect(page.locator(`#dashboard-panel-${parent} [aria-current="page"]`)).toHaveCount(1)
    }
    for (const [path, pane] of [['locations', 'locations'], ['team', 'organization-members']] as const) {
      await open(page, `${ORG}/${path}`)
      await expectPanes(page, [pane])
      await expect(page).toHaveURL(`${ORG}/${path}`)
      // Its exit is Menu: a way out, not a pane beside it.
      await expect(page.locator(`#dashboard-panel-${pane} [data-testid="dashboard-navbar-back"]`)).toHaveAttribute('href', `${ORG}/menu`)
    }
  })

  test('Team changes member roles through Better Auth, and self-demotion refreshes context before leaving Team', async ({ page, baseURL, browser }) => {
    test.skip(Boolean(process.env.PLAYWRIGHT_PREVIEW_URL), 'Role writes use local D1 only.')
    const organizationId = 'org-demo'
    const before = await page.request.get('/api/auth/organization/list-members', { params: { organizationId } })
    expect(before.status(), await before.text()).toBe(200)
    const members = (await before.json() as { members: Array<{ id: string; userId: string; role: string; user: { name: string } }> }).members
    const member = members.find(item => item.userId === 'user-e2e-demo-role-owner')
    expect(member).toBeDefined()
    expect(member!.role).toBe('owner')
    expect(members.some(item => item.id !== member!.id && item.role === 'owner'), 'self-demotion requires another existing owner').toBe(true)
    const ownerContext = await browser.newContext({ baseURL, viewport: NARROW })
    try {
      await open(page, `${ORG}/team`)
      const role = page.getByRole('combobox', { name: `Role for ${member!.user.name}`, exact: true })
      await role.click()
      await page.getByRole('option', { name: 'Admin', exact: true }).click()
      await expect(role).toContainText('Admin')
      const persisted = await page.request.get('/api/dashboard/members', { params: { org: 'ember-slice-demo' } })
      expect(persisted.status(), await persisted.text()).toBe(200)
      expect((await persisted.json() as { members: Array<{ id: string; role: string }> }).members.find(item => item.id === member!.id)?.role).toBe('admin')
      await page.reload()
      await waitForNuxtHydration(page)
      await expect(page.getByRole('combobox', { name: `Role for ${member!.user.name}`, exact: true })).toContainText('Admin')

      const restoredOwner = await page.request.post('/api/auth/organization/update-member-role', { headers: authRequestHeaders(baseURL!), data: { organizationId, memberId: member!.id, role: member!.role } })
      expect(restoredOwner.status(), await restoredOwner.text()).toBe(200)
      await loginAs(ownerContext.request, baseURL!, member!.userId)
      const ownerPage = await ownerContext.newPage()
      const pageErrors: string[] = []
      ownerPage.on('pageerror', error => pageErrors.push(error.message))
      await open(ownerPage, `${ORG}/team`)
      const selfRole = ownerPage.getByRole('combobox', { name: `Role for ${member!.user.name}`, exact: true })
      await expect(selfRole).toContainText('Owner')
      const contextRefresh = ownerPage.waitForResponse(response => {
        const url = new URL(response.url())
        return url.pathname === '/api/dashboard/context' && url.searchParams.get('org') === 'ember-slice-demo'
      })
      await selfRole.click()
      await ownerPage.getByRole('option', { name: 'Member', exact: true }).click()
      const refreshed = await contextRefresh
      expect(refreshed.status(), await refreshed.text()).toBe(200)
      expect(await refreshed.json()).toMatchObject({ organization: { id: organizationId, role: 'member' } })
      await expect(ownerPage).toHaveURL('/dashboard/account/profile/calendar/org-demo')
      await expect(ownerPage.locator('#dashboard-panel-member-availability').getByRole('heading', { name: 'Your availability', exact: true })).toBeVisible()
      await expect(ownerPage.locator('#dashboard-panel-member-availability').getByRole('link', { name: /^Hours/ })).toHaveAttribute('href', '/dashboard/account/profile/calendar/org-demo/hours')
      await expect(ownerPage.locator('#dashboard-panel-organization-members')).toHaveCount(0)
      const independentRead = await page.request.get('/api/dashboard/members', { params: { org: 'ember-slice-demo' } })
      expect(independentRead.status(), await independentRead.text()).toBe(200)
      expect((await independentRead.json() as { members: Array<{ id: string; role: string }> }).members.find(item => item.id === member!.id)?.role).toBe('member')
      expect(pageErrors).toEqual([])
    } finally {
      try {
        const restored = await page.request.post('/api/auth/organization/update-member-role', { headers: authRequestHeaders(baseURL!), data: { organizationId, memberId: member!.id, role: member!.role } })
        expect(restored.status(), await restored.text()).toBe(200)
        const read = await page.request.get('/api/dashboard/members', { params: { org: 'ember-slice-demo' } })
        expect(read.status()).toBe(200)
        expect((await read.json() as { members: Array<{ id: string; role: string }> }).members.find(item => item.id === member!.id)?.role).toBe('owner')
      } finally {
        await ownerContext.close()
      }
    }
  })

  test('Booking team forms create, rename and change native Better Auth membership', async ({ page, baseURL, playwright }) => {
    test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Team writes require isolated local D1.')
    const organizationId = 'org-demo'
    const membersResponse = await page.request.get('/api/auth/organization/list-members', { params: { organizationId } })
    expect(membersResponse.status(), await membersResponse.text()).toBe(200)
    const member = (await membersResponse.json() as { members: Array<{ userId: string; user: { name: string } }> }).members.find(row => row.userId === 'user-e2e-demo-role-owner')
    expect(member).toBeDefined()
    const readTeams = async () => {
      const response = await page.request.get('/api/dashboard/members', { params: { org: 'ember-slice-demo' } })
      expect(response.status(), await response.text()).toBe(200)
      return (await response.json() as OrganizationMembersData).teams
    }
    const name = `E2E Booking Team ${Date.now().toString(36)}`
    let teamId: string | null = null
    try {
      await page.setViewportSize(PHONE)
      await open(page, `${ORG}/team/groups/new/name`)
      const leaf = page.locator('#dashboard-panel-booking-team-setting')
      await expect(page.getByRole('dialog', { name: 'Team name', exact: true })).toBeVisible()
      await expect(page.locator('#dashboard-panel-booking-team')).toBeVisible()
      await expect(leaf.getByRole('button', { name: 'Create team', exact: true })).toBeDisabled()
      await leaf.getByRole('textbox', { name: 'Team name', exact: true }).fill(name)
      const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/organization/create-team' && response.request().method() === 'POST')
      await leaf.getByRole('button', { name: 'Create team', exact: true }).click()
      const createdResponse = await created
      expect(createdResponse.status(), await createdResponse.text()).toBe(200)
      teamId = (await createdResponse.json() as { id: string }).id
      await expect(page).toHaveURL(`${ORG}/team/groups/${teamId}`)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.locator('#dashboard-panel-booking-team')).toContainText(name)
      const original = (await readTeams()).find(row => row.id === teamId)
      expect(original).toMatchObject({ id: teamId, name, organizationId })
      expect(original!.members.map(row => row.userId)).not.toContain(member!.userId)

      await open(page, `${ORG}/team/groups/${teamId}/name`)
      await expect(page.getByRole('dialog', { name: 'Team name', exact: true })).toBeVisible()
      await expect(page.locator('#dashboard-panel-booking-team')).toContainText(name)
      const save = leaf.getByRole('button', { name: 'Save', exact: true })
      await expect(save).toBeDisabled()
      const renamed = `${name} renamed`
      await leaf.getByRole('textbox', { name: 'Team name', exact: true }).fill(renamed)
      await expect(save).toBeEnabled()
      for (const viewport of [WIDE, PHONE]) {
        await page.setViewportSize(viewport)
        await expect(leaf.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue(renamed)
        await expect(save).toBeEnabled()
      }
      await save.click()
      await expect(page).toHaveURL(`${ORG}/team/groups/${teamId}`)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.locator('#dashboard-panel-booking-team')).toContainText(renamed)
      expect((await readTeams()).find(row => row.id === teamId)?.name).toBe(renamed)

      await open(page, `${ORG}/team/groups/${teamId}/members`)
      const included = leaf.getByRole('switch', { name: member!.user.name, exact: true })
      await expect(included).not.toBeChecked()
      await expect(save).toBeDisabled()
      await included.click()
      await expect(save).toBeEnabled()
      await save.click()
      await expect(page).toHaveURL(`${ORG}/team/groups/${teamId}`)
      expect((await readTeams()).find(row => row.id === teamId)?.members.map(row => row.userId).sort()).toEqual([...original!.members.map(row => row.userId), member!.userId].sort())
      const memberReader = await playwright.request.newContext({ baseURL })
      try {
        await loginAs(memberReader, baseURL!, member!.userId)
        const nativeMembers = await memberReader.get('/api/auth/organization/list-team-members', { params: { teamId } })
        expect(nativeMembers.status(), await nativeMembers.text()).toBe(200)
        expect((await nativeMembers.json() as OrganizationMembersData['teams'][number]['members']).map(row => row.userId).sort()).toEqual([...original!.members.map(row => row.userId), member!.userId].sort())
      } finally {
        await memberReader.dispose()
      }

      await open(page, `${ORG}/team/groups/${teamId}/members`)
      await expect(included).toBeChecked()
      await expect(save).toBeDisabled()
      await included.click()
      await save.click()
      await expect(page).toHaveURL(`${ORG}/team/groups/${teamId}`)
      expect((await readTeams()).find(row => row.id === teamId)?.members.map(row => row.userId).sort()).toEqual(original!.members.map(row => row.userId).sort())
    } finally {
      if (teamId) {
        const removed = await page.request.post('/api/auth/organization/remove-team', { headers: authRequestHeaders(baseURL!), data: { organizationId, teamId } })
        expect(removed.status(), await removed.text()).toBe(200)
        expect((await readTeams()).map(row => row.id)).not.toContain(teamId)
      }
    }
  })

  test('Notification form saves each channel and reloads the account preference', async ({ page, baseURL }) => {
    test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Preference writes require isolated local D1.')
    await page.context().clearCookies()
    await loginAs(page.request, baseURL!, 'user-e2e-kikuzuki-owner')
    const session = await page.request.get('/api/auth/get-session')
    expect(session.status(), await session.text()).toBe(200)
    expect((await session.json()).user.phoneNumberVerified).toBe(true)
    const read = async () => {
      const response = await page.request.get('/api/user/notification-preferences')
      expect(response.status(), await response.text()).toBe(200)
      return (await response.json() as { preferences: NotificationPreferenceMap }).preferences
    }
    const before = await read()
    const category = 'reviews'
    const wanted = { email: !before[category].email, whatsapp: !before[category].whatsapp, push: !before[category].push }
    const path = `/dashboard/account/profile/notifications/${category}`
    const leaf = page.locator('#dashboard-panel-account-notification-category')
    const save = leaf.getByRole('button', { name: 'Save', exact: true })
    try {
      await page.setViewportSize(NARROW)
      await open(page, path)
      await expect(save).toBeDisabled()
      await leaf.getByRole('switch', { name: 'Email', exact: true }).click()
      await expect(save).toBeEnabled()
      const emailSaved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/user/notification-preferences' && response.request().method() === 'PATCH')
      await save.click()
      const emailResponse = await emailSaved
      expect(emailResponse.status(), await emailResponse.text()).toBe(200)
      expect(await read()).toEqual({ ...before, [category]: { ...before[category], email: wanted.email } })
      await expect(save).toBeDisabled()

      await page.reload()
      await waitForNuxtHydration(page)
      await expect(leaf.getByRole('switch', { name: 'Email', exact: true })).toHaveAttribute('aria-checked', String(wanted.email))
      await expect(save).toBeDisabled()
      await leaf.getByRole('switch', { name: 'WhatsApp', exact: true }).click()
      await expect(save).toBeEnabled()
      const whatsappSaved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/user/notification-preferences' && response.request().method() === 'PATCH')
      await save.click()
      const whatsappResponse = await whatsappSaved
      expect(whatsappResponse.status(), await whatsappResponse.text()).toBe(200)
      expect(await read()).toEqual({ ...before, [category]: { ...before[category], email: wanted.email, whatsapp: wanted.whatsapp } })
      await expect(save).toBeDisabled()

      await page.reload()
      await waitForNuxtHydration(page)
      await expect(leaf.getByRole('switch', { name: 'WhatsApp', exact: true })).toHaveAttribute('aria-checked', String(wanted.whatsapp))
      await leaf.getByRole('switch', { name: 'Push notifications', exact: true }).click()
      await expect(save).toBeEnabled()
      const pushSaved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/user/notification-preferences' && response.request().method() === 'PATCH')
      await save.click()
      const pushResponse = await pushSaved
      expect(pushResponse.status(), await pushResponse.text()).toBe(200)
      expect(await read()).toEqual({ ...before, [category]: wanted })
      await expect(save).toBeDisabled()
    } finally {
      const restored = await page.request.patch('/api/user/notification-preferences', { data: { category, ...before[category] } })
      expect(restored.status(), await restored.text()).toBe(200)
      expect(await read()).toEqual(before)
      await open(page, path)
      await expect(leaf.getByRole('switch', { name: 'Email', exact: true })).toHaveAttribute('aria-checked', String(before[category].email))
      await expect(leaf.getByRole('switch', { name: 'WhatsApp', exact: true })).toHaveAttribute('aria-checked', String(before[category].whatsapp))
      await expect(leaf.getByRole('switch', { name: 'Push notifications', exact: true })).toHaveAttribute('aria-checked', String(before[category].push))
      await expect(save).toBeDisabled()
    }
  })

  test('Category form retries a failed write and persists each named field through MCP', async ({ page, baseURL }) => {
    test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Category writes require isolated local D1.')
    const read = async () => {
      const response = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'list_article_categories', args: { organization_id: 'org-demo', collection: 'blog' } })
      expect(response.status(), await response.text()).toBe(200)
      return mcpData<{ categories: DashboardArticleCategory[] }>(await response.json()).categories
    }
    const before = await read()
    const category = before.find(row => row.id === 'ad2dd862-18ec-46f5-a601-d653fe223542')
    const parent = before.find(row => row.id === 'acat_9b2495848c41ed0acff635bb')
    expect(category).toBeDefined()
    expect(parent).toBeDefined()
    expect(category!.parent_id).toBeNull()
    expect(parent!.parent_id).toBeNull()
    expect(category!.child_count).toBe(0)
    expect(category!.sort_order).toBe(Math.max(...before.filter(row => row.parent_id === null).map(row => row.sort_order)))
    const endpoint = `/api/editor/organizations/org-demo/blog/categories/${category!.id}`
    const path = `${ORG}/website/blog/categories/${category!.id}`
    const leaf = page.locator('#dashboard-panel-organization-blog-category')
    const save = leaf.getByRole('button', { name: 'Save', exact: true })
    const name = `E2E Category ${Date.now().toString(36)}`
    const description = 'A category description saved through its native form.'
    const interceptCategory = (url: URL) => url.pathname === endpoint
    let failedWrites = 0
    try {
      await page.setViewportSize(NARROW)
      await open(page, path)
      await expect(save).toBeDisabled()
      await leaf.getByLabel('Name', { exact: true }).fill(name)
      await expect(save).toBeEnabled()
      await page.route(interceptCategory, async route => {
        if (route.request().method() !== 'PATCH') return await route.continue()
        failedWrites += 1
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Category write failed for retry verification' }) })
      })
      const failed = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'PATCH')
      await save.click()
      expect((await failed).status()).toBe(503)
      await expect(leaf.getByText('Category write failed for retry verification', { exact: true })).toBeVisible()
      expect((await read()).find(row => row.id === category!.id)?.name).toBe(category!.name)
      await expect(save).toBeEnabled()
      expect(failedWrites).toBe(1)
      await page.unroute(interceptCategory)
      const retry = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'PATCH')
      await save.click()
      const retryResponse = await retry
      expect(retryResponse.status(), await retryResponse.text()).toBe(200)
      expect((await read()).find(row => row.id === category!.id)).toMatchObject({ name, slug: category!.slug, description: category!.description, parent_id: category!.parent_id })
      await expect(save).toBeDisabled()

      await leaf.getByRole('textbox', { name: 'Description', exact: true }).fill(description)
      await expect(save).toBeEnabled()
      const descriptionSaved = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'PATCH')
      await save.click()
      const descriptionResponse = await descriptionSaved
      expect(descriptionResponse.status(), await descriptionResponse.text()).toBe(200)
      expect((await read()).find(row => row.id === category!.id)).toMatchObject({ name, description, parent_id: null })
      await expect(save).toBeDisabled()

      await leaf.getByRole('combobox', { name: 'Parent', exact: true }).click()
      await page.getByRole('option', { name: parent!.name, exact: true }).click()
      await expect(save).toBeEnabled()
      const parentSaved = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'PATCH')
      await save.click()
      const parentResponse = await parentSaved
      expect(parentResponse.status(), await parentResponse.text()).toBe(200)
      expect((await read()).find(row => row.id === category!.id)).toMatchObject({ name, description, parent_id: parent!.id, slug: category!.slug })
      await page.reload()
      await waitForNuxtHydration(page)
      await expect(leaf.getByLabel('Name', { exact: true })).toHaveValue(name)
      await expect(leaf.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(description)
      await expect(leaf.getByRole('combobox', { name: 'Parent', exact: true })).toContainText(parent!.name)
      await expect(save).toBeDisabled()

      await leaf.getByRole('combobox', { name: 'Parent', exact: true }).click()
      await page.getByRole('option', { name: 'Top level', exact: true }).click()
      await expect(save).toBeEnabled()
      const topLevelSaved = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'PATCH')
      await save.click()
      const topLevelResponse = await topLevelSaved
      expect(topLevelResponse.status(), await topLevelResponse.text()).toBe(200)
      expect(topLevelResponse.request().postDataJSON().parent_id).toBeNull()
      expect((await read()).find(row => row.id === category!.id)).toMatchObject({ name, description, parent_id: null, sort_order: category!.sort_order })
      await expect(leaf.getByRole('combobox', { name: 'Parent', exact: true })).toContainText('Top level')
      await expect(save).toBeDisabled()
    } finally {
      await page.unroute(interceptCategory)
      const restored = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'update_article_category', args: { organization_id: 'org-demo', category_id: category!.id, name: category!.name, description: category!.description, parent_id: category!.parent_id } })
      expect(restored.status(), await restored.text()).toBe(200)
      expect(mcpData<{ category: DashboardArticleCategory }>(await restored.json()).category).toMatchObject(category!)
      expect((await read()).find(row => row.id === category!.id)).toEqual(category)
      await open(page, path)
      await expect(leaf.getByLabel('Name', { exact: true })).toHaveValue(category!.name)
      await expect(save).toBeDisabled()
    }
  })

  test('Dated session form saves times, capacity and status and restores the occurrence', async ({ page, baseURL }, testInfo) => {
    test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Session writes require isolated local D1.')
    const organizationId = 'org-user-pottery-house'
    const release = await acquireTenantMutationLock(testInfo, organizationId)
    try {
      await page.context().clearCookies()
      await loginAs(page.request, baseURL!, 'user-e2e-pottery-owner')
      const productId = 'exp-ph-wheel'
      const endpoint = `/api/editor/organizations/${organizationId}/products/${productId}/sessions`
      const from = new Date(Date.now() + 25 * 86_400_000).toISOString()
      const to = new Date(Date.now() + 40 * 86_400_000).toISOString()
      const list = async () => {
        const response = await page.request.get(endpoint, { params: { from, to } })
        expect(response.status(), await response.text()).toBe(200)
        return (await response.json() as { sessions: SessionAvailability[] }).sessions
      }
      const original = (await list()).find(row => row.location_id === 'loc-pottery-house' && row.status === 'scheduled' && row.claimed === 0 && localNow(row.timezone, new Date(row.starts_at)).time === '11:00')
      expect(original, 'the seeded product has an unclaimed daytime occurrence in its own location').toBeDefined()
      expect(original!.capacity).toBe(8)
      const localInput = (instant: string) => {
        const value = localNow(original!.timezone, new Date(instant))
        return `${value.date}T${value.time}`
      }
      const startsAt = new Date(Date.parse(original!.starts_at) + 15 * 60_000).toISOString()
      const endsAt = new Date(Date.parse(original!.ends_at) + 15 * 60_000).toISOString()
      const sessionListPath = `/dashboard/org-user-pottery-house/products/${productId}/booking/sessions?location_id=${original!.location_id}`
      const path = `/dashboard/org-user-pottery-house/products/${productId}/booking/sessions/${original!.id}?location_id=${original!.location_id}`
      const leaf = page.locator('#dashboard-panel-product-session')
      const save = leaf.getByRole('button', { name: 'Save', exact: true })
      const commit = async () => {
        await expect(save).toBeEnabled()
        const saved = page.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/${original!.id}` && response.request().method() === 'PATCH')
        await save.click()
        const response = await saved
        expect(response.status(), await response.text()).toBe(200)
        await expect(page).toHaveURL(sessionListPath)
      }
      try {
        await page.setViewportSize(NARROW)
        await open(page, path)
        await expect(save).toBeDisabled()
        await leaf.getByLabel('Starts', { exact: true }).fill(localInput(startsAt))
        await commit()
        expect((await list()).find(row => row.id === original!.id)).toMatchObject({ starts_at: startsAt, ends_at: original!.ends_at, capacity: 8, status: 'scheduled' })

        await open(page, path)
        await expect(save).toBeDisabled()
        await leaf.getByLabel('Ends', { exact: true }).fill(localInput(endsAt))
        await commit()
        expect((await list()).find(row => row.id === original!.id)).toMatchObject({ starts_at: startsAt, ends_at: endsAt, capacity: 8, status: 'scheduled' })

        await open(page, path)
        await expect(save).toBeDisabled()
        await leaf.getByRole('spinbutton', { name: 'Guest limit', exact: true }).fill('9')
        await leaf.getByRole('spinbutton', { name: 'Guest limit', exact: true }).press('Tab')
        await commit()
        expect((await list()).find(row => row.id === original!.id)).toMatchObject({ starts_at: startsAt, ends_at: endsAt, capacity: 9, status: 'scheduled' })

        await open(page, path)
        await expect(save).toBeDisabled()
        await leaf.getByRole('radio', { name: 'Cancelled', exact: true }).click()
        await commit()
        expect((await list()).find(row => row.id === original!.id)).toMatchObject({ starts_at: startsAt, ends_at: endsAt, capacity: 9, status: 'cancelled' })
      } finally {
        const current = (await list()).find(row => row.id === original!.id)
        expect(current).toBeDefined()
        const restored = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'update_product_session', args: { organization_id: organizationId, product_id: productId, session_id: original!.id, expected_updated_at: current!.updated_at, starts_at: original!.starts_at, ends_at: original!.ends_at, capacity: original!.capacity, status: original!.status } })
        expect(restored.status(), await restored.text()).toBe(200)
        expect(mcpData<{ session: SessionAvailability }>(await restored.json()).session).toMatchObject({ id: original!.id, starts_at: original!.starts_at, ends_at: original!.ends_at, capacity: original!.capacity, status: original!.status })
        expect((await list()).find(row => row.id === original!.id)).toMatchObject({ id: original!.id, starts_at: original!.starts_at, ends_at: original!.ends_at, capacity: original!.capacity, status: original!.status })
        await open(page, path)
        await expect(leaf.getByLabel('Starts', { exact: true })).toHaveValue(localInput(original!.starts_at))
        await expect(leaf.getByLabel('Ends', { exact: true })).toHaveValue(localInput(original!.ends_at))
        await expect(leaf.getByRole('spinbutton', { name: 'Guest limit', exact: true })).toHaveValue('8')
        await expect(leaf.getByRole('radio', { name: 'Scheduled', exact: true })).toBeChecked()
        await expect(save).toBeDisabled()
      }
    } finally {
      await release()
    }
  })

  test('Website opens Pages, and Catalog is a root that selects nothing', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await open(page, `${ORG}/website`)
    await expect(page).toHaveURL(`${ORG}/website/pages`)
    await expectPanes(page, ['organization-website', 'organization-pages'])
    await open(page, `${ORG}/products`)
    await expectPanes(page, ['catalog'])
    await expect(page.locator('#dashboard-panel-catalog [data-testid="dashboard-navbar-back"]')).toHaveCount(0)
  })

  test('Catalog opens one menu per location and every other offering as cards, filtered by kind pills', async ({ page }, testInfo) => {
    const [productResponse, collectionResponse, locationResponse] = await Promise.all([
      page.request.get('/api/editor/organizations/org-demo/products'),
      page.request.get('/api/editor/organizations/org-demo/collections'),
      page.request.get('/api/dashboard/locations', { params: { org: 'ember-slice-demo', organization: 'true', status: 'all' } }),
    ])
    for (const response of [productResponse, collectionResponse, locationResponse]) expect(response.status(), await response.text()).toBe(200)
    const { products } = await productResponse.json() as { products: Product[] }
    const { collections } = await collectionResponse.json() as { collections: Collection[] }
    const { locations } = await locationResponse.json() as { locations: DashboardLocation[] }
    expect(locations.length, 'The demo has more than one location, so it has more than one menu').toBeGreaterThan(1)
    const section = collections.find(collection => collection.location_id && products.some(product => product.kind === 'dish' && product.collections.some(membership => membership.collection_id === collection.id)))
    expect(section, 'The demo has a location-owned menu section containing dishes').toBeDefined()
    const menuSections = collections.filter(collection => {
      const members = products.filter(product => product.collections.some(membership => membership.collection_id === collection.id))
      return !members.length || members.some(product => product.kind === 'dish')
    })

    await page.setViewportSize(WIDE)
    await open(page, `${ORG}/products`)
    const catalog = page.locator('#dashboard-panel-catalog')
    await expect(catalog.getByTestId('catalog-kind-all')).toHaveAttribute('aria-pressed', 'true')
    await expect(catalog.getByRole('combobox', { name: 'Location', exact: true })).toHaveCount(0)
    const grid = catalog.getByTestId('catalog-grid')

    for (const location of locations) {
      const card = grid.getByTestId(`selector-item-menu-${location.id}`)
      const count = menuSections.filter(collection => collection.location_id === null || collection.location_id === location.id).length
      await expect(card).toHaveAttribute('href', `${ORG}/products/menu?location_id=${encodeURIComponent(location.id)}`)
      await expect(card.getByRole('heading', { level: 2 })).toHaveText(location.title)
      await expect(card).toContainText(`${count} ${count === 1 ? 'section' : 'sections'}`)
    }
    const offerings = products.filter(product => product.kind !== 'dish')
    await expect(grid.locator('a[data-testid^="selector-item-"]')).toHaveCount(locations.length + offerings.length)
    for (const product of offerings) {
      const card = grid.getByTestId(`selector-item-${product.id}`)
      await expect(card).toHaveAttribute('href', `${ORG}/products/${product.id}`)
      await expect(card.getByRole('heading', { level: 2 })).toHaveText(product.name)
      for (const binding of product.locations) {
        const location = locations.find(row => row.id === binding.location_id)
        expect(location, 'An offering’s location must exist in its tenant').toBeDefined()
        await expect(card).toContainText(location!.title)
      }
      if (product.booking?.held_online) await expect(card).toContainText('Online')
      else if (!product.locations.length) await expect(card).toContainText('No locations set')
      if (product.variants.every(variant => !variant.prices.length)) await expect(card).toContainText('No price set')
    }
    const firstCard = grid.locator('a[data-testid^="selector-item-"]').first()
    const desktopImage = await firstCard.locator('[data-selector-image]').boundingBox()
    expect(desktopImage).not.toBeNull()
    expect(desktopImage!.width / desktopImage!.height).toBeCloseTo(20 / 19, 2)
    await page.screenshot({ path: testInfo.outputPath('catalog-desktop.png'), fullPage: true })

    // A kind pill narrows the grid in place and is held in the URL.
    const kind = (['experience', 'item', 'service'] as const).find(value => offerings.some(product => product.kind === value))
    expect(kind, 'The demo offers something besides its menu').toBeDefined()
    await catalog.getByTestId(`catalog-kind-${kind}`).click()
    await expect(page).toHaveURL(`${ORG}/products?kind=${kind}`)
    await expect(catalog.getByTestId(`catalog-kind-${kind}`)).toHaveAttribute('aria-pressed', 'true')
    await expect(grid.locator('a[data-testid^="selector-item-"]')).toHaveCount(offerings.filter(product => product.kind === kind).length)
    await expect(grid.locator('a[data-testid^="selector-item-menu-"]')).toHaveCount(0)
    await catalog.getByTestId('catalog-kind-menu').click()
    await expect(page).toHaveURL(`${ORG}/products?kind=menu`)
    await expect(grid.locator('a[data-testid^="selector-item-"]')).toHaveCount(locations.length)

    // A phone shows the same cards, each the full width of the grid.
    await page.setViewportSize({ width: 390, height: 844 })
    const mobileCard = grid.locator('a[data-testid^="selector-item-"]').first()
    const mobileImage = await mobileCard.locator('[data-selector-image]').boundingBox()
    const mobileGrid = await grid.boundingBox()
    expect(mobileImage).not.toBeNull()
    expect(mobileGrid).not.toBeNull()
    expect(mobileImage!.width).toBeCloseTo(mobileGrid!.width, 0)
    await page.screenshot({ path: testInfo.outputPath('catalog-mobile.png'), fullPage: true })

    // A location's card opens its menu, named under the title, with nothing to switch.
    const owner = locations.find(row => row.id === section!.location_id)!
    await page.setViewportSize(WIDE)
    await grid.getByTestId(`selector-item-menu-${owner.id}`).click()
    await expect(page).toHaveURL(`${ORG}/products/menu?location_id=${encodeURIComponent(owner.id)}`)
    const menu = page.locator('#dashboard-panel-catalog-menu')
    await expect(menu).toContainText(owner.title)
    await expect(menu.getByRole('combobox', { name: 'Location', exact: true })).toHaveCount(0)
    await open(page, `${ORG}/products/menu/${section!.id}?location_id=${encodeURIComponent(owner.id)}`)
    const member = products.find(product => product.kind === 'dish' && product.collections.some(membership => membership.collection_id === section!.id))!
    await expect(page.getByTestId(`product-${member.id}`)).toContainText(member.name)
  })

  test('mobile scroll keeps real Catalog and menu rows reachable inside their panel', async ({ page }) => {
    const [productsRead, sectionsRead] = await Promise.all([
      page.request.get('/api/editor/organizations/org-demo/products'),
      page.request.get('/api/editor/organizations/org-demo/collections'),
    ])
    expect(productsRead.status(), await productsRead.text()).toBe(200)
    expect(sectionsRead.status(), await sectionsRead.text()).toBe(200)
    const { products } = await productsRead.json() as { products: Product[] }
    const { collections } = await sectionsRead.json() as { collections: Collection[] }
    const sections = collections.map(collection => ({
      collection,
      members: products.filter(product => product.collections.some(row => row.collection_id === collection.id))
        .sort((a, b) => a.collections.find(row => row.collection_id === collection.id)!.sort_order - b.collections.find(row => row.collection_id === collection.id)!.sort_order),
    })).sort((a, b) => b.members.length - a.members.length)
    const section = sections[0]
    expect(section, 'The demo has an existing menu section').toBeDefined()
    expect(section!.members.length).toBeGreaterThan(0)
    await page.setViewportSize(PHONE)

    for (const entry of [
      { path: `${ORG}/products`, id: 'catalog' },
      { path: `${ORG}/products/menu/${section!.collection.id}${section!.collection.location_id ? `?location_id=${encodeURIComponent(section!.collection.location_id)}` : ''}`, id: 'menu-section' },
    ]) {
      await open(page, entry.path)
      const panel = page.locator(`#dashboard-panel-${entry.id}`)
      const body = panel.locator(':scope > [data-slot="body"]')
      const header = panel.locator(':scope > [data-slot="root"]')
      const nav = page.getByTestId('dashboard-mobile-nav')
      const rows = entry.id === 'catalog' ? panel.locator('a[data-testid^="selector-item-"]') : panel.locator('span[data-testid^="product-"]')
      expect(await rows.count()).toBeGreaterThan(0)
      if (entry.id === 'menu-section') {
        await expect(rows).toHaveCount(section!.members.length)
        await expect(rows.last()).toHaveAttribute('data-testid', `product-${section!.members.at(-1)!.id}`)
      } else {
        const href = await rows.last().getAttribute('href')
        const id = new URL(href!, page.url()).pathname.split('/').at(-1)
        const record = products.find(product => product.id === id) ?? collections.find(collection => collection.id === id)
        expect(record, 'The final Catalog row names a real organization record').toBeDefined()
        await expect(rows.last()).toContainText(record!.name)
      }
      await expect(nav).toBeVisible()
      const headerBefore = await header.boundingBox()
      const navBefore = await nav.boundingBox()
      const bodyBox = await body.boundingBox()
      expect(headerBefore).not.toBeNull()
      expect(navBefore).not.toBeNull()
      expect(bodyBox).not.toBeNull()
      expect(bodyBox!.y + bodyBox!.height).toBeLessThanOrEqual(navBefore!.y + 1)
      const documentBefore = await page.evaluate(() => ({ top: document.scrollingElement!.scrollTop, left: scrollX, width: document.documentElement.scrollWidth, height: document.scrollingElement!.scrollHeight }))
      expect(documentBefore.top).toBe(0)
      expect(documentBefore.left).toBe(0)
      expect(documentBefore.width).toBeLessThanOrEqual(PHONE.width)
      expect(documentBefore.height).toBeLessThanOrEqual(PHONE.height)
      const maximum = await body.evaluate(element => element.scrollHeight - element.clientHeight)
      await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0)
      if (entry.id === 'catalog') expect(maximum, 'The actual Catalog has more rows than fit on a phone').toBeGreaterThan(0)
      await page.mouse.move(bodyBox!.x + 4, bodyBox!.y + bodyBox!.height / 2)
      await page.mouse.wheel(0, maximum + bodyBox!.height)
      await expect.poll(() => body.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
      if (maximum > 0) expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      else expect(await body.evaluate(element => element.scrollTop)).toBe(0)
      await expect(rows.last()).toBeInViewport({ ratio: 1 })
      await page.mouse.wheel(0, bodyBox!.height)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      expect(await header.boundingBox()).toEqual(headerBefore)
      expect(await nav.boundingBox()).toEqual(navBefore)
      expect(await page.evaluate(() => ({ top: document.scrollingElement!.scrollTop, left: scrollX, width: document.documentElement.scrollWidth, height: document.scrollingElement!.scrollHeight }))).toEqual(documentBefore)
      expect(await body.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
    }
  })

  test('mobile scroll confines a short Description drawer to its body and pins its controls', async ({ page }) => {
    const productsRead = await page.request.get('/api/editor/organizations/org-demo/products')
    expect(productsRead.status(), await productsRead.text()).toBe(200)
    const product = (await productsRead.json() as { products: Product[] }).products.find(row => row.kind === 'dish')
    expect(product, 'The demo has an existing dish to describe').toBeDefined()
    await page.setViewportSize({ width: 390, height: 568 })
    await open(page, `${ORG}/products/${product!.id}/description`)
    const dialog = page.getByRole('dialog', { name: 'Description', exact: true })
    const panel = page.locator('#dashboard-panel-product-description')
    const body = panel.locator(':scope > [data-slot="body"]')
    const parentBody = page.locator('#dashboard-panel-product > [data-slot="body"]')
    const header = panel.locator(':scope > [data-slot="root"]')
    const save = panel.getByRole('button', { name: 'Save', exact: true })
    await expect(dialog).toBeVisible()
    await expect(panel.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(product!.description ?? '')
    await panel.getByTestId('dashboard-navbar-close').hover()
    const bodyBox = await body.boundingBox()
    expect(bodyBox).not.toBeNull()
    const maximum = await body.evaluate(element => element.scrollHeight - element.clientHeight)
    expect(maximum, 'The real ten-row Description control needs body scrolling in a short window').toBeGreaterThan(0)
    // The body padding receives the wheel; a textarea can own its own scroll.
    await page.mouse.move(bodyBox!.x + 4, bodyBox!.y + bodyBox!.height / 2)
    await page.mouse.wheel(0, -maximum - bodyBox!.height)
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0)
    const headerBefore = await header.boundingBox()
    const saveBefore = await save.boundingBox()
    expect(headerBefore).not.toBeNull()
    expect(saveBefore).not.toBeNull()
    expect(saveBefore!.y).toBeGreaterThanOrEqual(0)
    expect(saveBefore!.y + saveBefore!.height).toBeLessThanOrEqual(568)
    expect(bodyBox!.y + bodyBox!.height).toBeLessThanOrEqual(saveBefore!.y)
    const parentBefore = await parentBody.evaluate(element => element.scrollTop)
    const documentBefore = await page.evaluate(() => ({ top: document.scrollingElement!.scrollTop, left: scrollX, width: document.documentElement.scrollWidth, height: document.scrollingElement!.scrollHeight }))
    expect(documentBefore.top).toBe(0)
    expect(documentBefore.width).toBeLessThanOrEqual(390)
    expect(documentBefore.height).toBeLessThanOrEqual(568)
    await page.mouse.wheel(0, maximum + bodyBox!.height)
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await expect.poll(() => body.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
    await page.mouse.wheel(0, bodyBox!.height)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(await header.boundingBox()).toEqual(headerBefore)
    expect(await save.boundingBox()).toEqual(saveBefore)
    expect(await parentBody.evaluate(element => element.scrollTop)).toBe(parentBefore)
    expect(await page.evaluate(() => ({ top: document.scrollingElement!.scrollTop, left: scrollX, width: document.documentElement.scrollWidth, height: document.scrollingElement!.scrollHeight }))).toEqual(documentBefore)
    expect(await body.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`${ORG}/products/${product!.id}`)
  })

  test('mobile scroll ends Today after its real final card and one panel padding', async ({ page }, testInfo) => {
    const feedRead = await page.request.get('/api/dashboard/today', { params: { org: 'ember-slice-demo', locationId: 'loc-demo' } })
    expect(feedRead.status(), await feedRead.text()).toBe(200)
    const feed = await feedRead.json() as TodayFeedPayload
    expect(feed.cards.length, 'The demo owner has real Today cards').toBeGreaterThan(0)
    await page.setViewportSize(SHORT_PHONE)
    await open(page, `${ORG}?locationId=loc-demo`)
    const panel = page.locator('#dashboard-panel-org-today')
    const body = panel.locator(':scope > [data-slot="body"]')
    const cards = panel.getByTestId('today-card')
    await expect(cards.first()).toBeVisible()
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight), 'Today overflows the phone, so it has a scroll end to measure').toBe(true)
    await expect(page.getByTestId('dashboard-mobile-nav')).toBeVisible()
    const bodyBox = await body.boundingBox()
    expect(bodyBox).not.toBeNull()
    await page.mouse.move(bodyBox!.x + 4, bodyBox!.y + bodyBox!.height / 2)
    while (await cards.count() < feed.cards.length) {
      const count = await cards.count()
      await page.mouse.wheel(0, await body.evaluate(element => element.scrollHeight))
      await expect.poll(() => cards.count()).toBeGreaterThan(count)
    }
    expect(await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-card-id')))).toEqual(feed.cards.map(card => card.id))
    await page.mouse.wheel(0, await body.evaluate(element => element.scrollHeight))
    await expect.poll(() => body.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
    const last = cards.last()
    await expect(last).toContainText(feed.cards.at(-1)!.headline)
    await expect(last).toBeInViewport({ ratio: 1 })
    const finalBody = (await body.boundingBox())!
    const finalCard = (await last.boundingBox())!
    expect(finalBody.y + finalBody.height - finalCard.y - finalCard.height, 'Today has the canonical 16px panel padding after its last card').toBeCloseTo(16, 0)
    const nav = (await page.getByTestId('dashboard-mobile-nav').boundingBox())!
    expect(finalBody.y + finalBody.height).toBeCloseTo(nav.y, 0)
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('today-mobile-scroll-bottom.png'), fullPage: true })
  })

  test('mobile scroll ends Calendar and earnings content at their panel boundary', async ({ page }) => {
    test.setTimeout(60_000)
    for (const entry of [
      { path: `${ORG}/calendar?view=year`, id: 'org-calendar', height: 568, gap: 32 },
      { path: `${ORG}/earnings/payouts`, id: 'earnings-payouts', height: 568, gap: 16 },
      { path: `${ORG}/earnings/transactions`, id: 'earnings-transactions', height: 300, gap: 16 },
    ]) {
      await page.setViewportSize({ width: 390, height: entry.height })
      await open(page, entry.path)
      const panel = page.locator(`#dashboard-panel-${entry.id}`)
      const body = panel.locator(':scope > [data-slot="body"]')
      const header = panel.locator(':scope > [data-slot="root"]')
      const nav = page.getByTestId('dashboard-mobile-nav')
      const last = entry.id === 'org-calendar' ? panel.locator('[data-month]').last()
        : entry.id === 'earnings-payouts' ? panel.getByRole('region', { name: 'Payments help', exact: true })
          : panel.getByText('No transactions in this period.', { exact: true })
      if (entry.id === 'org-calendar') {
        await expect(panel.locator('[data-month]')).toHaveCount(12)
        await expect(last).toHaveAttribute('data-month', /^\d{4}-12$/)
        await expect(last.getByRole('button', { name: 'December', exact: true })).toBeVisible()
        const month = await last.getAttribute('data-month')
        await expect(last.locator(`time[datetime="${month}-31"]`)).toHaveText('31')
      } else if (entry.id === 'earnings-payouts') {
        await expect(panel.getByText('Payouts start once your business is connected to Stripe.', { exact: true })).toBeVisible()
        await expect(last.getByRole('link', { name: 'Go to your transactions', exact: true })).toBeVisible()
      } else {
        await expect(last).toBeVisible()
      }
      await expect(nav).toBeVisible()
      const headerBefore = await header.boundingBox()
      const navBefore = await nav.boundingBox()
      const bodyBox = await body.boundingBox()
      expect(headerBefore).not.toBeNull()
      expect(navBefore).not.toBeNull()
      expect(bodyBox).not.toBeNull()
      expect(bodyBox!.y + bodyBox!.height).toBeCloseTo(navBefore!.y, 0)
      const documentBefore = await page.evaluate(() => ({ top: document.scrollingElement!.scrollTop, left: scrollX, width: document.documentElement.scrollWidth, height: document.scrollingElement!.scrollHeight }))
      expect(documentBefore.top).toBe(0)
      expect(documentBefore.left).toBe(0)
      expect(documentBefore.width).toBeLessThanOrEqual(390)
      expect(documentBefore.height).toBeLessThanOrEqual(entry.height)
      const maximum = await body.evaluate(element => element.scrollHeight - element.clientHeight)
      await page.mouse.move(bodyBox!.x + 4, bodyBox!.y + bodyBox!.height / 2)
      await page.mouse.wheel(0, maximum + bodyBox!.height)
      await expect.poll(() => body.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
      const finalAction = entry.id === 'earnings-payouts' ? last.getByRole('link', { name: 'Go to your transactions', exact: true }) : last
      await expect(finalAction).toBeInViewport({ ratio: 1 })
      if (maximum > 0) {
        const end = (await last.boundingBox())!
        // The calendar's month grid keeps its own 16px below December.
        expect(bodyBox!.y + bodyBox!.height - end.y - end.height, `${entry.id} ends at its content padding and the 16px panel padding`).toBeCloseTo(entry.gap, 0)
      } else {
        expect(await body.evaluate(element => element.scrollTop)).toBe(0)
      }
      await page.mouse.wheel(0, bodyBox!.height)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      expect(await header.boundingBox()).toEqual(headerBefore)
      expect(await nav.boundingBox()).toEqual(navBefore)
      expect(await page.evaluate(() => ({ top: document.scrollingElement!.scrollTop, left: scrollX, width: document.documentElement.scrollWidth, height: document.scrollingElement!.scrollHeight }))).toEqual(documentBefore)
      expect(await body.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1)
    }
  })

  test('the deepest two levels of the page editor own the frame', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await open(page, `${ORG}/website/pages`)
    await expectPanes(page, ['organization-website', 'organization-pages'])

    // A page's editor opens its first section, so the frame re-roots onto the page.
    await page.locator('#dashboard-panel-organization-pages').getByRole('link', { name: /^Home/ }).click()
    await expect(page).toHaveURL(new RegExp(`${ORG}/website/pages/[^/]+/sections$`))
    await expectPanes(page, ['organization-page', 'organization-page-sections'])

    // A section opens its first field: the section and that field own the frame.
    await page.locator('#dashboard-panel-organization-page-sections a[href*="/sections/"]').first().click()
    await expect(page).toHaveURL(new RegExp(`${ORG}/website/pages/[^/]+/sections/[^/]+/[^/]+$`))
    await expectPanes(page, ['organization-page-block', 'organization-page-block-section'])
  })

  test('Back to an auto-opening index opens its first child again', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await open(page, `${ORG}/integrations`)
    // Integrations is an index of deterministic rows: it opens the first one.
    await expect(page).toHaveURL(`${ORG}/integrations/google-maps`)
    await expectPanes(page, ['organization-integrations', 'integration-google-maps'])

    // Deeper: one location's connection. Google Maps and that location own the frame.
    const location = page.locator('#dashboard-panel-integration-google-maps a[href*="/google-maps/"]').first()
    const locationSlug = (await location.getAttribute('href'))!.split('/').at(-1)!
    await location.click()
    await expect(page).toHaveURL(`${ORG}/integrations/google-maps/${locationSlug}`)
    await expectPanes(page, ['integration-google-maps', `integration-google-maps-${locationSlug}`])

    // In-app Back leads to the bare Integrations index, which must not stay
    // alone at full width: it opens the first row again.
    const back = page.locator('#dashboard-panel-integration-google-maps [data-testid="dashboard-navbar-back"]')
    await expect(back).toHaveAttribute('href', `${ORG}/integrations`)
    await back.click()
    await expect(page).toHaveURL(`${ORG}/integrations/google-maps`)
    await expectPanes(page, ['organization-integrations', 'integration-google-maps'])

    // Payments is one page with Airbnb's tabs, reached from the Earnings cog; Payments is the first tab.
    await open(page, `${ORG}/payments?tab=payouts`)
    await expect(page.getByRole('heading', { name: 'How you get paid', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Plan', exact: true }).click()
    await expect(page).toHaveURL(`${ORG}/payments?tab=plan`)
  })

  test('five organization destinations keep tenant management in Menu', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await open(page, `${ORG}/menu`)
    await expect(page.getByTestId('dashboard-top-nav').getByRole('navigation', { name: 'Dashboard' }).getByRole('link')).toHaveText(['Today', 'Calendar', 'Catalog', 'Messages'])
    await page.getByTestId('dashboard-top-nav-menu-button').click()
    // Earnings is a card on Menu, as Airbnb's is; it shows the month and leads to payouts, transactions and refunds.
    await page.getByRole('dialog', { name: 'Menu', exact: true }).getByTestId('dashboard-menu-earnings').click()
    await expect(page).toHaveURL(`${ORG}/earnings`)
    await expect(page.locator('#dashboard-panel-earnings [data-testid="dashboard-navbar-back"]')).toHaveAttribute('href', `${ORG}/menu`)
    await expect(page.getByRole('heading', { name: 'Earnings', exact: true })).toBeVisible()
    await open(page, `${ORG}/earnings/transactions`)
    await expect(page.getByText('No transactions in this period.', { exact: true })).toBeVisible()
    await open(page, `${ORG}/earnings/refunds`)
    await expect(page.getByText('No refunds yet.', { exact: true })).toBeVisible()
    await expect(page.getByText('No disputes.', { exact: true })).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    await open(page, `${ORG}/earnings`)
    const mobileNav = page.getByTestId('dashboard-mobile-nav')
    await expect(mobileNav.getByRole('link')).toHaveText(['Today', 'Calendar', 'Catalog', 'Messages', 'Menu'])
    await expect(page.getByTestId('dashboard-mobile-nav-menu-link')).toHaveAttribute('aria-current', 'page')
    await page.locator('#dashboard-panel-earnings [data-testid="dashboard-navbar-back"]').click()
    await expect(page).toHaveURL(`${ORG}/menu`)
    await page.locator('#dashboard-panel-organization-settings').getByTestId('dashboard-menu-earnings').click()
    await expect(page).toHaveURL(`${ORG}/earnings`)

    // A service organization has the same five destinations: its services are
    // in Catalog, a root with no Back, and Menu carries no second entry for them.
    const services = '/dashboard/north-carolina-legal-services'
    await open(page, `${services}/menu`)
    await expect(mobileNav.getByRole('link')).toHaveText(['Today', 'Calendar', 'Catalog', 'Messages', 'Menu'])
    await expect(page.locator('#dashboard-panel-organization-settings').getByRole('link', { name: 'Website', exact: true })).toBeVisible()
    await expect(page.locator('#dashboard-panel-organization-settings').getByRole('link', { name: 'Services', exact: true })).toHaveCount(0)
    await mobileNav.getByRole('link', { name: 'Catalog', exact: true }).click()
    await expect(page).toHaveURL(`${services}/products`)
    await expect(mobileNav.getByRole('link', { name: 'Catalog', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('#dashboard-panel-catalog [data-testid="dashboard-navbar-back"]')).toHaveCount(0)
  })

  test('Cedar billing tabs show its actual payment methods and Basic plan', async ({ page, baseURL }) => {
    await page.setViewportSize(PHONE)
    const mobileNav = page.getByTestId('dashboard-mobile-nav')
    // Cedar is an existing fictional Basic business with no billing customer.
    // The copied Ember subscription belongs to LIVE Stripe, not this TEST key.
    expect(['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Cedar owner impersonation is confined to isolated local D1').toBe(true)
    const principalResponse = await page.request.get('/api/auth/get-session')
    expect(principalResponse.status(), await principalResponse.text()).toBe(200)
    const principal = await principalResponse.json() as { user: { id: string; role: string } }
    expect(principal.user.role).toBe('admin')
    const cedarId = '5WebMejsoVLyZLHC29wHH5GbQx1jlvCd'
    const cedarOwnerId = 'ivUlJc9BoyZeFszowpbUEjh1pugcDHiT'
    const cedar = '/dashboard/cedar-legal-demo'
    let impersonated = false
    try {
      const impersonation = await page.request.post('/api/auth/admin/impersonate-user', { headers: authRequestHeaders(baseURL!), data: { userId: cedarOwnerId } })
      expect(impersonation.status(), await impersonation.text()).toBe(200)
      impersonated = true
      expect(await impersonation.json()).toMatchObject({ user: { id: cedarOwnerId }, session: { impersonatedBy: principal.user.id } })
      const activated = await page.request.post('/api/auth/organization/set-active', { headers: authRequestHeaders(baseURL!), data: { organizationId: cedarId } })
      expect(activated.status(), await activated.text()).toBe(200)
      const billingResponse = await page.request.get(`/api/billing/status?organizationId=${cedarId}`)
      expect(billingResponse.status(), await billingResponse.text()).toBe(200)
      const billing = await billingResponse.json()
      expect(billing).toMatchObject({ billing: { plan: 'free', organizationId: cedarId }, userRole: 'owner' })
      expect(billing.billing.stripeCustomerId).toBeUndefined()
      const methods = await page.request.get(`/api/billing/payment-methods?organizationId=${cedarId}`)
      expect(methods.status(), await methods.text()).toBe(200)
      expect(await methods.json()).toEqual({ payment_methods: [] })
      await open(page, `${cedar}/payments`)
      const payments = page.locator('#dashboard-panel-organization-payments')
      await expect(payments.getByRole('heading', { name: 'Payment methods', exact: true })).toBeVisible()
      await expect(payments.getByText('No payment methods saved yet.', { exact: true })).toBeVisible()
      // UAlert renders its message in this slot, including native provider errors.
      await expect(payments.locator('section [data-slot="description"]')).toHaveCount(0)
      await expect(payments.getByTestId('dashboard-navbar-back')).toHaveAttribute('href', `${cedar}/earnings`)
      await expect(mobileNav.getByRole('link')).toHaveText(['Today', 'Calendar', 'Catalog', 'Messages', 'Menu'])

      const planBilling = page.waitForResponse(response => {
        const url = new URL(response.url())
        return url.pathname === '/api/billing/status' && url.searchParams.get('includePrice') === 'true'
      })
      const usageBilling = page.waitForResponse(response => new URL(response.url()).pathname === '/api/dashboard/payments/billing')
      await payments.getByRole('tab', { name: 'Plan', exact: true }).click()
      await expect(page).toHaveURL(`${cedar}/payments?tab=plan`)
      const planResponse = await planBilling
      expect(planResponse.status(), await planResponse.text()).toBe(200)
      const plan = await planResponse.json()
      expect(plan).toMatchObject({ success: true, billing: { plan: 'free', organizationId: cedarId }, userRole: 'owner' })
      expect(plan.billing.stripeSubscriptionId).toBeUndefined()
      expect(plan.billing.subscriptionPrice).toBeUndefined()
      const usageResponse = await usageBilling
      expect(usageResponse.status(), await usageResponse.text()).toBe(200)
      // Basic has no Stripe subscription price: its actual charge is Free.
      await expect(payments.getByText('Basic', { exact: true })).toBeVisible()
      await expect(payments.getByText('Free', { exact: true })).toBeVisible()
      await expect(payments.getByText('Choose a plan', { exact: true })).toBeVisible()
      await expect(payments.locator('[data-slot="description"]')).toHaveCount(0)
    } finally {
      try {
        if (impersonated) {
          const stopped = await page.request.post('/api/auth/admin/stop-impersonating', { headers: authRequestHeaders(baseURL!), data: {} })
          expect(stopped.status(), await stopped.text()).toBe(200)
        }
      } finally {
        const restored = await page.request.post('/api/auth/organization/set-active', { headers: authRequestHeaders(baseURL!), data: { organizationId: 'org-demo' } })
        expect(restored.status(), await restored.text()).toBe(200)
        const sessionResponse = await page.request.get('/api/auth/get-session')
        expect(sessionResponse.status(), await sessionResponse.text()).toBe(200)
        const session = await sessionResponse.json()
        expect(session.user.id).toBe(principal.user.id)
        expect(session.session.activeOrganizationId).toBe('org-demo')
        expect(session.session.impersonatedBy ?? null).toBeNull()
      }
    }
  })

  test('personal navigation keeps owned activity and Updates in its own context', async ({ page, baseURL }) => {
    await page.setViewportSize(PHONE)
    const mobileNav = page.getByTestId('dashboard-mobile-nav')
    try {
      // Personal is a switch in Better Auth, not a URL: with no active organization
      // the account is its own context, with its own tabs.
      const personal = await page.request.post('/api/auth/organization/set-active', { headers: authRequestHeaders(baseURL!), data: { organizationId: null } })
      expect(personal.status(), await personal.text()).toBe(200)
      await open(page, '/account')
      await expect(page).toHaveURL('/dashboard/account')
      await expect(mobileNav.getByRole('link')).toHaveText(['Today', 'Calendar', 'Messages', 'Menu'])
      // Past activity is a card in the account's Menu, as Past trips is on Airbnb's profile; Today owns what is ahead.
      const account = page.waitForResponse(response => new URL(response.url()).pathname === '/api/account' && response.request().method() === 'GET')
      await mobileNav.getByRole('link', { name: 'Menu', exact: true }).click()
      await page.getByTestId('dashboard-menu-past-activity').click()
      await expect(page).toHaveURL('/dashboard/account/activity')
      const response = await account
      expect(response.status(), await response.text()).toBe(200)
      const activity = await response.json()
      expect(isAccountActivityResponse(activity), 'the account API returns actual owned activity').toBe(true)
      if (!isAccountActivityResponse(activity)) throw new Error('Invalid account activity response')
      await expect(page.getByRole('heading', { name: 'Past activity', exact: true })).toBeVisible()
      const past = activity.activities.filter(item => item.kind === 'order' || item.kind === 'payment' || (item.status !== 'cancelled' && item.endsAt !== null && Date.parse(item.endsAt) < Date.now()))
      const cancelled = activity.activities.filter(item => (item.kind === 'booking' || item.kind === 'reservation') && item.status === 'cancelled')
      await expect(page.getByTestId('account-activity-cancelled')).toHaveCount(cancelled.length ? 1 : 0)
      await expect(page.locator('[data-testid^="account-activity-"]:not([data-testid="account-activity-cancelled"])')).toHaveCount(past.length)
      for (const item of past) {
        await expect(page.getByTestId(`account-activity-${item.kind}-${item.id}`)).toContainText(item.title)
      }
      // The copied actor's own history may be empty; never create a purchase to
      // make the dashboard assert its fabricated premise.
      if (past.length) {
        const item = past[0]!
        // A visit and a purchase open the same record screen, on the account's own read.
        const read = await page.request.get(`/api/account/bookings/${item.kind}/${item.id}`)
        expect(read.status(), await read.text()).toBe(200)
        const detail = await read.json()
        expect(isBookingDetailsResponse(detail), 'the account detail API returns the canonical record').toBe(true)
        if (!isBookingDetailsResponse(detail)) throw new Error('Invalid account booking details response')
        const paymentCount = (detail.booking.payments ?? []).length
        await page.getByTestId(`account-activity-${item.kind}-${item.id}`).click()
        await expect(page).toHaveURL(`/dashboard/account/activity/${item.kind}/${item.id}`)
        await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible()
        await expect(page.getByRole('heading', { name: 'Payment info', exact: true })).toHaveCount(paymentCount)
        // The record opens beside Past activity; its own Back returns to that list.
        await page.locator('#dashboard-panel-account-booking-details [data-testid="dashboard-navbar-back"]').click()
        await expect(page).toHaveURL('/dashboard/account/activity')
      } else if (!cancelled.length) {
        await expect(page.getByText('No past activity yet', { exact: true })).toBeVisible()
      }
      await mobileNav.getByRole('link', { name: 'Today', exact: true }).click()
      await expect(page).toHaveURL('/dashboard/account')
      await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
      await mobileNav.getByRole('link', { name: 'Calendar', exact: true }).click()
      await expect(page).toHaveURL('/dashboard/account/calendar')
      await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible()
      await mobileNav.getByRole('link', { name: 'Messages', exact: true }).click()
      await expect(page).toHaveURL('/dashboard/account/messages')
      const personalUpdates = page.waitForResponse(response => new URL(response.url()).pathname === '/api/dashboard/notifications'
        && new URL(response.url()).searchParams.get('scope') === 'personal')
      await page.getByRole('button', { name: 'All, filter by message type' }).click()
      await page.getByRole('menuitemcheckbox', { name: 'Updates', exact: true }).click()
      const updatesResponse = await personalUpdates
      expect(updatesResponse.status(), await updatesResponse.text()).toBe(200)
      const updates = await updatesResponse.json() as { notifications: Array<{ id: string; scope: string; title: string | null; target_user_id: string | null }> }
      const viewer = await (await page.request.get('/api/auth/get-session')).json() as { user: { id: string } }
      // Personal Updates are platform notifications addressed to this account, or to everyone; never a business's.
      expect(updates.notifications.every(item => item.scope === 'global' && (item.target_user_id === viewer.user.id || item.target_user_id === null)), 'personal Updates carry only this account\'s notifications').toBe(true)
      await expect(page).toHaveURL('/dashboard/account/messages?view=updates')
      if (updates.notifications.length) {
        for (const item of updates.notifications) {
          const row = page.getByTestId(`notification-${item.id}`)
          await expect(row).toBeVisible()
          if (item.title) await expect(row).toContainText(item.title)
        }
      } else {
        await expect(page.getByText('No updates yet.', { exact: true })).toBeVisible()
      }
      await expect(mobileNav.getByRole('link')).toHaveText(['Today', 'Calendar', 'Messages', 'Menu'])
      await page.setViewportSize(WIDE)
      await expect(page.getByTestId('dashboard-top-nav').getByRole('navigation', { name: 'Dashboard' }).getByRole('link')).toHaveText(['Today', 'Calendar', 'Messages'])
    } finally {
      const restored = await page.request.post('/api/auth/organization/set-active', { headers: authRequestHeaders(baseURL!), data: { organizationId: 'org-demo' } })
      expect(restored.status(), await restored.text()).toBe(200)
      const restoredSession = await page.request.get('/api/auth/get-session')
      expect(restoredSession.status(), await restoredSession.text()).toBe(200)
      expect((await restoredSession.json()).session.activeOrganizationId).toBe('org-demo')
    }
  })

  test('booking Change opens its first field on desktop and not below lg', async ({ page }) => {
    const agenda = await page.request.get('/api/dashboard/agenda', { params: { org: 'ember-slice-demo', from: '2000-01-01', to: '2100-01-01' } })
    expect(agenda.status()).toBe(200)
    const { items } = await agenda.json() as { items: Array<{ kind: string; to: string }> }
    const reservation = items.find(item => item.kind === 'reservation' && item.to.includes('/bookings/'))
    expect(reservation, 'the demo fixture carries a reservation').toBeTruthy()
    const change = `${reservation!.to}/change`

    await page.setViewportSize(WIDE)
    await open(page, change)
    // A reservation's Location row is the first row on the screen.
    await expect(page).toHaveURL(`${change}/location`)
    await expectPanes(page, ['booking-change', 'booking-change-field'])

    await page.setViewportSize(NARROW)
    await open(page, change)
    await expectPanes(page, ['booking-change'])
    await expect(page).toHaveURL(change)
  })

  test('a booking opened from the calendar goes Back to its day, and from Today to Today', async ({ page }) => {
    const agenda = await page.request.get('/api/dashboard/agenda', { params: { org: 'ember-slice-demo', from: '2000-01-01', to: '2100-01-01' } })
    expect(agenda.status()).toBe(200)
    const { items } = await agenda.json() as { items: Array<{ kind: string; dayKey: string; to: string }> }
    const reservation = items.find(item => item.kind === 'reservation' && item.to.includes('/bookings/'))
    expect(reservation, 'the demo fixture carries a reservation').toBeTruthy()
    const day = `${ORG}/calendar/${reservation!.dayKey}`
    const fromCalendar = `${day}/reservation/${reservation!.to.split('/').at(-1)}`

    // The same record, mounted under the day: Back is the day and Calendar is the lit tab.
    await page.setViewportSize(NARROW)
    await open(page, fromCalendar)
    await expectPanes(page, ['booking-details'])
    const back = page.locator('#dashboard-panel-booking-details [data-testid="dashboard-navbar-back"]')
    await expect(back).toHaveAttribute('href', day)
    await expect(page.locator('[aria-current="page"]', { hasText: 'Calendar' }).first()).toBeVisible()
    await expect(page.locator('[aria-current="page"]', { hasText: 'Today' })).toHaveCount(0)
    await back.click()
    await expect(page).toHaveURL(day)
    await expectPanes(page, ['calendar-day'])

    await open(page, reservation!.to)
    await expect(page.locator('#dashboard-panel-booking-details [data-testid="dashboard-navbar-back"]')).toHaveAttribute('href', ORG)
    await expect(page.locator('[aria-current="page"]', { hasText: 'Today' }).first()).toBeVisible()
  })

  test('Calendar can filter by a team member and return to all assigned people', async ({ page }) => {
    const membersResponse = await page.request.get('/api/organizations/org-demo/members/scheduling')
    expect(membersResponse.status()).toBe(200)
    const { members } = await membersResponse.json() as { members: Array<{ id: string; name: string }> }
    expect(members.length).toBeGreaterThan(0)
    const member = members[0]!
    await open(page, `${ORG}/calendar`)
    // The selects sit behind the one Filters control, as Airbnb keeps them.
    await page.getByRole('button', { name: 'Filter bookings', exact: true }).click()
    const filter = page.getByRole('combobox', { name: 'Assigned person' })
    await expect(filter).toContainText('All assigned people')
    await filter.click()
    await expect(page.getByRole('option', { name: 'All assigned people', exact: true })).toBeVisible()
    const filtered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/dashboard/agenda'
      && new URL(response.url()).searchParams.get('assigned_member_id') === member.id)
    await page.getByRole('option', { name: member.name, exact: true }).first().click()
    expect((await filtered).status()).toBe(200)
    await expect(filter).toContainText(member.name)
    await filter.click()
    const unfiltered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/dashboard/agenda'
      && !new URL(response.url()).searchParams.has('assigned_member_id'))
    await page.getByRole('option', { name: 'All assigned people', exact: true }).click()
    expect((await unfiltered).status()).toBe(200)
    await expect(filter).toContainText('All assigned people')
  })

  test('below lg indexes show one screen and choose no child', async ({ page }) => {
    await page.setViewportSize(NARROW)
    for (const [path, pane] of [['website', 'organization-website'], ['website/pages', 'organization-pages'], ['website/brand', 'organization-brand'], ['products', 'catalog'], ['integrations', 'organization-integrations']] as const) {
      await open(page, `${ORG}/${path}`)
      await expectPanes(page, [pane])
      await expect(page).toHaveURL(`${ORG}/${path}`)
    }
  })

  test('mobile leaf drawers retain their parent and discard drafts on every dismissal', async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    const links = `${ORG}/website/pages/links`
    const endpoint = '/api/editor/organizations/org-demo/links-page'
    const beforeResponse = await page.request.get(endpoint)
    expect(beforeResponse.status(), await beforeResponse.text()).toBe(200)
    const before = await beforeResponse.json() as { page: { title: string }; items: unknown[] }
    expect(before.page.title).not.toBe('')
    const writes: string[] = []
    page.on('request', request => {
      if (new URL(request.url()).pathname === endpoint && request.method() !== 'GET') writes.push(request.method())
    })
    const parent = page.locator('#dashboard-panel-organization-links')
    const leaf = page.locator('#dashboard-panel-organization-links-title')
    const dialog = page.getByRole('dialog', { name: 'Title', exact: true })
    const input = leaf.getByRole('textbox', { name: 'Links page title', exact: true })

    for (const viewport of [PHONE, NARROW]) {
      await page.setViewportSize(viewport)
      await open(page, links)
      for (const dismissal of ['Close', 'Cancel', 'Escape', 'backdrop', 'swipe'] as const) {
        const parentBefore = await parent.boundingBox()
        expect(parentBefore).not.toBeNull()
        await parent.getByRole('link', { name: /^Title/ }).click()
        await expect(page).toHaveURL(`${links}/title`)
        await expect(dialog).toBeVisible()
        await expect(parent).toBeVisible()
        expect((await parent.boundingBox())!.height).toBeCloseTo(parentBefore!.height, 1)
        await expect(leaf).toHaveCount(1)
        await expect(input).toHaveValue(before.page.title)
        await expect.poll(async () => {
          const parentBox = await parent.boundingBox()
          const drawerBox = await dialog.boundingBox()
          return parentBox !== null && drawerBox !== null
            && drawerBox.y > parentBox.y
            && drawerBox.y + drawerBox.height <= viewport.height + 1
        }, { message: 'A strip of the real parent remains visible above the bottom drawer' }).toBe(true)
        const save = leaf.getByRole('button', { name: 'Save', exact: true })
        await expect(save).toBeInViewport()
        await input.fill(`Discarded ${dismissal} draft`)
        if (dismissal === 'Close') {
          await input.focus()
          for (let at = 0; at < 5; at += 1) {
            await page.keyboard.press('Tab')
            await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement)), {
              message: 'Keyboard focus stays in the modal drawer',
            }).toBe(true)
          }
        }
        if (dismissal === 'Close') {
          await page.screenshot({ path: testInfo.outputPath(`leaf-drawer-${viewport.width}.png`), fullPage: true })
          await leaf.getByTestId('dashboard-navbar-close').click()
        } else if (dismissal === 'Cancel') {
          await leaf.getByRole('button', { name: 'Cancel', exact: true }).click()
        } else if (dismissal === 'Escape') {
          await page.keyboard.press('Escape')
        } else if (dismissal === 'backdrop') {
          const overlay = page.locator('[data-slot="overlay"][data-state="open"]')
          await expect(overlay).toHaveCount(1)
          const parentBox = (await parent.boundingBox())!
          await overlay.click({ position: { x: 8, y: parentBox.y + 4 } })
        } else {
          const handleLocator = dialog.locator('[data-slot="handle"]')
          await handleLocator.hover()
          const handle = await handleLocator.boundingBox()
          expect(handle, 'The native drawer has a drag handle').not.toBeNull()
          const receivesPointer = await handleLocator.evaluate(element => {
            const rect = element.getBoundingClientRect()
            return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
          })
          expect(receivesPointer, 'The drag handle receives pointer input').toBe(true)
          const beforeDrag = await dialog.boundingBox()
          await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
          await page.mouse.down()
          try {
            await page.mouse.move(handle!.x + handle!.width / 2, Math.min(viewport.height - 4, handle!.y + handle!.height / 2 + 32), { steps: 3 })
            await expect.poll(async () => (await dialog.boundingBox())?.y, { message: 'The drawer follows the drag' }).toBeGreaterThan(beforeDrag!.y + 1)
            await page.mouse.move(viewport.width / 2, viewport.height - 4, { steps: 8 })
          } finally {
            await page.mouse.up()
          }
        }
        await expect(page).toHaveURL(links)
        await expect(leaf).toHaveCount(0)
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expectPanes(page, ['organization-links'])
        await expect(parent.getByRole('link', { name: /^Title/ })).toContainText(before.page.title)
        if (viewport.width < 768) await expect(page.getByTestId('dashboard-mobile-nav')).toBeVisible()
      }
    }
    expect(writes).toEqual([])
    const afterResponse = await page.request.get(endpoint)
    expect(afterResponse.status(), await afterResponse.text()).toBe(200)
    const after = await afterResponse.json() as typeof before
    expect(after.page.title).toBe(before.page.title)
    expect(after.items).toEqual(before.items)
  })

  test('a photo library dialog stays above its leaf drawer and Escape dismisses only the top level', async ({ page }, testInfo) => {
    const endpoint = '/api/editor/organizations/org-demo/products'
    const productsRead = await page.request.get(endpoint)
    expect(productsRead.status(), await productsRead.text()).toBe(200)
    const product = (await productsRead.json() as { products: Product[] }).products.find(row => row.kind === 'dish' && row.image)
    expect(product, 'The demo contains a dish with an existing photo').toBeDefined()
    const parentPath = `${ORG}/products/${product!.id}`
    const leafPath = `${parentPath}/photo`
    const writes: string[] = []
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/editor/organizations/org-demo/') && request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    })
    await page.setViewportSize(PHONE)
    await open(page, leafPath)
    const outer = page.getByRole('dialog', { name: 'Photo', exact: true })
    const leaf = page.locator('#dashboard-panel-product-photo')
    await expect(outer).toBeVisible()
    await expect(leaf.getByTestId('product-photo').locator('img')).toHaveAttribute('src', product!.image!.public_url)
    const libraryRead = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/editor/organizations/org-demo/media' && url.searchParams.get('limit') === '100'
    })
    await leaf.getByTestId('product-photo').click()
    const library = await libraryRead
    expect(library.status(), await library.text()).toBe(200)
    expect((await library.json() as { media: unknown[] }).media.length).toBeGreaterThan(0)
    const picker = page.getByRole('dialog', { name: 'Dish photo', exact: true })
    await expect(picker).toBeVisible()
    await expect(page.getByRole('dialog', { includeHidden: true })).toHaveCount(2)
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(picker.getByRole('button', { name: 'Done', exact: true })).toBeDisabled()
    const cancel = picker.getByRole('button', { name: 'Cancel', exact: true })
    await expect.poll(() => cancel.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    }), { message: 'The inner media dialog is above the drawer and receives pointer input' }).toBe(true)
    await cancel.focus()
    for (let at = 0; at < 5; at += 1) {
      await page.keyboard.press('Tab')
      await expect.poll(() => picker.evaluate(element => element.contains(document.activeElement))).toBe(true)
    }
    await page.screenshot({ path: testInfo.outputPath('nested-photo-picker-mobile.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    await expect(outer).toBeVisible()
    await expect(page).toHaveURL(leafPath)
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(parentPath)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const parent = page.locator('#dashboard-panel-product')
    await expect(parent.getByRole('heading', { level: 1, name: product!.name, exact: true })).toBeFocused()
    expect(writes).toEqual([])
    const afterRead = await page.request.get(`${endpoint}/${product!.id}`)
    expect(afterRead.status(), await afterRead.text()).toBe(200)
    expect((await afterRead.json() as { product: Product }).product.image?.asset_id).toBe(product!.image!.asset_id)
  })

  test('a timezone menu scrolls above its leaf and preserves its draft until the drawer is dismissed', async ({ page }, testInfo) => {
    const locationsRead = await page.request.get('/api/dashboard/locations', { params: { org: 'ember-slice-demo', organization: 'true' } })
    expect(locationsRead.status(), await locationsRead.text()).toBe(200)
    const location = (await locationsRead.json() as { locations: DashboardLocation[] }).locations.find(row => row.id === 'loc-demo')
    expect(location, 'The demo carries its existing location and timezone').toBeDefined()
    const parentPath = `${ORG}/locations/${location!.slug}/hours`
    const leafPath = `${parentPath}/timezone`
    const endpoint = `/api/dashboard/locations/${location!.id}`
    const writes: string[] = []
    page.on('request', request => {
      if (new URL(request.url()).pathname === endpoint && request.method() !== 'GET') writes.push(request.method())
    })
    await page.setViewportSize(PHONE)
    await open(page, leafPath)
    const outer = page.getByRole('dialog', { name: 'Timezone', exact: true })
    const control = outer.getByRole('button', { name: 'Time zone', exact: true })
    await expect(control).toContainText(timezoneLabel(location!.timezone))
    await control.click()
    const menu = page.getByRole('listbox')
    await expect(menu).toBeVisible()
    const viewport = menu.locator('[data-slot="viewport"]')
    await expect.poll(() => viewport.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    const initialScroll = await viewport.evaluate(element => element.scrollTop)
    const documentScroll = await page.evaluate(() => document.scrollingElement?.scrollTop)
    await viewport.hover()
    await page.mouse.wheel(0, initialScroll > 0 ? -240 : 240)
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).not.toBe(initialScroll)
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(documentScroll)
    const search = page.getByPlaceholder('Search by city, e.g. Bangkok')
    await expect.poll(() => search.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    }), { message: 'The nested timezone search receives pointer input above the drawer' }).toBe(true)
    const target = location!.timezone === 'Asia/Bangkok' ? 'Europe/London' : 'Asia/Bangkok'
    await search.fill(target === 'Asia/Bangkok' ? 'Bangkok' : 'London')
    await page.getByRole('option', { name: timezoneLabel(target), exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect(control).toContainText(timezoneLabel(target))
    await expect(outer.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await control.click()
    await expect(menu).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('nested-timezone-picker-mobile.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(outer).toBeVisible()
    await expect(control).toContainText(timezoneLabel(target))
    await expect(page).toHaveURL(leafPath)
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(parentPath)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(writes).toEqual([])
    const persisted = await page.request.get(endpoint, { params: { org: 'ember-slice-demo' } })
    expect(persisted.status(), await persisted.text()).toBe(200)
    expect((await persisted.json() as { location: { timezone: string } }).location.timezone).toBe(location!.timezone)
  })

  test('a leaf URL reloads its drawer and resizing keeps one editor with its draft', async ({ page }) => {
    const links = `${ORG}/website/pages/links`
    const query = '?location_id=loc-demo'
    const leafUrl = `${links}/title${query}`
    const parent = page.locator('#dashboard-panel-organization-links')
    const leaf = page.locator('#dashboard-panel-organization-links-title')
    const dialog = page.getByRole('dialog', { name: 'Title', exact: true })
    const input = page.getByRole('textbox', { name: 'Links page title', exact: true })
    await page.setViewportSize(PHONE)
    await open(page, leafUrl)
    await expect(dialog).toBeVisible()
    await expect(parent).toBeVisible()
    await expect(input).toHaveCount(1)
    const savedTitle = await input.inputValue()
    await page.reload()
    await waitForNuxtHydration(page)
    await expect(page).toHaveURL(leafUrl)
    await expect(dialog).toBeVisible()
    await expect(parent).toBeVisible()
    await expect(input).toHaveValue(savedTitle)
    const draft = `${savedTitle} unsaved resize`
    await input.fill(draft)

    await page.setViewportSize(WIDE)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expectPanes(page, ['organization-links', 'organization-links-title'])
    await expect(input).toHaveCount(1)
    await expect(input).toHaveValue(draft)
    await expect(leaf).toHaveCount(1)
    await expect(leaf.getByTestId('dashboard-navbar-close')).not.toBeVisible()
    await expect(leaf.getByRole('button', { name: 'Cancel', exact: true })).not.toBeVisible()
    await expect(leaf.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(1)
    const parentBox = await parent.boundingBox()
    const leafBox = await leaf.boundingBox()
    expect(parentBox).not.toBeNull()
    expect(leafBox).not.toBeNull()
    expect(leafBox!.x).toBeGreaterThanOrEqual(parentBox!.x + parentBox!.width - 1)

    for (const viewport of [NARROW, PHONE]) {
      await page.setViewportSize(viewport)
      await expect(dialog).toBeVisible()
      await expect(parent).toBeVisible()
      await expect(leaf).toHaveCount(1)
      await expect(input).toHaveCount(1)
      await expect(input).toHaveValue(draft)
      await expect(leaf.getByRole('button', { name: 'Save', exact: true })).toBeInViewport()
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(1)
      await expect(page).toHaveURL(leafUrl)
    }
    await expect(leaf.getByTestId('dashboard-navbar-close')).toHaveAttribute('href', `${links}${query}`)
    await leaf.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`${links}${query}`)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expectPanes(page, ['organization-links'])
    await expect(parent.getByRole('link', { name: /^Title/ })).toContainText(savedTitle)
  })

  // A service is a Product and the page that shows it: Catalog's Add opens the
  // shared create walk, and Create writes both, bound, through one request.
  test('Catalog adds a service with its page through the one Product editor', async ({ page, baseURL }) => {
    const services = '/dashboard/north-carolina-legal-services'
    const editor = '/api/editor/organizations/org-ncls-blawby'
    await page.setViewportSize(WIDE)
    await page.context().clearCookies()
    await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
    await open(page, `${services}/products`)
    await expectPanes(page, ['catalog'])
    await page.locator('#dashboard-panel-catalog').getByTestId('catalog-add').click()
    await expect(page).toHaveURL(`${services}/products/new/kind`)
    const kind = page.locator('#dashboard-panel-product-kind')
    await kind.getByRole('radio', { name: 'Service or appointment', exact: true }).check()
    await kind.getByRole('button', { name: 'Next: Name', exact: true }).click()
    await expect(page).toHaveURL(`${services}/products/new/name`)
    const name = `E2E Service ${Date.now().toString(36)}`
    await page.getByRole('textbox', { name: 'Name' }).fill(name)
    const created = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/products` && response.request().method() === 'POST')
    // The walk's index and its Name leaf both offer the commit; the leaf's is the one beside the field.
    await page.locator('#dashboard-panel-product-name').getByRole('button', { name: 'Create service', exact: true }).click()
    const response = await created
    expect(response.status(), await response.text()).toBe(201)
    const request = response.request().postDataJSON() as { idempotency_key?: string }
    expect(request.idempotency_key).toBeTruthy()
    const productId = (await response.json() as { product: { id: string } }).product.id
    let pageId: string | null = null
    try {
      await expect(page).toHaveURL(`${services}/products/${productId}/price`)
      await expectPanes(page, ['product', 'product-price'])
      // Read back through other paths than the one that wrote it.
      const product = (await (await page.request.get(`${editor}/products/${productId}`)).json() as { product: { kind: string; active: boolean; name: string; variants: unknown[]; publications: Array<{ published: boolean }>; booking: unknown; page: { id: string; path: string; title: string } | null } }).product
      expect(product).toMatchObject({ kind: 'service', active: false, name, publications: [{ published: false }], booking: null })
      expect(product.variants).toHaveLength(1)
      expect(product.page).toMatchObject({ title: name })
      expect(product.page?.path).toMatch(/^\/services\/e2e-service-/)
      pageId = product.page!.id
      const bound = (await (await page.request.get(`${editor}/pages/${pageId}`)).json() as { page: { product_id: string | null } }).page
      expect(bound.product_id).toBe(productId)
      await page.locator('#dashboard-panel-product').getByTestId('dashboard-navbar-back').click()
      await expect(page).toHaveURL(`${services}/products`)
      await expectPanes(page, ['catalog'])
      const catalogService = page.getByTestId('catalog-grid').getByTestId(`selector-item-${productId}`)
      await expect(catalogService).toHaveAttribute('href', `${services}/products/${productId}`)
      await expect(catalogService).toContainText(name)
      await expect(catalogService).toContainText('No photo')
      await expect(catalogService).toContainText('No price set')
      await expect(catalogService).toContainText('No locations set')
      // MCP reads the same pair, and the editor URL it hands an agent opens this record.
      const viaMcp = mcpData<{ product: { page: { id: string; path: string } | null; admin_edit_url: string | null } }>(await (await mcpRequest(page.request, baseURL!, {
        method: 'tools/call', toolName: 'get_product', args: { organization_id: 'org-ncls-blawby', product_id: productId },
      })).json()).product
      expect(viaMcp.page).toMatchObject({ id: pageId, path: product.page!.path })
      expect(viaMcp.admin_edit_url).toBe(`${services}/products/${productId}`)
      await open(page, viaMcp.admin_edit_url!)
      await expect(page.locator('#dashboard-panel-product')).toContainText(name)

      // Its Page content row opens the page in Pages, the one page editor.
      await page.locator('#dashboard-panel-product').getByRole('link', { name: new RegExp(`^Page content ${product.page!.path.replaceAll('/', '\\/')}`) }).click()
      await expect(page).toHaveURL(new RegExp(`${services}/website/pages/${pageId}`))
      await expect(page.locator('#dashboard-panel-organization-page')).toContainText(name)
    } finally {
      if (pageId) {
        const current = (await (await page.request.get(`${editor}/pages/${pageId}`)).json() as { page: { document: { updated_at: string } } }).page
        const removedPage = await page.request.delete(`${editor}/pages/${pageId}`, { data: { expectedUpdatedAt: current.document.updated_at } })
        expect(removedPage.status(), await removedPage.text()).toBe(200)
      }
      const removed = await page.request.delete(`${editor}/products/${productId}`)
      expect(removed.status(), await removed.text()).toBe(200)
    }
  })

  // KrabiClaw runs on KrabiClaw: the row and its page exist only inside
  // KrabiClaw's own organization, and only for a Better Auth admin.
  test('Platform accounts opens only inside KrabiClaw, and only for a Better Auth admin', async ({ page, baseURL, playwright }) => {
    const services = '/dashboard/north-carolina-legal-services'
    const krabiclaw = '/dashboard/platform'
    const menu = page.locator('#dashboard-panel-organization-settings')
    const admin = await playwright.request.newContext({ baseURL })
    const setRole = async (role: 'admin' | 'user') => {
      const response = await admin.post('/api/auth/admin/set-role', { headers: authRequestHeaders(baseURL!), data: { userId: 'user-e2e-ncls-owner', role } })
      expect(response.status(), await response.text()).toBe(200)
    }
    const expectNoPlatformAccounts = async () => {
      await open(page, `${services}/menu`)
      await expect(menu.getByRole('link', { name: 'Team', exact: true })).toBeVisible()
      await expect(menu.getByRole('link', { name: 'Platform accounts', exact: true })).toHaveCount(0)
      await page.goto(`${services}/platform-accounts`)
      await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toBeVisible()
    }
    let elevated = false
    try {
      await page.setViewportSize(WIDE)
      await page.context().clearCookies()
      await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
      await expectNoPlatformAccounts()
      // The screen's own reads stay Better Auth's to refuse.
      expect((await page.request.get('/api/auth/admin/list-users')).status()).toBe(403)

      // A Better Auth admin in a customer's organization still has no such row or page.
      await loginAs(admin, baseURL!, 'user-e2e-platform-admin')
      await setRole('admin')
      elevated = true
      await page.context().clearCookies()
      await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
      await expectNoPlatformAccounts()

      // KrabiClaw's own organization, opened by its owner, who is a Better Auth admin.
      await page.context().clearCookies()
      await loginAs(page.request, baseURL!)
      const signedIn = await (await page.request.get('/api/auth/get-session')).json() as { user: { role?: string | null } }
      expect(signedIn.user.role, 'the canary account is a Better Auth admin').toBe('admin')
      await open(page, `${krabiclaw}/menu`)
      await expect(menu.getByRole('link', { name: 'Platform accounts', exact: true })).toHaveAttribute('href', `${krabiclaw}/platform-accounts`)
    } finally {
      if (elevated) await setRole('user')
      await admin.dispose()
    }
  })

  // Account settings carries no organization in its URL. Better Auth's active
  // organization keeps the shell in it, and a member's own availability —
  // where Google Calendar connects — is that organization's page.
  test('Account settings keeps the active organization\'s shell', async ({ page, baseURL }) => {
    const services = '/dashboard/north-carolina-legal-services'
    const availability = '/dashboard/account/profile/calendar/org-ncls-blawby'
    await page.context().clearCookies()
    await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
    const activated = await page.request.post('/api/auth/organization/set-active', { headers: authRequestHeaders(baseURL!), data: { organizationId: 'org-ncls-blawby' } })
    expect(activated.status(), await activated.text()).toBe(200)
    await page.setViewportSize({ width: 390, height: 844 })

    await open(page, '/dashboard/account/profile')
    // A lawyer in their firm is still in it on their own settings: the firm's
    // tabs, its Menu lit, and Back to its Menu. Personal is a switch, not a URL.
    const mobileNav = page.getByTestId('dashboard-mobile-nav')
    await expect(mobileNav.getByRole('link')).toHaveText(['Today', 'Calendar', 'Catalog', 'Messages', 'Menu'])
    await expect(mobileNav.getByRole('link', { name: 'Calendar', exact: true })).toHaveAttribute('href', `${services}/calendar`)
    await expect(page.getByTestId('dashboard-mobile-nav-menu-link')).toHaveAttribute('href', `${services}/menu`)
    await expect(page.getByTestId('dashboard-mobile-nav-menu-link')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('#dashboard-panel-account-profile [data-testid="dashboard-navbar-back"]')).toHaveAttribute('href', `${services}/menu`)
    // Opening it changed nothing in Better Auth: availability opens the active organization's own page.
    const session = await page.request.get('/api/auth/get-session', { headers: authRequestHeaders(baseURL!) })
    expect((await session.json() as { session: { activeOrganizationId: string | null } }).session.activeOrganizationId).toBe('org-ncls-blawby')
    await page.getByRole('link', { name: /^Your availability/ }).click()
    await expect(page).toHaveURL(availability)
    await expect(page.getByRole('link', { name: /^Google Calendar/ })).toBeVisible()

    // On the team, your own row opens the same page; the admin view is for everyone else.
    await open(page, `${services}/team`)
    const ownRow = page.getByRole('listitem').filter({ hasText: 'ncls-owner@playwright.example' })
    await expect(ownRow.getByRole('link', { name: 'Profile, hours & Calendar', exact: true })).toHaveAttribute('href', availability)
  })

  // Choosing, opening and deleting an organization are the account's; the
  // organization's own Website has no delete row.
  test('Account settings → Organizations deletes exactly the organization it names', async ({ page, baseURL }) => {
    await page.setViewportSize(WIDE)
    await page.context().clearCookies()
    await loginAs(page.request, baseURL!, 'user-e2e-onboarding-wizard')
    const discarded = await page.request.delete('/api/dashboard/onboarding/drafts/active')
    expect(discarded.status(), await discarded.text()).toBe(200)
    const name = `E2E Organization ${Date.now().toString(36)}`
    const draft = await page.request.post('/api/dashboard/onboarding/drafts/active', {
      data: { sourceType: 'manual', vertical: 'restaurant', name, details: { sourceLocale: 'en', country: 'TH', city: 'Ao Nang', streetAddress: '88 Moo 2', currency: 'THB', timezone: 'Asia/Bangkok' } },
    })
    expect(draft.status(), await draft.text()).toBe(200)
    const { organizationId } = await draft.json() as { organizationId: string }
    const listed = async () => (await (await page.request.get('/api/auth/organization/list')).json() as Array<{ id: string }>).map(organization => organization.id)
    try {
      // Deleting is the list's edit state, on the rows Better Auth lets this account delete.
      await open(page, '/dashboard/account/profile/organizations')
      await page.getByTestId('list-editor-toggle').click()
      await page.getByRole('button', { name: `Remove ${name}`, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/dashboard/account/profile/organizations/${organizationId}/delete$`))
      const confirm = page.getByRole('button', { name: 'Delete permanently', exact: true })
      await expect(confirm).toBeDisabled()
      await page.getByPlaceholder('DELETE').fill('DELETE')
      await confirm.click()
      await expect(page).toHaveURL(/\/dashboard\/account\/profile\/organizations$/)
      await expect(page.getByTestId(`account-organization-${organizationId}`)).toHaveCount(0)
      expect(await listed()).not.toContain(organizationId)

      // An organization this account is not in cannot be deleted from here: Better Auth says why.
      await page.goto(`/dashboard/account/profile/organizations/${organizationId}/delete`)
      await expect(page.getByText('User is not a member of the organization', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Delete permanently', exact: true })).toBeDisabled()
    } finally {
      if ((await listed()).includes(organizationId)) {
        const removed = await page.request.post('/api/auth/organization/delete', { headers: authRequestHeaders(baseURL!), data: { organizationId } })
        expect(removed.status(), await removed.text()).toBe(200)
      }
    }
  })
})
