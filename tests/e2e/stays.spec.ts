import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test'
import { waitForNuxtHydration } from './helpers'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { mcpRequest, publishOwnHostProfile } from './helpers/mcp'
import { readLocalTenant } from './test-env'
import type { Product } from '../../server/types/products'
import type { PublicStayCalendar, StayQuote } from '../../server/domain/stays'

// A host's place to stay, end to end through the surfaces that own it: the
// one Product editor creates the home, Today adds a stay, and the stay's
// own screen show it and record a payment and a cancellation. Every write is
// read back through a different path than the one that made it.

const TIME_ZONE = 'Asia/Bangkok'

function localDay(offset: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
}

async function tool<T>(request: APIRequestContext, baseURL: string, organizationId: string, name: string, args: Record<string, unknown>): Promise<{ data: T | null; error: string | null }> {
  const response = await mcpRequest(request, baseURL, { method: 'tools/call', toolName: name, args: { organization_id: organizationId, ...args } })
  expect(response.status()).toBe(200)
  const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: T } }
  if (body.result?.isError) return { data: null, error: body.result.content?.map(item => item.text).join('\n') ?? 'unknown error' }
  return { data: body.result!.structuredContent!, error: null }
}

// A wrong status explains itself with its body. Reading the body only then
// keeps a request torn down by a timeout from replacing the step that ran out
// of time with "Response has been disposed".
async function expectStatus(response: Pick<APIResponse, 'status' | 'text'>, status: number) {
  expect(response.status(), response.status() === status ? undefined : await response.text()).toBe(status)
}

