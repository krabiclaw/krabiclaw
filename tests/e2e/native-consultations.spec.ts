import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { openTenantPage, waitForNuxtHydration } from './helpers'
import { mcpData, mcpRequest } from './helpers/mcp'
import { blawbyTestExtraHeaders } from './test-env'
import type { Product } from '../../server/types/products'
import type { PublicTenantPage } from '../../server/utils/public-tenant-pages'
import type { PublicShellPayload } from '../../utils/public-resource-contracts'

test.use({ timezoneId: 'America/New_York' })

let consultationRestore: {
  cleanupRequest: APIRequestContext
  actorRequest: APIRequestContext
  baseURL: string
  organizationId: string
  serviceId: string
  originalProductId: string | null
  previousMode: string
  memberId: string
  memberUserId: string
  memberEmail: string
  memberRole: string
  products: Product[]
} | null = null

test.afterEach(async ({ page }) => {
  const restore = consultationRestore
  consultationRestore = null
  if (!restore) return
  const { cleanupRequest, organizationId: org, products } = restore
  const editor = `/api/editor/organizations/${org}`
  const failures: unknown[] = []
  try {
    if (!page.isClosed()) await page.close()
  } catch (error) { failures.push(error) }
  try {
    const currentResponse = await cleanupRequest.get(`${editor}/pages/${restore.serviceId}`)
    expect(currentResponse.status(), await currentResponse.text()).toBe(200)
    const current = (await currentResponse.json()).page
    const binding = await cleanupRequest.patch(`${editor}/pages/${restore.serviceId}`, { data: { path: current.path, title: current.title, summary: current.summary, pageType: current.page_type, recipe: current.recipe, sortOrder: current.sort_order, blocks: current.blocks, expectedUpdatedAt: current.document.updated_at, productId: restore.originalProductId } })
    expect(binding.status(), await binding.text()).toBe(200)
    expect((await binding.json()).page.product_id).toBe(restore.originalProductId)
    const restoredPage = await cleanupRequest.get(`${editor}/pages/${restore.serviceId}`)
    expect(restoredPage.status(), await restoredPage.text()).toBe(200)
    expect((await restoredPage.json()).page.product_id).toBe(restore.originalProductId)
  } catch (error) { failures.push(error) }
  try {
    const restoredMode = await cleanupRequest.put(`${editor}/consultation`, { data: { mode: restore.previousMode } })
    expect(restoredMode.status(), await restoredMode.text()).toBe(200)
    const restoredSettings = await cleanupRequest.get(`${editor}/consultation`)
    expect(restoredSettings.status()).toBe(200)
    expect((await restoredSettings.json()).mode).toBe(restore.previousMode)
  } catch (error) { failures.push(error) }
  for (const product of products) {
    try {
      const unpublished = await cleanupRequest.put(`${editor}/products/${product.id}/publication`, { data: { published: false } })
      expect(unpublished.status(), await unpublished.text()).toBe(200)
      const publication = await cleanupRequest.get(`${editor}/products/${product.id}`)
      expect(publication.status()).toBe(200)
      expect((await publication.json()).product.publications).toContainEqual({ organization_id: org, published: false })
      const deleted = await cleanupRequest.delete(`${editor}/products/${product.id}`)
      if (deleted.status() === 200) continue
      // Canonical Product deletion preserves booked history, even when cancelled.
      expect(deleted.status(), await deleted.text()).toBe(409)
      // No longer held online, it stops taking new times from the provider's hours.
      const archivedBooking = await cleanupRequest.put(`${editor}/products/${product.id}/booking`, { data: { duration_minutes: 45, default_capacity: 1, held_online: false } })
      expect(archivedBooking.status(), await archivedBooking.text()).toBe(200)
      const deactivated = await cleanupRequest.patch(`${editor}/products/${product.id}`, { data: { active: false } })
      expect(deactivated.status(), await deactivated.text()).toBe(200)
      const archived = await cleanupRequest.get(`${editor}/products/${product.id}`)
      expect(archived.status()).toBe(200)
      expect((await archived.json()).product).toMatchObject({ active: false, booking: { held_online: false } })
    } catch (error) { failures.push(error) }
  }
  try {
    const removedMember = await cleanupRequest.post('/api/auth/organization/remove-member', { headers: authRequestHeaders(restore.baseURL), data: { organizationId: org, memberIdOrEmail: restore.memberId } })
    expect(removedMember.status(), await removedMember.text()).toBe(200)
    const remainingMembers = await cleanupRequest.get(`/api/organizations/${org}/members/scheduling`)
    expect(remainingMembers.status(), await remainingMembers.text()).toBe(200)
    expect((await remainingMembers.json()).members.some((member: { id: string }) => member.id === restore.memberId)).toBe(false)
    const removedScheduling = await cleanupRequest.get(`/api/organizations/${org}/members/${restore.memberId}/scheduling`)
    expect(removedScheduling.status(), await removedScheduling.text()).toBe(404)
    // Membership removal clears the temporary schedule. Restore the original
    // actor through Better Auth before any later journey uses it.
    const invitation = await cleanupRequest.post('/api/auth/organization/invite-member', { headers: authRequestHeaders(restore.baseURL), data: { organizationId: org, email: restore.memberEmail, role: restore.memberRole, resend: true } })
    expect(invitation.status(), await invitation.text()).toBe(200)
    const accepted = await restore.actorRequest.post('/api/auth/organization/accept-invitation', { headers: authRequestHeaders(restore.baseURL), data: { invitationId: (await invitation.json()).id } })
    expect(accepted.status(), await accepted.text()).toBe(200)
    const restoredMembers = await cleanupRequest.get('/api/auth/organization/list-members', { params: { organizationId: org } })
    expect(restoredMembers.status(), await restoredMembers.text()).toBe(200)
    const restoredMember = (await restoredMembers.json()).members.find((member: { userId: string }) => member.userId === restore.memberUserId)
    expect(restoredMember).toMatchObject({ organizationId: org, userId: restore.memberUserId, role: restore.memberRole })
    const restoredScheduling = await cleanupRequest.get(`/api/organizations/${org}/members/${restoredMember.id}/scheduling`)
    expect(restoredScheduling.status(), await restoredScheduling.text()).toBe(200)
    expect((await restoredScheduling.json()).scheduling).toBeNull()
  } catch (error) { failures.push(error) }
  try {
    await restore.actorRequest.dispose()
  } catch (error) { failures.push(error) }
  try {
    await cleanupRequest.dispose()
  } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'Native consultation restoration failed')
})