async function createStayHome(page: Page, baseURL: string, options: { selectDifferentLocation?: boolean; internalName?: string; createInForm?: boolean } = {}) {
  const { selectDifferentLocation = false, internalName = 'Cliff Cabin', createInForm = false } = options
  const request = page.request
  await loginAs(request, baseURL, 'user-e2e-lodging-host')
  const headers = authRequestHeaders(baseURL)
  const slug = `e2e-stays-${crypto.randomUUID().slice(0, 8)}`
  const created = await request.post(`${baseURL}/api/auth/organization/create`, { headers, data: { name: `Stays ${slug}`, slug, default_currency: 'THB', timezone: TIME_ZONE } })
  await expectStatus(created, 200)
  const organizationId = (await created.json() as { id: string }).id
  const provisioned = await request.post(`${baseURL}/api/organizations`, { headers, data: { organization_id: organizationId, name: `Stays ${slug}`, subdomain: slug, vertical: 'lodging', source_locale: 'en' } })
  await expectStatus(provisioned, 200)
  expect((await request.post(`${baseURL}/api/auth/organization/set-active`, { headers, data: { organizationId } })).status()).toBe(200)
  const call = <T>(name: string, args: Record<string, unknown>) => tool<T>(request, baseURL, organizationId, name, args)
  // The host who creates the home looks after it until they give it to someone else.
  const listedMembers = await request.get(`${baseURL}/api/auth/organization/list-members`, { params: { organizationId } })
  await expectStatus(listedMembers, 200)
  const owner = (await listedMembers.json() as { members: Array<{ id: string; role: string; user: { name: string } }> }).members.find(member => member.role === 'owner')!
  const ownerMemberId = owner.id
  const ownerName = owner.user.name
  const locations = await call<{ locations: Array<{ id: string; title: string }> }>('list_locations', {})
  const entryLocation = locations.data!.locations[0]!
  expect(entryLocation).toBeTruthy()
  let location = entryLocation
  if (selectDifferentLocation) {
    const createdLocation = await call<{ location: { id: string; title: string } }>('create_location', { title: 'Cliff Cabin location', timezone: TIME_ZONE, idempotency_key: `${slug}-home-location` })
    expect(createdLocation.error).toBeNull()
    location = createdLocation.data!.location
    expect(location.id).not.toBe(entryLocation.id)
  }
  const placed = await call<{ location: { address: { regionCode: string; addressLines: string[]; locality?: string; administrativeArea?: string; postalCode?: string } | null } }>('get_location', { location_id: location.id })
  expect(placed.error).toBeNull()
  // The home reads its location's address in the shape a home is added with.
  const postal = placed.data!.location.address
  const homeAddress = postal && { address: postal.addressLines.join(', '), city: postal.locality ?? null, state: postal.administrativeArea ?? null, country: postal.regionCode, zip_code: postal.postalCode ?? null }

  const productEndpoint = `/api/editor/organizations/${organizationId}/products`
  let saved: Pick<APIResponse, 'status' | 'text' | 'json'>
  if (createInForm) {
    // The creation journeys exercise the form that owns the home's title, location and stay facts.
    await page.goto(`/dashboard/${slug}/products/new?kind=stay&location_id=${encodeURIComponent(entryLocation.id)}`)
    await expect(page).toHaveURL(`/dashboard/${slug}/products/new?kind=stay&location_id=${encodeURIComponent(entryLocation.id)}`)
    if (selectDifferentLocation) {
      await page.getByRole('combobox', { name: 'Location*', exact: true }).click()
      await page.getByRole('option', { name: location.title, exact: true }).click()
    }
    await page.getByRole('textbox', { name: 'Internal name', exact: true }).fill(internalName)
    await page.getByRole('textbox', { name: 'Listing title', exact: true }).fill('Cliff Cabin')
    if (selectDifferentLocation) {
      await page.getByRole('link', { name: /^(Add|Edit) address$/ }).click()
      await expect(page.getByRole('heading', { name: 'Address', exact: true })).toBeVisible()
      await page.goBack()
      await expect(page.getByRole('textbox', { name: 'Listing title', exact: true })).toHaveValue('Cliff Cabin')
    }
    await page.getByRole('textbox', { name: 'Sleeps' }).fill('4')
    await page.getByRole('textbox', { name: 'Minimum nights' }).fill('2')
    await page.getByRole('combobox', { name: 'Looked after by*', exact: true }).click()
    await page.getByRole('option', { name: ownerName, exact: true }).click()
    const creation = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === productEndpoint)
    await page.locator('#dashboard-panel-product').getByRole('button', { name: 'Create place to stay', exact: true }).click()
    saved = await creation
  } else {
    // Other journeys start from the same editor write and exercise their own UI boundary.
    saved = await request.post(productEndpoint, { headers, data: {
      kind: 'stay', name: 'Cliff Cabin', active: true, idempotency_key: `${slug}-home`, stay: { internal_name: internalName, location_id: location.id, assigned_member_id: ownerMemberId,
        check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 2 },
    } })
  }
  await expectStatus(saved, 201)
  const productId = (await saved.json() as { product: { id: string } }).product.id
  const productPage = `/dashboard/${slug}/products/${productId}?location_id=${encodeURIComponent(location.id)}`
  if (!createInForm) await page.goto(productPage)
  await expect(page).toHaveURL(url => url.pathname === `/dashboard/${slug}/products/${productId}`
    && url.searchParams.get('location_id') === location.id)
  expect(productId).toMatch(/^[0-9a-f-]{36}$/)
  const unknownPropertyFacts = { listing_type: null, total_floors: null, listing_floor: null, year_built: null, property_size: null, property_size_unit: null }
  const home = await call<{ product: { kind: string; slug: string; unit_label: string; stay: Record<string, unknown> } }>('get_product', { product_id: productId })
  expect(home.error).toBeNull()
  expect(home.data!.product).toMatchObject({ kind: 'stay', unit_label: 'night', stay: { internal_name: internalName, location_id: location.id, check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 2, ...unknownPropertyFacts } })
  const api = (path: string) => `${baseURL}/api/dashboard/${path}${path.includes('?') ? '&' : '?'}org=${encodeURIComponent(slug)}`
  return { request, headers, slug, organizationId, location, homeAddress, call, api, productId, unknownPropertyFacts, home, ownerMemberId, ownerName }
}

// The editor's View mode wraps the real guest page in one iframe.
function previewLocators(page: Page) {
  const previewLink = page.locator('#dashboard-panel-product').getByRole('link', { name: 'View', exact: true })
  const previewModal = page.getByRole('dialog', { name: 'Listing preview', exact: true })
  const previewIframe = previewModal.locator('iframe[title="Listing preview"]')
  return { previewLink, previewModal, previewIframe, preview: previewIframe.contentFrame() }
}

test('a host lists, pauses and unlists a priced place to stay', async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { request, headers, slug, organizationId, location, call, productId, ownerMemberId } = await createStayHome(page, baseURL!)
  const invitePath = `/api/dashboard/members?view=invite&org=${encodeURIComponent(slug)}`
  const staffInvite = await request.get(invitePath)
  await expectStatus(staffInvite, 200)
  const { organization_id, roles } = await staffInvite.json() as { organization_id: string; roles: Array<{ value: string }> }
  expect(organization_id).toBe(organizationId)
  expect(roles.map(role => role.value).sort()).toEqual(['admin', 'cleaner', 'maintenance', 'member', 'owner', 'property_manager'])
  const outsider = await browser.newContext({ baseURL })
  try {
    await loginAs(outsider.request, baseURL!, 'user-e2e-oauth-private-cimd')
    await expectStatus(await outsider.request.get(invitePath), 404)
  } finally {
    await outsider.close()
  }
  const sitePages = await call<{ built_in_pages: Array<{ path: string }>; pages: Array<{ id: string; path: string }> }>('list_site_pages', {})
  expect(sitePages.error).toBeNull()
  expect(sitePages.data!.built_in_pages.map(item => item.path)).toContain('/stays')
  expect(sitePages.data!.built_in_pages.map(item => item.path)).not.toContain('/locations')
  const homePage = sitePages.data!.pages.find(item => item.path === '/')!
  const locationGrid = await call('append_content_block', { document_id: homePage.id, type: 'location_grid', data: { location_ids: [location.id] } })
  expect(JSON.parse(locationGrid.error!)).toMatchObject({ status: 400, message: 'Lodging pages list homes with a product grid; location pages are not available' })
  const { previewLink, previewModal, previewIframe } = previewLocators(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/dashboard/${slug}/products`)
  const card = page.getByTestId(`selector-item-${productId}`)
  await card.click()
  await page.getByRole('link', { name: /^Internal name/ }).click()
  const nameEditor = page.locator('#dashboard-panel-product-internal-name')
  await nameEditor.getByRole('textbox', { name: 'Internal name', exact: true }).fill('North Cliff Cabin')
  const saveName = page.waitForResponse(response => response.request().method() === 'PATCH'
    && new URL(response.url()).pathname.endsWith(`/products/${productId}`))
  await nameEditor.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await saveName).status()).toBe(200)
  await expect(page.getByRole('link', { name: /North Cliff Cabin/ })).toBeVisible()
  const scoped = await request.get(`/api/dashboard/catalog?org=${slug}&kind=stay&location_id=${location.id}`)
  await expectStatus(scoped, 200)
  expect(await scoped.json()).toMatchObject({ screen: { rows: [{ id: productId, label: 'North Cliff Cabin' }] } })
  // The guest page is the one the editor previews, without the preview token.
  await page.goto(`/dashboard/${slug}/products/${productId}`)
  await previewLink.click()
  await expect(previewModal).toBeVisible()
  const previewURL = new URL((await previewIframe.getAttribute('src'))!, baseURL!)
  previewURL.searchParams.delete('preview_token')
  await previewModal.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(previewModal).not.toBeVisible()

  // Visibility and accepting bookings are separate writes. A real nightly
  // price makes this home publishable without changing the earlier unpriced proof.
  await page.goto(`/dashboard/${slug}/products/${productId}/price`)
  // A price typed before hydration never reaches the form, and Save stays disabled.
  await waitForNuxtHydration(page)
  const nightlyPrice = page.locator('#dashboard-panel-product-price')
  await nightlyPrice.getByRole('textbox', { name: 'Per night (THB)', exact: true }).fill('150')
  const priceSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/editor/organizations/${organizationId}/products/${productId}`)
  await nightlyPrice.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await priceSaved).status()).toBe(200)
  await expect(page).toHaveURL(url => url.pathname.endsWith(`/products/${productId}`))
  const policySaved = await request.patch(`${baseURL}/api/editor/organizations/${organizationId}/products/${productId}`, { data: { stay: { cancellation_policy: 'flexible' } } })
  await expectStatus(policySaved, 200)
  const pricedProduct = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(pricedProduct.error).toBeNull()
  expect(pricedProduct.data!.product.variants[0]!.prices).toContainEqual(expect.objectContaining({ unit_amount: 150_00, currency: 'THB' }))
  expect(pricedProduct.data!.product.active).toBe(true)
  expect(pricedProduct.data!.product.stay!.cancellation_policy).toBe('flexible')
  expect(pricedProduct.data!.product.publications.find(item => item.organization_id === organizationId)!.published).toBe(false)
  const publicationPath = `/dashboard/${slug}/products/${productId}/publication`
  const publicationEndpoint = `/api/editor/organizations/${organizationId}/products/${productId}/publication`
  // Guests see who looks after a home, so it is listed only with a host whose profile is published.
  const hostless = await request.put(`${baseURL}${publicationEndpoint}`, { data: { published: true } })
  await expectStatus(hostless, 409)
  expect((await hostless.json()).data).toEqual({ code: 'HOST_REQUIRED', field: 'host' })
  const unlisted = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(unlisted.data!.product.publications.find(item => item.organization_id === organizationId)!.published).toBe(false)
  // The organization is this test's own, so the host's published profile is left with it.
  const host = await publishOwnHostProfile(request, baseURL!, organizationId, 'Cliff Cabin host')
  const members = await call<{ members: Array<{ id: string; user: { id: string } }> }>('list_organization_members', {})
  expect(members.error).toBeNull()
  const membership = members.data!.members.find(member => member.id === host.memberId)!
  expect(membership.user.id).not.toBe(membership.id)
  const userIdAssignment = await call('update_product', { product_id: productId, stay: { assigned_member_id: membership.user.id } })
  expect(JSON.parse(userIdAssignment.error!)).toMatchObject({ status: 422, code: 'INVALID_RESPONSIBILITY', message: 'The responsible member must belong to this organization' })
  const unchangedAssignment = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${productId}`)
  await expectStatus(unchangedAssignment, 200)
  expect((await unchangedAssignment.json()).product.stay).toMatchObject({ assigned_member_id: ownerMemberId })
  const hosted = await call<{ product: Product }>('update_product', { product_id: productId, stay: { assigned_member_id: host.memberId } })
  expect(hosted.error).toBeNull()
  expect(hosted.data!.product.stay).toMatchObject({ assigned_member_id: host.memberId })
  const productEndpoint = `/api/editor/organizations/${organizationId}/products/${productId}`
  const activationHandoff = { status: 409, code: 'HOME_ACTIVATION_REQUIRES_DASHBOARD', operation_completed: false, action_required: true, dashboard_url: `${baseURL}/dashboard/${slug}/products` }
  const unpublishedNativeRead = await request.get(`${baseURL}${productEndpoint}`)
  await expectStatus(unpublishedNativeRead, 200)
  const unpublishedNative = (await unpublishedNativeRead.json() as { product: Product }).product
  const refusedPublication = await call('set_product_publication', { product_id: productId, published: true })
  expect(refusedPublication.data).toBeNull()
  expect(JSON.parse(refusedPublication.error!)).toMatchObject(activationHandoff)
  const unchangedPublication = await request.get(`${baseURL}${productEndpoint}`)
  await expectStatus(unchangedPublication, 200)
  expect((await unchangedPublication.json()).product).toEqual(unpublishedNative)
  const publicationBodies: unknown[] = []
  const availabilityBodies: unknown[] = []
  page.on('request', outgoing => {
    const path = new URL(outgoing.url()).pathname
    if (path === publicationEndpoint && outgoing.method() === 'PUT') publicationBodies.push(outgoing.postDataJSON())
    if (path === productEndpoint && outgoing.method() === 'PATCH') availabilityBodies.push(outgoing.postDataJSON())
  })
  await page.goto(`${publicationPath}/visibility`)
  const publicationOverview = page.locator('#dashboard-panel-product-publication')
  const savedVisibility = publicationOverview.getByTestId('editor-card-visibility')
  const visibility = page.locator('#dashboard-panel-product-visibility')
  await expect(savedVisibility).toBeVisible()
  await expect(savedVisibility).toContainText('Publish listing')
  await expect(savedVisibility).toContainText('Show on your website')
  await expect(visibility.getByRole('radio', { name: /^Unlisted/ })).toBeChecked()
  await visibility.getByText('Listed', { exact: true }).click()
  await expect(visibility.getByRole('radio', { name: /^Listed/ })).toBeChecked()
  await expect(savedVisibility).toContainText('Publish listing')
  const interceptVisibility = (url: URL) => url.pathname === publicationEndpoint
  await page.route(interceptVisibility, async route => route.request().method() === 'PUT' ? await route.abort('failed') : await route.continue())
  const interruptedVisibility = page.waitForEvent('requestfailed', outgoing => outgoing.method() === 'PUT' && new URL(outgoing.url()).pathname === publicationEndpoint)
  await visibility.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await interruptedVisibility).failure()).toEqual({ errorText: 'net::ERR_FAILED' })
  await expect(visibility.getByText('Failed to fetch', { exact: false })).toBeVisible()
  await expect(visibility.getByRole('radio', { name: /^Listed/ })).toBeChecked()
  await expect(visibility.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  await expect(savedVisibility).toContainText('Publish listing')
  expect(publicationBodies).toEqual([{ published: true }])
  expect(availabilityBodies).toEqual([])
  const failedVisibility = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(failedVisibility.error).toBeNull()
  expect(failedVisibility.data!.product).toMatchObject({ active: true, name: pricedProduct.data!.product.name, details: pricedProduct.data!.product.details })
  expect(failedVisibility.data!.product.publications.find(item => item.organization_id === organizationId)!.published).toBe(false)
  await page.unroute(interceptVisibility)
  const visibilitySaved = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === publicationEndpoint)
  await visibility.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await visibilitySaved).status()).toBe(200)
  await expect(page).toHaveURL(`${baseURL}${publicationPath}`)
  await expect(savedVisibility).toContainText('Listed · Visible on your website')
  const listedProduct = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(listedProduct.error).toBeNull()
  expect(listedProduct.data!.product).toMatchObject({ active: true, name: pricedProduct.data!.product.name, details: pricedProduct.data!.product.details })
  expect(listedProduct.data!.product.publications.find(item => item.organization_id === organizationId)!.published).toBe(true)
  expect(publicationBodies).toEqual([{ published: true }, { published: true }])
  expect(availabilityBodies).toEqual([])

  // MCP can edit a home but activation is completed through its own dashboard.
  // The independent editor reads prove each refusal leaves the saved home alone.
  const pauseForMcp = await request.patch(`${baseURL}${productEndpoint}`, { headers, data: { active: false } })
  await expectStatus(pauseForMcp, 200)
  const pausedNativeRead = await request.get(`${baseURL}${productEndpoint}`)
  await expectStatus(pausedNativeRead, 200)
  const pausedNative = (await pausedNativeRead.json() as { product: Product }).product
  expect(pausedNative.active).toBe(false)
  expect(pausedNative.publications.find(item => item.organization_id === organizationId)!.published).toBe(true)
  for (const operation of [
    { name: 'update_product', args: { product_id: productId, active: true } },
    { name: 'reconcile_products', args: { products: [{ product_id: productId, name: pausedNative.name, kind: 'stay', active: true }], idempotency_key: `${slug}-refused-home-activation` } },
  ]) {
    const refusedActivation = await call(operation.name, operation.args)
    expect(refusedActivation.data, operation.name).toBeNull()
    expect(JSON.parse(refusedActivation.error!), operation.name).toMatchObject(activationHandoff)
    const unchangedHome = await request.get(`${baseURL}${productEndpoint}`)
    await expectStatus(unchangedHome, 200)
    expect((await unchangedHome.json()).product, operation.name).toEqual(pausedNative)
  }
  const resumeAfterMcp = await request.patch(`${baseURL}${productEndpoint}`, { headers, data: { active: true } })
  await expectStatus(resumeAfterMcp, 200)
  const resumedNative = await request.get(`${baseURL}${productEndpoint}`)
  await expectStatus(resumedNative, 200)
  expect((await resumedNative.json()).product).toMatchObject({ id: productId, active: true })
  const locationEndpoint = `${baseURL}/api/organizations/${organizationId}/locations/${location.id}`
  const pauseLocation = await request.patch(locationEndpoint, { headers, data: { status: 'inactive' } })
  await expectStatus(pauseLocation, 200)
  const inactiveLocationRead = await request.get(locationEndpoint)
  await expectStatus(inactiveLocationRead, 200)
  const inactiveLocation = (await inactiveLocationRead.json()).location
  expect(inactiveLocation.status).toBe('inactive')
  const homeAtInactiveLocationRead = await request.get(`${baseURL}${productEndpoint}`)
  await expectStatus(homeAtInactiveLocationRead, 200)
  const homeAtInactiveLocation = (await homeAtInactiveLocationRead.json()).product
  const refusedLocation = await call('update_location', { location_id: location.id, status: 'active' })
  expect(refusedLocation.data).toBeNull()
  expect(JSON.parse(refusedLocation.error!)).toMatchObject(activationHandoff)
  const unchangedLocation = await request.get(locationEndpoint)
  await expectStatus(unchangedLocation, 200)
  expect((await unchangedLocation.json()).location).toEqual(inactiveLocation)
  const unchangedHomeAtLocation = await request.get(`${baseURL}${productEndpoint}`)
  await expectStatus(unchangedHomeAtLocation, 200)
  expect((await unchangedHomeAtLocation.json()).product).toEqual(homeAtInactiveLocation)
  const resumeLocation = await request.patch(locationEndpoint, { headers, data: { status: 'active' } })
  await expectStatus(resumeLocation, 200)
  const resumedLocationRead = await request.get(locationEndpoint)
  await expectStatus(resumedLocationRead, 200)
  expect((await resumedLocationRead.json()).location).toMatchObject({ id: location.id, status: 'active' })

  const anonymousListing = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const guest = await anonymousListing.newPage()
    const guestResponse = await guest.goto(previewURL.href)
    expect(guestResponse!.status()).toBe(200)
    await expect(guest.getByRole('heading', { name: 'Cliff Cabin', level: 1, exact: true })).toBeVisible()
    await expect(guest.locator('section[aria-label="Meet your host"]').getByText('Cliff Cabin host', { exact: true })).toBeVisible()
    await expect(guest.getByRole('button', { name: 'Check availability', exact: true }).last()).toBeVisible()
    const savedLocation = await call<{ location: { slug: string } }>('get_location', { location_id: location.id })
    expect(savedLocation.error).toBeNull()
    const locationSlug = savedLocation.data!.location.slug
    await expect(guest.locator('header a[href="/locations"], footer a[href="/locations"]')).toHaveCount(0)
    for (const path of ['/locations', `/locations/${locationSlug}`, '/api/public/locations', `/api/public/locations/${locationSlug}`, `/api/public/locations/${locationSlug}/photos`, '/api/public/page?page=locations&datasets=location']) {
      const removed = await readLocalTenant(anonymousListing.request, slug, path)
      await expectStatus(removed, 404)
    }
    const homesIndex = await guest.goto(new URL('/stays', previewURL).href)
    expect(homesIndex!.status()).toBe(200)
    const homeCard = guest.locator(`main article a[href="/stays/${pricedProduct.data!.product.slug}"]`)
    await expect(homeCard.getByRole('heading', { name: 'Cliff Cabin', exact: true })).toBeVisible()
    await expect(homeCard).toContainText(/150(?:\.00)?/)
    await expect(homeCard).not.toContainText('Unavailable')
    await expect(guest.locator('header a[href^="/locations"], footer a[href^="/locations"]')).toHaveCount(0)
    await homeCard.click()
    await expect(guest.getByRole('button', { name: 'Check availability', exact: true }).last()).toBeVisible()
    const sitemap = await readLocalTenant(anonymousListing.request, slug, '/sitemap.xml')
    await expectStatus(sitemap, 200)
    expect(await sitemap.text()).not.toContain('/locations')
    const publicNights = new URL(`/api/public/products/${pricedProduct.data!.product.slug}/availability`, previewURL)
    publicNights.searchParams.set('from', localDay(1))
    publicNights.searchParams.set('to', localDay(4))
    const nightsRead = await readLocalTenant(anonymousListing.request, slug, publicNights)
    await expectStatus(nightsRead, 200)
    const calendar = await nightsRead.json() as PublicStayCalendar
    expect(calendar.home).toMatchObject({ currency: 'THB', min_nights: 2, base_price_minor: 150_00 })
    // The public calendar includes the final departure date beside the nights that can be occupied.
    expect(calendar.nights).toEqual([1, 2, 3, 4].map(offset => expect.objectContaining({ date: localDay(offset), available: true, price_minor: 150_00, min_stay_arrival: 2, closed_to_arrival: false, closed_to_departure: false })))
    const checkIn = calendar.nights[0]!.date
    const checkOut = calendar.nights[2]!.date
    const guestDialog = guest.getByRole('dialog').filter({ has: guest.locator('[data-stay-calendar]') })
    await guest.getByRole('button', { name: 'Check availability', exact: true }).last().click()
    await expect(guestDialog).toBeVisible()
    await guestDialog.locator('input[type="date"]').nth(0).fill(checkIn)
    await guestDialog.locator('input[type="date"]').nth(0).press('Tab')
    const quoted = guest.waitForResponse(response => new URL(response.url()).pathname === `/api/public/products/${pricedProduct.data!.product.slug}/quote` && response.request().method() === 'GET')
    await guestDialog.locator('input[type="date"]').nth(1).fill(checkOut)
    await guestDialog.locator('input[type="date"]').nth(1).press('Tab')
    const quoteRead = await quoted
    await expectStatus(quoteRead, 200)
    const { quote } = await quoteRead.json() as { quote: StayQuote }
    expect(quote).toMatchObject({ product_id: productId, currency: 'THB', check_in_date: checkIn, check_out_date: checkOut, nights: 2, total_minor: 300_00,
      nightly: calendar.nights.slice(0, 2).map(night => ({ date: night.date, price_minor: night.price_minor })) })
    const quotedTotal = new Intl.NumberFormat('en-US', { style: 'currency', currency: quote.currency }).format(quote.total_minor / 100)
    await expect(guestDialog.getByRole('heading', { name: '2 nights', exact: true })).toBeVisible()
    await guestDialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(guestDialog).toBeHidden()
    await expect(guest.getByRole('button', { name: 'THB 300 for 2 nights', exact: true })).toBeVisible()
    await expect(guest.getByRole('button', { name: 'THB 300 for 2 nights', exact: true })).toHaveText('THB 300 for 2 nights')
    await expect(guest.locator('#consultations').getByText('Total', { exact: true })).toHaveCount(0)
    await guest.getByRole('button', { name: 'THB 300 for 2 nights', exact: true }).click()
    const priceDetails = guest.getByRole('dialog').filter({ has: guest.getByRole('heading', { name: 'Price details', exact: true }) })
    await expect.poll(async () => (await priceDetails.boundingBox())!.x).toBeGreaterThan(720)
    await expect(priceDetails.getByText(quotedTotal, { exact: true })).toHaveCount(2)
    await expect(priceDetails.getByText('2 nights x THB 150.00', { exact: true })).toBeVisible()
    await expect(priceDetails.getByText(/discount|monthly payments/i)).toHaveCount(0)
    await priceDetails.getByRole('button', { name: 'Close', exact: true }).click()
    await page.goto(`${publicationPath}/availability`)
    const availability = page.locator('#dashboard-panel-product-availability')
    const acceptBookings = availability.getByRole('switch', { name: 'Accept bookings', exact: true })
    await expect(acceptBookings).toHaveAttribute('aria-checked', 'true')
    await acceptBookings.click()
    await expect(acceptBookings).toHaveAttribute('aria-checked', 'false')
    // Commit through the real server, then fail its response: re-reading an
    // already-saved choice must still leave a visible, actionable retry.
    const availabilityFailure = 'Availability was saved, but its completion response failed.'
    const interceptAvailability = (url: URL) => url.pathname === productEndpoint
    await page.route(interceptAvailability, async route => {
      if (route.request().method() !== 'PATCH') return await route.continue()
      const upstream = await route.fetch()
      await expectStatus(upstream, 200)
      expect((await upstream.json() as { product: Product }).product.active).toBe(false)
      await route.fulfill({ response: upstream, status: 503, json: { error: availabilityFailure, data: { code: 'POST_WRITE_COMPLETION_FAILED', committed: true, product_id: productId, reason: availabilityFailure } } })
    })
    const committedFailure = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productEndpoint)
    await availability.getByRole('button', { name: 'Save', exact: true }).click()
    const failedAvailabilityResponse = await committedFailure
    expect(failedAvailabilityResponse.status()).toBe(503)
    expect(await failedAvailabilityResponse.json()).toMatchObject({ data: { committed: true, reason: availabilityFailure } })
    await expect(availability.getByText(availabilityFailure, { exact: true })).toBeVisible()
    await expect(acceptBookings).toHaveAttribute('aria-checked', 'false')
    await expect(availability.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    const pausedProduct = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(pausedProduct.error).toBeNull()
    expect(pausedProduct.data!.product).toMatchObject({ active: false, name: pricedProduct.data!.product.name, details: pricedProduct.data!.product.details })
    expect(pausedProduct.data!.product.publications.find(item => item.organization_id === organizationId)!.published).toBe(true)
    expect(availabilityBodies).toEqual([{ active: false }])
    await page.unroute(interceptAvailability)
    const availabilitySaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productEndpoint)
    await availability.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await availabilitySaved).status()).toBe(200)
    await expect(page).toHaveURL(`${baseURL}${publicationPath}`)
    expect(availabilityBodies).toEqual([{ active: false }, { active: false }])
    const pausedResponse = await guest.reload()
    expect(pausedResponse!.status()).toBe(200)
    await expect(guest.getByRole('heading', { name: 'Cliff Cabin', level: 1, exact: true })).toBeVisible()
    await expect(guest.getByText('Temporarily unavailable', { exact: true }).last()).toBeVisible()
    await expect(guest.getByRole('button', { name: /^(Check availability|Reserve|Send enquiry)$/ })).toHaveCount(0)
    const pausedRead = await readLocalTenant(anonymousListing.request, slug, previewURL.pathname.replace(/^\/stays\//, '/api/public/stays/'))
    await expectStatus(pausedRead, 200)
    expect((await pausedRead.json() as { product: Product }).product).toMatchObject({ name: 'Cliff Cabin', active: false })

    await page.goto(`${publicationPath}/visibility`)
    await visibility.getByText('Unlisted', { exact: true }).click()
    const hiddenSaved = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === publicationEndpoint)
    await visibility.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await hiddenSaved).status()).toBe(200)
    await expect(page).toHaveURL(`${baseURL}${publicationPath}`)
    await expect(savedVisibility).toContainText('Publish listing')
    await expect(savedVisibility).toContainText('Show on your website')
    const hiddenProduct = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(hiddenProduct.error).toBeNull()
    expect(hiddenProduct.data!.product).toMatchObject({ active: false, name: pricedProduct.data!.product.name, details: pricedProduct.data!.product.details })
    expect(hiddenProduct.data!.product.publications.find(item => item.organization_id === organizationId)!.published).toBe(false)
    const hiddenResponse = await guest.reload()
    expect(hiddenResponse!.status()).toBe(404)
    await expect(guest.getByRole('heading', { name: 'Cliff Cabin', level: 1, exact: true })).toHaveCount(0)
    await page.goto(`${publicationPath}/availability`)
    await availability.getByRole('switch', { name: 'Accept bookings', exact: true }).click()
    const resumed = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productEndpoint)
    await availability.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await resumed).status()).toBe(200)
    await expect(page).toHaveURL(`${baseURL}${publicationPath}`)
    const restoredListing = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(restoredListing.error).toBeNull()
    expect(restoredListing.data!.product.active).toBe(true)
    expect(restoredListing.data!.product.publications.find(item => item.organization_id === organizationId)!.published).toBe(false)
    expect(publicationBodies).toEqual([{ published: true }, { published: true }, { published: false }])
    expect(availabilityBodies).toEqual([{ active: false }, { active: false }, { active: true }])
  } finally {
    await anonymousListing.close()
  }
})