test('native online review uses canonical Products, holds capacity, and releases it once', async ({ page, request, baseURL }) => {
  test.setTimeout(120_000)
  test.skip(process.env.NATIVE_CONSULTATION_PROOF !== 'true' || !['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Explicit opt-in in an isolated disposable checkout only; never mutate shared suite fixtures')
  const analyticsFailures: string[] = []
  page.on('response', response => {
    if (/\/api\/(analytics\/track|public\/conversion-events)$/.test(new URL(response.url()).pathname) && response.status() >= 400) analyticsFailures.push(`${response.status()} ${response.url()}`)
  })
  await loginAs(page.request, baseURL!, 'user-e2e-ncls-consultation-owner')
  const org = 'org-ncls-blawby'
  const editor = `/api/editor/organizations/${org}`
  const previousResponse = await page.request.get(`${editor}/consultation`)
  expect(previousResponse.status(), await previousResponse.text()).toBe(200)
  const previous = await previousResponse.json()
  const serviceListResponse = await page.request.get(`${editor}/pages?locale=en`)
  expect(serviceListResponse.status(), await serviceListResponse.text()).toBe(200)
  const serviceRow = (await serviceListResponse.json()).pages.find((page: { path: string }) => page.path === '/services/family')
  expect(serviceRow).toBeTruthy()
  const serviceResponse = await page.request.get(`${editor}/pages/${serviceRow.id}`)
  expect(serviceResponse.status(), await serviceResponse.text()).toBe(200)
  const service = (await serviceResponse.json()).page
  const stamp = Date.now()
  const products: Product[] = []
  const tomorrow = new Date(Date.now() + 86400000)
  const day = tomorrow.toISOString().slice(0, 10)
  const headers = blawbyTestExtraHeaders()
  // Online consultations are held by a provider and booked in their hours. The
  // dedicated test member has none yet; removing its membership restores that
  // state through Better Auth without changing the review owner's hours.
  const membersResponse = await page.request.get(`/api/organizations/${org}/members/scheduling`)
  expect(membersResponse.status(), await membersResponse.text()).toBe(200)
  const self = (await membersResponse.json()).members.find((member: { self: boolean }) => member.self)
  expect(self).toBeTruthy()
  expect(self.scheduling).toBeNull()
  const membershipResponse = await page.request.get('/api/auth/organization/list-members', { params: { organizationId: org } })
  expect(membershipResponse.status(), await membershipResponse.text()).toBe(200)
  const selfMembership = (await membershipResponse.json()).members.find((member: { id: string }) => member.id === self.id)
  expect(selfMembership).toBeTruthy()
  const cleanupRequest = await playwrightRequest.newContext({ baseURL })
  const actorRequest = await playwrightRequest.newContext({ baseURL, storageState: await page.request.storageState() })
  consultationRestore = {
    cleanupRequest, actorRequest, baseURL: baseURL!, organizationId: org, serviceId: service.id,
    originalProductId: service.product_id, previousMode: previous.mode, memberId: self.id,
    memberUserId: selfMembership.userId, memberEmail: selfMembership.user.email, memberRole: selfMembership.role, products,
  }
  await loginAs(cleanupRequest, baseURL!, 'user-e2e-ncls-owner')
  const mcpScheduling = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_member_scheduling', args: { organization_id: org, member_id: self.id } })
  expect(mcpScheduling.status(), await mcpScheduling.text()).toBe(200)
  const missingScheduling = (await mcpScheduling.json()).result
  expect(missingScheduling.isError).toBe(true)
  expect(missingScheduling.structuredContent).toBeUndefined()
  expect(JSON.parse(missingScheduling.content[0].text)).toEqual({ status: 404, message: 'Member scheduling not found', code: 'MEMBER_SCHEDULING_NOT_FOUND' })
  const mcpMembers = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_member_scheduling', args: { organization_id: org } })
  expect(mcpMembers.status(), await mcpMembers.text()).toBe(200)
  expect(mcpData<{ members: Array<Record<string, unknown>> }>(await mcpMembers.json()).members).toContainEqual({ id: self.id, name: self.name, image: self.image, self: true, scheduling: self.scheduling })
  for (const data of [{}, { action: 'unknown' }, { action: 'select', calendar_ids: [] }]) {
    const invalidCalendar = await page.request.post(`/api/organizations/${org}/members/${self.id}/calendar`, { data })
    expect(invalidCalendar.status(), await invalidCalendar.text()).toBe(400)
  }
  // The attorney hosts the consultations, and guests meet them through their published profile.
  const host = { name: 'Consultation attorney', photo_url: null, bio: 'Reviews family law questions before your appointment.' }
  const hours = await page.request.put(`/api/organizations/${org}/members/${self.id}/scheduling`, { data: { timezone: 'UTC', weekly: [{ weekday: tomorrow.getUTCDay(), start: '14:00', end: '14:45' }], time_off: [], expected_updated_at: null, public_name: host.name, public_bio: host.bio, public_approved: true } })
  expect(hours.status(), await hours.text()).toBe(200)
  expect((await hours.json()).scheduling).toMatchObject({ public_name: host.name, public_bio: host.bio, public_approved: 1 })
  for (let index = 0; index < 2; index++) {
    const create = await page.request.post(`${editor}/products`, { data: { kind: 'service', active: true, details: { preparation: 'Bring a list of questions for your consultation', cancellation_policy: 'Contact us at least one day before your appointment to cancel.' }, name: `Local consultation ${stamp}-${index}`, description: 'A local test service for reviewing the native consultation flow.', variants: [{ name: 'Online', prices: [{ unit_amount: 0, currency: 'USD' }] }] } })
    expect(create.status(), await create.text()).toBe(201)
    const product = (await create.json()).product
    products.push(product)
    // This journey adopts the existing authored service page. Remove the
    // temporary service's automatic page explicitly before binding it there.
    expect(product.page).toBeTruthy()
    const automaticPage = await page.request.get(`${editor}/pages/${product.page.id}`)
    expect(automaticPage.status(), await automaticPage.text()).toBe(200)
    const removedPage = await page.request.delete(`${editor}/pages/${product.page.id}`, { data: { expectedUpdatedAt: (await automaticPage.json()).page.document.updated_at } })
    expect(removedPage.status(), await removedPage.text()).toBe(200)
    // Both offerings are the owner's, so the one 14:00 hour can be booked once between them.
    const config = await page.request.put(`${editor}/products/${product.id}/booking`, { data: { duration_minutes: 45, default_capacity: 1, confirmation_mode: 'review', online_payment_required: false, scheduling_mode: 'provider', assigned_member_id: self.id, held_online: true } })
    expect(config.status(), await config.text()).toBe(200)
    const publish = await page.request.put(`${editor}/products/${product.id}/publication`, { data: { published: true } })
    expect(publish.status(), await publish.text()).toBe(200)
  }
  const activate = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'set_consultation_mode', args: { organization_id: org, mode: 'native' } })
  expect(activate.status(), await activate.text()).toBe(200)
  expect(mcpData<{ settings: { mode: string } }>(await activate.json()).settings.mode).toBe('native')
  expect((await (await page.request.get(`${editor}/consultation`)).json()).mode).toBe('native')
    await page.goto(`/dashboard/north-carolina-legal-services/calendar?product_id=${products[0]!.id}`)
    const onlineCalendar = page.locator('#dashboard-panel-org-calendar')
    await expect(onlineCalendar.getByRole('link', { name: 'Bookable times', exact: true })).toHaveAttribute('href', `/dashboard/north-carolina-legal-services/team/${self.id}/hours`)
    await expect(onlineCalendar.getByRole('button', { name: 'Add availability', exact: true })).toHaveCount(0)
    await onlineCalendar.getByRole('combobox', { name: 'Location', exact: true }).click()
    await page.getByRole('option', { name: 'Online', exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get('locationId') === 'online')
    await onlineCalendar.getByRole('combobox', { name: 'Offering', exact: true }).click()
    await page.getByRole('option', { name: products[1]!.name, exact: true }).click()
    await expect(page).toHaveURL(url => url.pathname === '/dashboard/north-carolina-legal-services/calendar' && url.searchParams.get('product_id') === products[1]!.id && !url.searchParams.has('locationId'))
    await expect(onlineCalendar.getByRole('combobox', { name: 'Offering', exact: true })).toContainText(products[1]!.name)
    await expect(onlineCalendar.getByRole('link', { name: 'Bookable times', exact: true })).toHaveAttribute('href', `/dashboard/north-carolina-legal-services/team/${self.id}/hours`)
    await expect(onlineCalendar.getByRole('button', { name: 'Add availability', exact: true })).toHaveCount(0)
    await onlineCalendar.getByRole('combobox', { name: 'Location', exact: true }).click()
    await page.getByRole('option', { name: 'Online', exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get('product_id') === products[1]!.id && url.searchParams.get('locationId') === 'online')
    await onlineCalendar.getByRole('combobox', { name: 'Offering', exact: true }).click()
    await page.getByRole('option', { name: 'All bookings', exact: true }).click()
    await expect(page).toHaveURL(url => url.pathname === '/dashboard/north-carolina-legal-services/calendar' && !url.searchParams.has('locationId') && !url.searchParams.has('product_id'))
    await expect(page.getByRole('button', { name: 'Filter bookings', exact: true })).toBeVisible()
    await page.goto(`/dashboard/north-carolina-legal-services/products/${products[0]!.id}/booking`)
    const bookingPath = `/dashboard/north-carolina-legal-services/products/${products[0]!.id}/booking`
    const bookingPanel = page.locator('#dashboard-panel-product-booking')
    await expect(bookingPanel.getByRole('link', { name: 'Client limit One client per consultation', exact: true })).toBeVisible()
    await expect(bookingPanel.getByRole('link', { name: `Attorney or legal team ${self.name}`, exact: true })).toBeVisible()
    await expect(bookingPanel.getByRole('link', { name: 'Meeting format Online consultations available', exact: true })).toBeVisible()
    // Online, the times are the provider's own hours; the offering has no weekly list of its own.
    await expect(bookingPanel.getByRole('link', { name: "Bookable times The attorney's working hours", exact: true })).toHaveAttribute('href', `/dashboard/north-carolina-legal-services/team/${self.id}/hours`)
    await expect(bookingPanel.getByRole('link', { name: /^Weekly schedule/ })).toHaveCount(0)
    const assigned = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_product', args: { organization_id: org, product_id: products[0]!.id } })
    expect(assigned.status(), await assigned.text()).toBe(200)
    expect(mcpData<{ product: { booking: Record<string, unknown> } }>(await assigned.json()).product.booking).toMatchObject({ scheduling_mode: 'provider', assigned_member_id: self.id, held_online: true })

    await bookingPanel.getByRole('link', { name: 'Duration 45 minutes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await page.getByLabel('Duration in minutes', { exact: true }).fill('50')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(bookingPanel.getByRole('link', { name: 'Duration 50 minutes', exact: true })).toBeVisible()
    const readConfig = async () => {
      const result = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_product', args: { organization_id: org, product_id: products[0]!.id } })
      expect(result.status()).toBe(200)
      return mcpData<{ product: { booking: Record<string, unknown> } }>(await result.json()).product.booking
    }
    expect(await readConfig()).toMatchObject({ duration_minutes: 50, default_capacity: 1, confirmation_mode: 'review', online_payment_required: false, held_online: true })
    expect((await (await page.request.get(`${editor}/consultation`)).json()).mode).toBe('native')
    await bookingPanel.getByRole('link', { name: 'Duration 50 minutes', exact: true }).click()
    await page.getByLabel('Duration in minutes', { exact: true }).fill('45')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(bookingPanel.getByRole('link', { name: 'Duration 45 minutes', exact: true })).toBeVisible()
    expect(await readConfig()).toMatchObject({ held_online: true, duration_minutes: 45 })
    await page.goto(`${bookingPath}/capacity`)
    await expect(page.getByRole('radio', { name: 'One client', exact: true })).toBeChecked()
    await page.getByRole('radio', { name: 'A group of clients', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await page.getByLabel('Maximum clients per consultation', { exact: true }).fill('2')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(bookingPanel.getByRole('link', { name: 'Client limit Up to 2 clients per consultation', exact: true })).toBeVisible()
    await expect(page).toHaveURL(`${baseURL}${bookingPath}/duration`)
    expect(await readConfig()).toMatchObject({ default_capacity: 2, duration_minutes: 45, held_online: true, online_payment_required: false })
    await bookingPanel.getByRole('link', { name: 'Client limit Up to 2 clients per consultation', exact: true }).click()
    await page.getByRole('radio', { name: 'One client', exact: true }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(bookingPanel.getByRole('link', { name: 'Client limit One client per consultation', exact: true })).toBeVisible()
    // Saved summaries update before Save finishes its readback and parent navigation.
    await expect(page).toHaveURL(`${baseURL}${bookingPath}/duration`)
    await bookingPanel.getByRole('link', { name: 'Client limit One client per consultation', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${bookingPath}/capacity`)
    await expect(page.getByRole('radio', { name: 'One client', exact: true })).toBeChecked()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    const desktopViewport = page.viewportSize()!
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('radio', { name: 'A group of clients', exact: true }).click()
    await page.getByLabel('Maximum clients per consultation', { exact: true }).fill('3')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${bookingPath}`)
    await expect(bookingPanel.getByRole('link', { name: 'Client limit One client per consultation', exact: true })).toBeVisible()
    await bookingPanel.getByRole('link', { name: 'Client limit One client per consultation', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'One client', exact: true })).toBeChecked()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    expect(await readConfig()).toMatchObject({ default_capacity: 1 })
    await page.setViewportSize(desktopViewport)
    const bindViaMcp = async (productId?: string | null) => {
      const current = (await (await page.request.get(`${editor}/pages/${service.id}`)).json()).page
      const response = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'update_site_page', args: {
        organization_id: org, variant_id: service.id, expected_updated_at: current.document.updated_at,
        path: current.path, title: current.title, summary: current.summary, pageType: current.page_type,
        recipe: current.recipe, sortOrder: current.sort_order,
        blocks: current.blocks.map((block: { id: string; type: string; level: number | null; parent_block_id: string | null; source_block_id: string | null; data: Record<string, unknown> }) => ({
          id: block.id, type: block.type, level: block.level, parent_block_id: block.parent_block_id, source_block_id: block.source_block_id, data: block.data,
        })),
        ...(productId === undefined ? {} : { product_id: productId }),
      } })
      expect(response.status(), await response.text()).toBe(200)
      expect((await response.json()).result.isError).not.toBe(true)
    }
    await bindViaMcp(null)
    expect((await (await page.request.get(`${editor}/pages/${service.id}`)).json()).page.product_id).toBeNull()
    await bindViaMcp(products[0]!.id)
    await bindViaMcp()
    expect((await (await page.request.get(`${editor}/pages/${service.id}`)).json()).page.product_id).toBe(products[0]!.id)
    const preserved = (await (await page.request.get(`${editor}/pages/${service.id}`)).json()).page
    expect(preserved.product_id).toBe(products[0]!.id)
    // The canonical page update advances block timestamps; content, IDs and media must remain exact.
    const content = (blocks: Array<Record<string, unknown>>) => blocks.map(block => Object.fromEntries(Object.entries(block).filter(([key]) => key !== 'updated_at')))
    expect(content(preserved.blocks)).toEqual(content(service.blocks))
    expect(preserved.summary).toBe(service.summary)
    // The saved Page address is the preview destination, even when its bound
    // consultation has a different Product slug.
    await page.goto(`/dashboard/north-carolina-legal-services/products/${products[0]!.id}/description`)
    const legalCards = page.getByTestId('legal-editor-cards')
    await expect(legalCards.getByTestId('editor-card-page')).toContainText(service.title)
    await page.locator('#dashboard-panel-product').getByRole('link', { name: 'View', exact: true }).click()
    const productPreview = page.getByRole('dialog', { name: 'Legal Services preview', exact: true })
    const previewFrame = productPreview.getByTestId('content-preview-frame')
    await expect(previewFrame).toHaveAttribute('src', new RegExp(`${service.path.replaceAll('/', '\\/')}\\?preview_token=`))
    expect(service.path).not.toContain(products[0]!.slug)
    const sourceMarkdown = service.blocks.find((block: { type: string; data: { markdown?: unknown } }) => block.type === 'markdown' && typeof block.data.markdown === 'string')
    expect(sourceMarkdown, 'the authored family practice Page includes body copy').toBeTruthy()
    const authoredParagraph = sourceMarkdown.data.markdown.split('\n').find((line: string) => line.trim() && !/[#>*_\[\]`]/.test(line))
    expect(authoredParagraph, 'the saved body includes a plain paragraph to read in preview').toBeTruthy()
    await expect(page.frameLocator('[data-testid="content-preview-frame"]').locator('[data-tenant-page]')).toContainText(authoredParagraph)
    const publicShare = productPreview.getByTestId('preview-share')
    await expect(publicShare).toBeVisible()
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await publicShare.click()
    await expect(publicShare).toHaveText('Link copied')
    const shareUrl = new URL(await page.evaluate(() => navigator.clipboard.readText()))
    expect(shareUrl.pathname).toBe(service.path)
    expect([...shareUrl.searchParams.keys()]).toEqual([])
    await productPreview.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(productPreview).toHaveCount(0)
    // A bound page is edited where every page is: it is a row of Pages, and opens the one page editor.
    await page.goto('/dashboard/north-carolina-legal-services/website/pages')
    const pagesList = page.locator('#dashboard-panel-organization-pages')
    await expect(pagesList.getByText('About', { exact: true })).toBeVisible()
    await expect(pagesList.getByText(service.title, { exact: true })).toBeVisible()
    await page.goto(`/dashboard/north-carolina-legal-services/website/pages/${service.id}`)
    await expect(page.locator('#dashboard-panel-organization-page')).toContainText(service.title)
    await page.setExtraHTTPHeaders(headers)
    const wrongRoute = await request.get(`/experiences/${products[0]!.slug}`, { headers })
    expect(wrongRoute.status()).toBe(404)
    const publicBefore = await request.get(`/api/public/pages?path=${service.path}`, { headers })
    expect(publicBefore.status(), await publicBefore.text()).toBe(200)
    const publishedService = (await publicBefore.json()).page
    expect(publishedService.product_id).toBe(products[0]!.id)
    expect(publishedService.title).toBe(service.title)
    expect(publishedService.blocks.map((block: { id: string }) => block.id)).toEqual(service.blocks.map((block: { id: string }) => block.id))
    const storedGallery = (await Promise.all(['cover', 'gallery'].map(async slot => {
      const response = await page.request.get(`${editor}/media?ownerType=content_document&ownerId=${publishedService.id}&slot=${slot}`)
      expect(response.status(), await response.text()).toBe(200)
      return (await response.json()).media as Array<{ id: string; public_url: string; kind: string; thumbnail_url: string | null }>
    }))).flat()
    expect(storedGallery).toHaveLength(8)
    expect(publishedService.media.filter((media: { slot: string }) => ['cover', 'gallery'].includes(media.slot)).map((media: { asset_id: string }) => media.asset_id)).toEqual(storedGallery.map(media => media.id))
    const scheduleSource = await request.get('/api/public/pages?path=/schedule', { headers })
    expect(scheduleSource.status(), await scheduleSource.text()).toBe(200)
    const authoredSchedule: PublicTenantPage = (await scheduleSource.json()).page
    expect(authoredSchedule.blocks.length).toBeGreaterThan(0)
    await openTenantPage(page, new URL('/schedule', baseURL).href, {})
    const scheduleArticle = page.locator('[data-tenant-page]')
    await expect(scheduleArticle).toHaveCount(1)
    const scheduleBlocks = scheduleArticle.locator('.tenant-page-block')
    expect(await scheduleBlocks.evaluateAll(elements => elements.map(element => element.getAttribute('data-block-type')))).toEqual(authoredSchedule.blocks.map(block => block.type))
    for (const [index, block] of authoredSchedule.blocks.entries()) {
      if (block.type === 'hero' && typeof block.data.title === 'string') {
        await expect(page.getByRole('heading', { name: block.data.title, exact: true, level: 1 })).toHaveCount(1)
      }
      if (block.type === 'booking_cta') {
        for (const field of ['title', 'price_line', 'notice']) {
          const text = block.data[field]
          if (typeof text !== 'string' || !text) continue
          await expect(scheduleBlocks.nth(index).getByText(text, { exact: true })).toHaveCount(1)
          const authoredOccurrences = authoredSchedule.blocks.filter(item => item.data[field] === text).length
          await expect(page.locator('main').getByText(text, { exact: true })).toHaveCount(authoredOccurrences)
        }
      }
    }
    await expect(page.locator('#consultations')).toHaveCount(1)
    expect(authoredSchedule.recipe).toBe('schedule')
    const heroIndex = authoredSchedule.blocks.findIndex(block => block.type === 'hero')
    expect(heroIndex).toBeGreaterThanOrEqual(0)
    const scheduleHero = scheduleBlocks.nth(heroIndex)
    await expect(scheduleHero.locator('[data-parity-section="page-hero"]')).toHaveCount(1)
    await expect(scheduleHero.locator('#consultations')).toHaveCount(1)
    // The schedule's native directory follows its hero band within that
    // authored block; it is not appended after the whole page document.
    expect(await scheduleHero.evaluate(block => {
      const hero = block.querySelector('[data-parity-section="page-hero"]')!
      const directory = block.querySelector('#consultations')!
      return hero.parentElement === directory.parentElement
        && Boolean(hero.compareDocumentPosition(directory) & Node.DOCUMENT_POSITION_FOLLOWING)
        && hero.getBoundingClientRect().bottom <= directory.getBoundingClientRect().top
    })).toBe(true)
    // /schedule lists each consultation; it is booked on its own page.
    const consultationCard = page.locator('#consultations').getByRole('link').filter({ hasText: products[0]!.name })
    await expect(consultationCard).toHaveCount(1)
    await expect(consultationCard).toHaveAttribute('href', service.path)
    await expect(page.locator('#consultations').getByRole('combobox')).toHaveCount(0)
    await expect(page.locator('a[href*="/experiences/"]')).toHaveCount(0)
    expect(products[0]!.image).toBeNull()
    await expect(page.locator('section[aria-label="Choose your consultation"] img')).toHaveCount(0)
    const providerRoute=`**/api/public/products/${products[0]!.slug}/provider*`
    await page.route(providerRoute,route=>route.fulfill({status:503,json:{statusCode:503,message:'Provider lookup unavailable'}}))
    await consultationCard.click()
    await expect(page).toHaveURL(new RegExp(`${service.path}$`))
    await expect(page.getByRole('heading', { name: products[0]!.name, exact: true, level: 1 })).toBeVisible()
    await expect(page.getByText('Free', { exact: true }).filter({ visible: true }).first()).toBeVisible()
    await expect(page.getByText('Staff review', { exact: true }).first()).toBeVisible()
    const availableTimes = page.getByRole('button', { name: /^Select a time / })
    await expect(availableTimes).toHaveCount(4)
    for (const choice of await availableTimes.all()) await expect(choice).toBeVisible()
    const pageTimezone = page.getByRole('button', { name: 'Time zone', exact: true })
    await expect(pageTimezone).toContainText('(America/New_York)')
    await pageTimezone.click()
    const timezonePopup = page.getByRole('listbox')
    const supportedZones = await page.evaluate(() => [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])].sort())
    await expect(timezonePopup.getByRole('option')).toHaveCount(supportedZones.length)
    expect((await timezonePopup.getByRole('option').allTextContents()).map(label => label.match(/\(([^)]+)\)$/)![1]).sort()).toEqual(supportedZones)
    const popupBox = await timezonePopup.boundingBox()
    expect(popupBox!.height).toBeLessThanOrEqual(241)
    const zoneViewport = timezonePopup.locator('[data-slot="viewport"]')
    const initialScroll = await zoneViewport.evaluate(element => element.scrollTop)
    await zoneViewport.hover()
    await page.mouse.wheel(0, 140)
    await expect.poll(() => zoneViewport.evaluate(element => element.scrollTop)).toBeGreaterThan(initialScroll)
    const zoneSearch = page.getByLabel('Search time zones', { exact: true })
    await zoneSearch.fill('UTC')
    await expect(timezonePopup.getByRole('option')).toHaveCount(1)
    await zoneSearch.press('ArrowDown')
    await zoneSearch.press('Enter')
    await expect(pageTimezone).toContainText('(UTC)')
    await pageTimezone.click()
    await zoneSearch.fill('America/New_York')
    await expect(timezonePopup.getByRole('option')).toHaveCount(1)
    await zoneSearch.press('ArrowDown')
    await zoneSearch.press('Enter')
    await expect(pageTimezone).toContainText('(America/New_York)')
    const providerSection=page.locator('section[aria-label="Meet your host"]')
    await waitForNuxtHydration(page)
    const failedProvider=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/public/products/${products[0]!.slug}/provider`)
    await availableTimes.first().click()
    expect((await failedProvider).status()).toBe(503)
    await page.getByRole('button',{name:'Close booking form',exact:true}).click()
    await expect(providerSection.getByText('Profile could not be loaded',{exact:true})).toBeVisible()
    await expect(providerSection.getByText('North Carolina Legal Services',{exact:true})).toHaveCount(0)
    await page.unroute(providerRoute)
    const providerRetry=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/public/products/${products[0]!.slug}/provider`)
    await providerSection.getByRole('button',{name:'Try again',exact:true}).click()
    const providerResponse=await providerRetry
    expect(providerResponse.status(),await providerResponse.text()).toBe(200)
    expect((await providerResponse.json()).hosts).toEqual([host])
    await expect(providerSection.getByText(host.name,{exact:true})).toBeVisible()
    await expect(providerSection.getByText(host.bio,{exact:true})).toBeVisible()
    await expect(page.getByRole('button',{name:'Try again',exact:true})).toHaveCount(0)
    await expect(page.locator('[data-block-type="hero"]')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /where.*meet/i })).toHaveCount(0)
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new URL(service.path, baseURL).href)
    expect(await page.locator('[data-tenant-page] [data-block-type]').evaluateAll(blocks => blocks.map(block => block.getAttribute('data-block-type')))).toEqual(service.blocks.filter((block: { type: string }) => block.type !== 'hero').map((block: { type: string }) => block.type))
    const gallery = publishedService.media.filter((media: { slot: string; public_url: string | null }) => ['cover', 'gallery'].includes(media.slot) && media.public_url)
    // This existing fixture has one cover and seven authored gallery placements.
    expect(gallery).toHaveLength(8)
    expect(gallery.map((media: { public_url: string; kind: string; thumbnail_url: string | null }) => ({ url: media.public_url, kind: media.kind, poster: media.thumbnail_url }))).toEqual(storedGallery.map(media => ({ url: media.public_url, kind: media.kind, poster: media.thumbnail_url })))
    const visibleTiles = page.locator('[data-media-gallery]').getByRole('button', { name: `Open media, ${products[0]!.name}`, exact: true })
    await expect(visibleTiles).toHaveCount(5)
    await expect(page.locator('[data-media-gallery]').getByRole('button', { name: 'Show all 8 photos', exact: true })).toBeVisible()
    const tileBounds = await visibleTiles.evaluateAll(tiles => tiles.map(tile => { const box = tile.getBoundingClientRect(); const frame = tile.closest('[data-media-gallery]')!.getBoundingClientRect(); return { top: box.top - frame.top, bottom: box.bottom - frame.top, height: frame.height } }))
    expect(tileBounds.every(tile => tile.top >= 0 && tile.bottom <= tile.height + 1)).toBe(true)
    const lightbox = page.getByRole('dialog', { name: products[0]!.name, exact: true })
    for (let index = 0; index < 5; index++) {
      await visibleTiles.nth(index).click()
      await expect(lightbox.locator('section').nth(index).locator('img').last()).toBeInViewport()
      await lightbox.getByRole('button', { name: 'Close photos and videos', exact: true }).click()
    }
    await visibleTiles.first().click()
    for (let index = 0; index < gallery.length; index++) {
      const image = lightbox.locator('section').nth(index).locator('img').last()
      await expect(image).toHaveAttribute('src', gallery[index].public_url)
      await expect(image).toHaveAttribute('alt', gallery[index].alt_text ?? '')
      await expect(image).toBeInViewport()
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0), { timeout: 30_000 }).toBe(true)
      if (index < gallery.length - 1) await lightbox.getByRole('button', { name: 'Next photo or video', exact: true }).click()
    }
    await lightbox.getByRole('button', { name: 'Close photos and videos', exact: true }).click()
    const placement = await page.locator('#consultations, [data-tenant-page]').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top))
    expect(placement[0]).toBeLessThan(placement[1]!)
    const externalUrl = 'https://example.com/?booking=ncls'
    await page.setExtraHTTPHeaders({})
    await page.goto(`/dashboard/north-carolina-legal-services/products/${products[0]!.id}/order-url`)
    await page.getByLabel('Website address', { exact: true }).fill(externalUrl)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const nativeConfigBeforeHandoff = await readConfig()
    const withoutNativeCalendar = await page.request.put(`${editor}/products/${products[0]!.id}/booking`, { data: { held_online: false } })
    expect(withoutNativeCalendar.status(), await withoutNativeCalendar.text()).toBe(200)
    const externalProduct = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_product', args: { organization_id: org, product_id: products[0]!.id } })
    const savedExternalProduct = mcpData<{ product: { order_url: string; booking: { held_online: boolean } } }>(await externalProduct.json()).product
    expect(savedExternalProduct.order_url).toBe(externalUrl)
    expect(savedExternalProduct.booking.held_online).toBe(false)
    expect(savedExternalProduct).not.toHaveProperty('tags')
    const externalSessions = await request.get(`/api/public/products/${products[0]!.slug}/sessions?location_id=online`, { headers })
    expect(externalSessions.status()).toBe(200)
    expect((await externalSessions.json()).sessions).toEqual([])
    await page.setExtraHTTPHeaders(headers)
    await page.goto(service.path)
    await expect(page.getByRole('heading', { name: products[0]!.name, exact: true, level: 1 })).toBeVisible()
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 })
      const handoff = page.locator(`a[href="${externalUrl}"]:visible`)
      await expect(handoff).toHaveCount(1)
      await expect(handoff).toHaveText('Book now')
      await expect(page.getByRole('button', { name: 'Request appointment', exact: true })).toHaveCount(0)
    }
    await waitForNuxtHydration(page)
    const recordedHandoff = page.waitForResponse(response => new URL(response.url()).pathname === '/api/public/conversion-events' && response.request().postDataJSON()?.event_name === 'product_order_external_click')
    const externalTab = page.waitForEvent('popup')
    await page.locator(`a[href="${externalUrl}"]:visible`).click()
    expect((await recordedHandoff).status()).toBe(201)
    const destination = await externalTab
    await expect(destination).toHaveURL(externalUrl)
    await destination.close()
    const events = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'query_organization_analytics', args: { organization_id: org, mode: 'events', filters: { event_name: 'product_order_external_click', entity_id: products[0]!.id } } })
    const recordedEvents = mcpData<{ rows: Array<Record<string, unknown>> }>(await events.json()).rows
    expect(recordedEvents).toHaveLength(1)
    expect(recordedEvents[0]).toMatchObject({ location_id: null, subject: { type: 'product', id: products[0]!.id }, metadata: { destination_hostname: 'example.com' } })
    const restoreCalendar = await page.request.put(`${editor}/products/${products[0]!.id}/booking`, { data: { held_online: nativeConfigBeforeHandoff.held_online } })
    expect(restoreCalendar.status(), await restoreCalendar.text()).toBe(200)
    const restoreNative = await page.request.patch(`${editor}/products/${products[0]!.id}`, { data: { order_url: null } })
    expect(restoreNative.status()).toBe(200)
    await page.goto(service.path)
    await expect(page.getByText('Bring a list of questions for your consultation', { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('button', { name: 'Request appointment', exact: true })).toBeVisible()
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.getByRole('button', { name: 'Request appointment', exact: true }).focus()
    await page.keyboard.press('Enter')
    const bookingDialog = page.getByRole('dialog', { name: products[0]!.name, exact: true })
    await expect(bookingDialog).toBeVisible()
    const modalTimezone = bookingDialog.getByRole('button', { name: 'Time zone', exact: true })
    await expect(modalTimezone).toContainText('(America/New_York)')
    await expect(bookingDialog.getByRole('button', { name: /10:00 AM/ }).first()).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await modalTimezone.click()
    await expect(timezonePopup).toBeVisible()
    const mobilePopupBox = await timezonePopup.boundingBox()
    expect(mobilePopupBox!.height).toBeLessThanOrEqual(241)
    expect(mobilePopupBox!.x).toBeGreaterThanOrEqual(0)
    expect(mobilePopupBox!.x + mobilePopupBox!.width).toBeLessThanOrEqual(390)
    expect(mobilePopupBox!.y + mobilePopupBox!.height).toBeLessThanOrEqual(844)
    await zoneSearch.fill('Pacific/Auckland')
    await expect(timezonePopup.getByRole('option')).toHaveCount(1)
    await zoneSearch.press('Escape')
    await expect(timezonePopup).toBeHidden()
    await expect(bookingDialog).toBeVisible()
    await expect(modalTimezone).toBeFocused()
    await modalTimezone.click()
    await zoneSearch.fill('UTC')
    await expect(timezonePopup.getByRole('option')).toHaveCount(1)
    await zoneSearch.press('ArrowDown')
    await zoneSearch.press('Enter')
    await expect(modalTimezone).toContainText('(UTC)')
    await expect(bookingDialog.getByRole('button', { name: /2:00 PM/ }).first()).toBeVisible()
    await expect(bookingDialog.getByText('Party size', { exact: true })).toHaveCount(0)
    await expect(bookingDialog.getByRole('button', { name: /more guests|fewer guests/i })).toHaveCount(0)
    await bookingDialog.getByRole('button', { name: /2:00 PM/ }).first().click()
    await page.setViewportSize({ width: 390, height: 844 })
    const sessions = await Promise.all(products.map(async product => {
      const response = await request.get(`/api/public/products/${product.slug}/sessions?location_id=online&from=${day}&to=${day}`, { headers })
      expect(response.status(), await response.text()).toBe(200)
      return (await response.json()).sessions.find((session: { starts_at: string }) => session.starts_at.startsWith(day))
    }))
    for(const [sessionId,status]of [[sessions[1].id,404],['missing-session',404],['',400]]) {
      const invalidProvider=await request.get(`/api/public/products/${products[0]!.slug}/provider`,{headers,params:{session_id:String(sessionId)}})
      expect(invalidProvider.status(),await invalidProvider.text()).toBe(status)
      expect((await invalidProvider.json()).hosts).toBeUndefined()
    }
    const ambiguousProvider=await request.get(`/api/public/products/${products[0]!.slug}/provider?session_id=${sessions[0].id}&session_id=${sessions[1].id}`,{headers})
    expect(ambiguousProvider.status(),await ambiguousProvider.text()).toBe(400)
    const book = (index: number) => request.post(`/api/public/products/${products[index]!.slug}/book`, { headers, data: { session_id: sessions[index].id, variant_id: products[index]!.variants[0]!.id, party_size: 1, guest_name: `Local review ${index}`, guest_email: `consultation-${stamp}-${index}@playwright.example`, idempotency_key: crypto.randomUUID() } })
    const results = await Promise.all([book(0), book(1)])
    expect(results.map(result => result.status()).sort()).toEqual([201, 409])
    const pending = await results.find(result => result.status() === 201)!.json()
    expect(pending).toMatchObject({ status: 'pending', booking_id: pending.request_id })
    expect(pending.operational_booking_id).not.toBe(pending.request_id)
    expect(pending.policy_summary.additional_notes_html).toBe('Contact us at least one day before your appointment to cancel.')
    const details = await page.request.get(`/api/dashboard/bookings/booking/${pending.request_id}?org=north-carolina-legal-services`)
    expect(details.status(), await details.text()).toBe(200)
    expect((await details.json()).booking).toMatchObject({ locationId: null, locationTitle: 'Online', status: 'pending', operationalBookingId: pending.operational_booking_id, assignedMemberId: self.id, assignedMemberName: self.name, policy: pending.policy_summary })
    const invalidReassignment = await page.request.post(`/api/dashboard/bookings/booking/${pending.operational_booking_id}/provider?org=north-carolina-legal-services`, { data: { member_id: 42, expected_updated_at: new Date().toISOString(), idempotency_key: `invalid-${stamp}` } })
    expect(invalidReassignment.status(), await invalidReassignment.text()).toBe(400)
    const unchangedBooking = await page.request.get(`/api/dashboard/bookings/booking/${pending.request_id}?org=north-carolina-legal-services`)
    expect(unchangedBooking.status(), await unchangedBooking.text()).toBe(200)
    expect((await unchangedBooking.json()).booking).toMatchObject({ status: 'pending', operationalBookingId: pending.operational_booking_id, assignedMemberId: self.id, assignedMemberName: self.name })
    const key = `reject-${stamp}`
    for (let replay = 0; replay < 2; replay++) {
      const reject = await page.request.post(`/api/dashboard/organizations/${org}/guest-threads/${pending.request_id}/operations/reject`, { data: { idempotencyKey: key } })
      expect(reject.status(), await reject.text()).toBe(200)
    }
    const remaining = await request.get(`/api/public/products/${products[0]!.slug}/sessions?location_id=online&from=${day}&to=${day}`, { headers })
    expect((await remaining.json()).sessions.find((session: { id: string }) => session.id === sessions[0].id)).toMatchObject({ remaining: 1, is_full: false })
    const dialog = bookingDialog
    await dialog.getByRole('button', { name: /2:00 PM/ }).first().click()
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(dialog.getByText(/ · 2:00 PM$/, { exact: false })).toBeVisible()
    await dialog.getByLabel('Full name', { exact: true }).fill('Browser review guest')
    await dialog.getByLabel('Email address', { exact: true }).fill(`browser-consultation-${stamp}@playwright.example`)
    const submitted = page.waitForResponse(response => response.url().includes(`/products/${products[0]!.slug}/book`) && response.request().method() === 'POST')
    await dialog.getByRole('button', { name: 'Request appointment', exact: true }).click()
    const browserBookingResponse = await submitted
    expect(browserBookingResponse.status(), await browserBookingResponse.text()).toBe(201)
    const browserBooking = await browserBookingResponse.json()
    expect(browserBooking.status).toBe('pending')
    await expect(page).toHaveURL(/\/bookings\/confirmed/)
    await expect(page.getByRole('heading', { name: 'Thank you, Browser review guest!', exact: true, level: 1 })).toBeVisible()
    await expect(page.getByText('Request received', { exact: true })).toBeVisible()
    await expect(page.getByText('Your request is waiting for confirmation from the business.', { exact: true })).toBeVisible()
    expect(analyticsFailures).toEqual([])
    for (let replay = 0; replay < 2; replay++) {
      const confirm = await page.request.post(`/api/dashboard/organizations/${org}/guest-threads/${browserBooking.request_id}/operations/confirm`, { data: { idempotencyKey: `confirm-${stamp}` } })
      expect(confirm.status(), await confirm.text()).toBe(200)
    }
    const confirmedDetails = await page.request.get(`/api/dashboard/bookings/booking/${browserBooking.request_id}?org=north-carolina-legal-services`)
    expect((await confirmedDetails.json()).booking).toMatchObject({ status: 'confirmed', operationalBookingId: browserBooking.operational_booking_id })
    await page.goto(`/dashboard/north-carolina-legal-services/bookings/booking/${browserBooking.request_id}`)
    await page.getByRole('button', { name: `Cancellation policy ${browserBooking.policy_summary.additional_notes_html}`, exact: true }).click()
    const policyDialog = page.getByRole('dialog', { name: browserBooking.policy_summary.heading, exact: true })
    await expect(policyDialog.getByText(browserBooking.policy_summary.additional_notes_html, { exact: true })).toBeVisible()
    await expect(policyDialog.getByText('No cancellation terms have been configured for this booking.', { exact: true })).toHaveCount(0)
    await policyDialog.getByRole('button', { name: `Close ${browserBooking.policy_summary.heading}`, exact: true }).click()
    await page.getByRole('link', { name: `Team member ${self.name}`, exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Team member', exact: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: `${host.name} Current`, exact: true })).toBeChecked()
    await expect(page.getByText('Current', { exact: true })).toBeVisible()
    await expect(page.getByText('Add working hours for a team member before moving this booking.', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    for (const mode of ['external_url', 'native_disabled', 'native'] as const) {
      const switchMode = await page.request.put(`${editor}/consultation`, { data: { mode } })
      expect(switchMode.status(), await switchMode.text()).toBe(200)
      const publicDocument = await request.get('/api/public/pages?path=/schedule', { headers })
      const publicShell = await request.get('/api/public/shell', { headers })
      expect(publicShell.status(), await publicShell.text()).toBe(200)
      const modeShell: PublicShellPayload = await publicShell.json()
      expect(publicDocument.status(), await publicDocument.text()).toBe(200)
      const modeDocument: PublicTenantPage = (await publicDocument.json()).page
      expect(modeShell.consultation!.mode).toBe(mode)
      expect(modeDocument.blocks).toEqual(authoredSchedule.blocks)
      await page.goto(service.path)
      await expect(page.locator('[data-media-gallery]')).toHaveCount(1)
      await expect(page.locator('[data-block-type="hero"]')).toHaveCount(0)
      await page.goto('/schedule')
      await expect(page.getByRole('combobox', { name: 'Service', exact: true })).toHaveCount(0)
      await expect(page.locator('#consultations')).toHaveCount(mode === 'native' ? 1 : 0)
      expect(await scheduleBlocks.evaluateAll(elements => elements.map(element => element.getAttribute('data-block-type')))).toEqual(authoredSchedule.blocks.map(block => block.type))
      if (mode === 'native') {
        await expect(consultationCard).toBeVisible()
        await expect(consultationCard).toHaveAttribute('href', service.path)
      } else if (mode === 'external_url') {
        const authoredLabel = authoredSchedule.blocks[heroIndex]!.data.cta_label
        const expectedLabel = typeof authoredLabel === 'string' && authoredLabel.trim() ? authoredLabel.trim() : modeShell.consultation!.cta_label
        expect(expectedLabel).toBeTruthy()
        const externalAction = scheduleHero.locator('[data-parity-section="page-hero"]').getByRole('link', { name: expectedLabel, exact: true })
        await expect(externalAction).toHaveCount(1)
        await expect(externalAction).toHaveAttribute('href', modeShell.consultation!.external_url!)
      } else if (mode === 'native_disabled') {
        const contactAction = scheduleHero.locator('[data-parity-section="page-hero"]').getByRole('link', { name: 'Contact', exact: true })
        await expect(contactAction).toHaveCount(1)
        await expect(contactAction).toHaveAttribute('href', '/contact')
      }
      const binding = (await (await page.request.get(`${editor}/pages/${service.id}`)).json()).page
      expect(binding.product_id).toBe(products[0]!.id)
      expect(content(binding.blocks)).toEqual(content(service.blocks))
      const retained = await page.request.get(`/api/dashboard/bookings/booking/${browserBooking.request_id}?org=north-carolina-legal-services`)
      expect((await retained.json()).booking).toMatchObject({ status: 'confirmed', operationalBookingId: browserBooking.operational_booking_id })
    }
    const pause = await page.request.patch(`${editor}/products/${products[0]!.id}`, { data: { active: false } })
    expect(pause.status(), await pause.text()).toBe(200)
    await page.goto(service.path)
    await expect(page.locator('[data-media-gallery]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Request appointment', exact: true })).toHaveCount(0)
    const resume = await page.request.patch(`${editor}/products/${products[0]!.id}`, { data: { active: true } })
    expect(resume.status(), await resume.text()).toBe(200)
    await bindViaMcp(null)
    await page.goto(service.path)
    await expect(page.locator('[data-media-gallery]')).toHaveCount(0)
    await expect(page.locator('[data-block-type="hero"]')).toHaveCount(1)
    await bindViaMcp(products[0]!.id)
    await page.goto(service.path)
    await expect(page.locator('[data-media-gallery]')).toHaveCount(1)
    const browserCancel = await request.post(`/api/public/booking-requests/${browserBooking.request_id}/cancel`, { headers: { ...headers, authorization: `Bearer ${browserBooking.cancellation_token}` } })
    expect(browserCancel.status(), await browserCancel.text()).toBe(200)
    const cancelledBrowserDetails = await page.request.get(`/api/dashboard/bookings/booking/${browserBooking.request_id}?org=north-carolina-legal-services`)
    expect((await cancelledBrowserDetails.json()).booking.status).toBe('cancelled')
    await page.goto(`/dashboard/north-carolina-legal-services/bookings/booking/${browserBooking.request_id}`)
    await expect(page.getByRole('link', { name: `Team member ${self.name}`, exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Change consultation', exact: true })).toHaveCount(0)
    await page.getByRole('link', { name: 'Message guest', exact: true }).click()
    await expect(page).toHaveURL(`/dashboard/north-carolina-legal-services/messages/${browserBooking.request_id}`)
    await expect(page.getByRole('heading', { name: 'Browser review guest', exact: true })).toBeVisible()
    const currentProductResponse = await page.request.get(`${editor}/products/${products[0]!.id}`)
    expect(currentProductResponse.status(), await currentProductResponse.text()).toBe(200)
    const currentProduct = (await currentProductResponse.json() as { product: Product }).product
    expect(currentProduct.variants).toHaveLength(1)
    const onlineVariant = currentProduct.variants[0]!
    expect(onlineVariant.prices).toHaveLength(1)
    const onlinePrice = onlineVariant.prices[0]!
    expect(onlinePrice).toMatchObject({ currency: 'USD', unit_amount: 0 })
    const paid = await page.request.patch(`${editor}/products/${products[0]!.id}`, { data: { variants: [{ id: onlineVariant.id, prices: [{ id: onlinePrice.id, unit_amount: 7500 }] }] } })
    expect(paid.status(), await paid.text()).toBe(200)
    const blocked = await page.request.put(`${editor}/products/${products[0]!.id}/booking`, { data: { online_payment_required: true } })
    expect(blocked.status(), await blocked.text()).toBe(503)
    expect(await blocked.json()).toMatchObject({ data: { code: 'financial_action_required', dashboard_url: '/dashboard/north-carolina-legal-services/payments', missing: ['payments.entitlement', 'payments.configuration', 'payments.account'] } })
    expect(await readConfig()).toMatchObject({ online_payment_required: false })
    const instantPolicy = await page.request.put(`${editor}/products/${products[0]!.id}/booking`, { data: { duration_minutes: 45, default_capacity: 1, confirmation_mode: 'instant', online_payment_required: false } })
    expect(instantPolicy.status(), await instantPolicy.text()).toBe(200)
    const instantResponse = await book(0)
    expect(instantResponse.status(), await instantResponse.text()).toBe(201)
    const instant = await instantResponse.json()
    expect(instant.status).toBe('confirmed')
    for (let replay = 0; replay < 2; replay++) {
      const cancel = await request.post(`/api/public/booking-requests/${instant.request_id}/cancel`, { headers: { ...headers, authorization: `Bearer ${instant.cancellation_token}` } })
      expect(cancel.status(), await cancel.text()).toBe(200)
      expect(await cancel.json()).toEqual({ success: true, kind: 'booking' })
      const cancelledDetails = await page.request.get(`/api/dashboard/bookings/booking/${instant.request_id}?org=north-carolina-legal-services`)
      expect((await cancelledDetails.json()).booking.status).toBe('cancelled')
      const released = await request.get(`/api/public/products/${products[0]!.slug}/sessions?location_id=online`, { headers })
      expect((await released.json()).sessions.find((session: { id: string }) => session.id === sessions[0].id).remaining).toBe(1)
    }
    const invalidCancel = await request.post(`/api/public/booking-requests/${instant.request_id}/cancel`, { headers: { ...headers, authorization: 'Bearer invalid-cancellation-token' } })
    expect(invalidCancel.status(), await invalidCancel.text()).toBe(404)
})
