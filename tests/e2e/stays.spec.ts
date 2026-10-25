import { expect, test, type APIRequestContext, type APIResponse, type Page, type Request, type WebSocket } from '@playwright/test'
import Ajv from 'ajv'
import sharp from 'sharp'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { mcpRequest, publishOwnHostProfile } from './helpers/mcp'
import { openTenantPage, waitForNuxtHydration } from './helpers'
import { isDashboardInvalidation, type DashboardInvalidation } from '../../shared/dashboard-invalidations'
import type { Product } from '../../server/types/products'
import type { GuestStay, PublicStayCalendar, StayDetail, StayQuote } from '../../server/domain/stays'
import { createReplayableReservationCancelToken } from '../../server/utils/reservation-cancel-token'
import type { PostalAddress } from '../../utils/postal-address'
import { STAY_SAFETY_DETAIL_KEYS } from '../../shared/stay-safety'
import type { PublicLocationDisclosure } from '../../types/public-location'
import type { StayPhotoRoom } from '../../shared/stay-photos'
import type { StayHomeAccessibility } from '../../shared/stay-accessibility'

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

async function createStayHome(page: Page, baseURL: string, selectDifferentLocation = false) {
  const request = page.request
  await loginAs(request, baseURL, 'user-e2e-lodging-host')
  const headers = authRequestHeaders(baseURL)
  const slug = `e2e-stays-${crypto.randomUUID().slice(0, 8)}`
  const created = await request.post(`${baseURL}/api/auth/organization/create`, { headers, data: { name: `Stays ${slug}`, slug, default_currency: 'THB', timezone: TIME_ZONE } })
  await expectStatus(created, 200)
  const organizationId = (await created.json() as { id: string }).id
  const provisioned = await request.post(`${baseURL}/api/organizations`, { headers, data: { organizationId, name: `Stays ${slug}`, subdomain: slug, vertical: 'lodging', sourceLocale: 'en' } })
  await expectStatus(provisioned, 200)
  expect((await request.post(`${baseURL}/api/auth/organization/set-active`, { headers, data: { organizationId } })).status()).toBe(200)
  const call = <T>(name: string, args: Record<string, unknown>) => tool<T>(request, baseURL, organizationId, name, args)
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

  // The one Product form keeps the home's title and required stay facts together.
  await page.goto(`/dashboard/${slug}/products/new?kind=stay&location_id=${encodeURIComponent(entryLocation.id)}`)
  await expect(page).toHaveURL(`/dashboard/${slug}/products/new?kind=stay&location_id=${encodeURIComponent(entryLocation.id)}`)
  if (selectDifferentLocation) {
    await page.getByRole('combobox', { name: 'Location*', exact: true }).click()
    await page.getByRole('option', { name: location.title, exact: true }).click()
  }
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Cliff Cabin')
  await page.getByRole('textbox', { name: 'Sleeps' }).fill('4')
  await page.getByRole('textbox', { name: 'Minimum nights' }).fill('2')
  const creation = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/editor/organizations/${organizationId}/products`)
  await page.locator('#dashboard-panel-product').getByRole('button', { name: 'Create place to stay', exact: true }).click()
  const saved = await creation
  await expectStatus(saved, 201)
  const savedProductId = (await saved.json() as { product: { id: string } }).product.id
  await expect(page).toHaveURL(new RegExp(`/dashboard/${slug}/products/(?!new)[^/?]+`))
  expect(new URL(page.url()).searchParams.get('location_id')).toBe(location.id)
  const productId = new URL(page.url()).pathname.split('/')[4]!
  expect(productId).toBe(savedProductId)
  expect(productId).toMatch(/^[0-9a-f-]{36}$/)
  const unknownPropertyFacts = { listing_type: null, total_floors: null, listing_floor: null, year_built: null, property_size: null, property_size_unit: null }
  const home = await call<{ product: { kind: string; unit_label: string; stay: Record<string, unknown> } }>('get_product', { product_id: productId })
  expect(home.error).toBeNull()
  expect(home.data!.product).toMatchObject({ kind: 'stay', unit_label: 'night', stay: { location_id: location.id, check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 2, ...unknownPropertyFacts } })
  const api = (path: string) => `${baseURL}/api/dashboard/${path}${path.includes('?') ? '&' : '?'}org=${encodeURIComponent(slug)}`
  return { request, headers, slug, organizationId, location, homeAddress, call, api, productId, unknownPropertyFacts, home }
}

// The editor's View mode wraps the real guest page in one iframe.
function previewLocators(page: Page) {
  const previewLink = page.locator('#dashboard-panel-product').getByRole('link', { name: 'View', exact: true })
  const previewModal = page.getByRole('dialog', { name: 'Listing preview', exact: true })
  const previewIframe = previewModal.locator('iframe[title="Listing preview"]')
  return { previewLink, previewModal, previewIframe, preview: previewIframe.contentFrame() }
}

test('a host creates a stay and its buyer returns to arrival details, messages, notifications and cancellation', async ({ page, browser, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { request, headers, slug, organizationId, location, call, api, productId } = await createStayHome(page, baseURL!, true)
  await page.setViewportSize({ width: 390, height: 844 })

  const exactAddress: PostalAddress = { regionCode: 'TH', addressLines: ['24 Guest Road'], sublocality: 'Ao Nang', locality: 'Krabi Town', administrativeArea: 'Krabi', postalCode: '81180' }
  const addressSaved = await call('update_location', { location_id: location.id, address: exactAddress })
  expect(addressSaved.error).toBeNull()
  const mapPin = { latitude: 8.0326, longitude: 98.822 }
  const pinSaved = await request.patch(api(`stay-homes/${productId}`), { headers, data: mapPin })
  await expectStatus(pinSaved, 200)

  // A stay arriving today holds its nights; another on them is refused.
  const checkIn = localDay(0)
  const checkOut = localDay(2)
  await page.goto(`/dashboard/${slug}`)
  await page.getByRole('link', { name: 'Add stay', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New stay', exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Home', exact: true }).click()
  await page.getByRole('option', { name: 'Cliff Cabin', exact: true }).click()
  await page.getByLabel('Check-in', { exact: true }).fill(checkIn)
  await page.getByLabel('Checkout', { exact: true }).fill(checkOut)
  await page.getByRole('textbox', { name: 'First name', exact: true }).fill('Ana')
  await page.getByRole('textbox', { name: 'Last name', exact: true }).fill('Silva')
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(`ana-${slug}@playwright.example`)
  await page.getByRole('spinbutton', { name: 'Adults', exact: true }).fill('2')
  await page.getByRole('textbox', { name: 'Stay total (THB)', exact: true }).fill('300')
  const [stayCreated] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/dashboard/stays' && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create stay', exact: true }).click(),
  ])
  await expectStatus(stayCreated, 201)
  const createdReceipt = await stayCreated.json() as { stay: StayDetail & { channel_push: unknown } }
  await expect(page).toHaveURL(new RegExp(`/bookings/stay/${createdReceipt.stay.id}$`))
  const stay = await call<{ stay: StayDetail }>('get_stay', { stay_id: createdReceipt.stay.id })
  expect(stay.error).toBeNull()
  expect(stay.data!.stay).toMatchObject({ product_id: productId, status: 'confirmed', check_in_date: checkIn, check_out_date: checkOut, guest_name: 'Ana', guest_surname: 'Silva', guest_email: `ana-${slug}@playwright.example`, adults: 2, children: 0, infants: 0, total_minor: 300_00, paid_minor: 0, payments: [] })
  const overlap = await call('create_stay', { product_id: productId, check_in_date: localDay(1), check_out_date: localDay(3), adults: 1, guest_name: 'Bo', total_minor: 100_00, idempotency_key: `${slug}-b` })
  expect(overlap.error).toContain('Another stay or a linked calendar already holds one of these nights')

  // Today lists the arrival and opens the stay.
  await page.goto(`/dashboard/${slug}`)
  // Today's card names the guest by first name and the moment: arriving, at the home's check-in time.
  const arrival = page.getByRole('link', { name: /3:00\sPM Ana arrives today with 2 guests/ })
  await expect(arrival).toHaveAttribute('href', `/dashboard/${slug}/bookings/stay/${stay.data!.stay.id}`)
  const [cardTelemetry] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/dashboard/telemetry' && response.request().postDataJSON()?.action === 'today_card_click'), arrival.click()])
  await expectStatus(cardTelemetry, 200)
  expect(new URL(cardTelemetry.url()).searchParams.get('org')).toBe(slug)
  await expect(page.getByRole('heading', { name: 'Ana Silva', level: 2, exact: true })).toBeVisible()

  await page.getByRole('textbox', { name: 'Amount (THB)' }).fill('100')
  await page.getByRole('button', { name: 'Record payment' }).click()
  // The recorded row, not the method picker: it names the amount with its method.
  await expect(page.getByRole('listitem').filter({ hasText: /100\.00 · Cash/ })).toBeVisible()
  const paid = await call<{ stay: StayDetail }>('get_stay', { stay_id: stay.data!.stay.id })
  expect(paid.error).toBeNull()
  expect(paid.data!.stay).toMatchObject({ paid_minor: 100_00, payment_status: 'partial', payments: [{ method: 'cash', amount_minor: 100_00 }] })
  expect(createdReceipt.stay).toMatchObject({ id: paid.data!.stay.id, product_id: productId, request_id: paid.data!.stay.request_id, status: 'confirmed', version: 1, check_in_date: checkIn, check_out_date: checkOut, channel_push: null })
  const messagingContext = await call<{ requestId: string; home: Record<string, unknown>; stay: Record<string, unknown> }>('get_guest_messaging_context', { request_id: paid.data!.stay.request_id })
  expect(messagingContext.error).toBeNull()
  expect(messagingContext.data).toEqual({ requestId: paid.data!.stay.request_id,
    home: { product_id: productId, name: 'Cliff Cabin', timezone: TIME_ZONE, check_in_method: null, check_in_instructions: null, wifi_network: null, wifi_password: null, directions: null, house_manual: null, checkout_instructions: [] },
    stay: { id: paid.data!.stay.id, product_id: productId, status: 'confirmed', check_in_date: checkIn, check_out_date: checkOut, guest_name: paid.data!.stay.guest_name, adults: paid.data!.stay.adults, children: paid.data!.stay.children, infants: paid.data!.stay.infants },
  })
  const selectedStays = await call<{ stays: Array<Record<string, unknown>> }>('list_stays', { product_id: productId, from: checkIn, to: checkOut })
  expect(selectedStays.error).toBeNull()
  expect(selectedStays.data!.stays).toEqual([{ id: paid.data!.stay.id, product_id: productId, channel: 'direct', owner: 'app', status: 'confirmed', overbooked: false, check_in_date: checkIn, check_out_date: checkOut, arrival_time: null, adults: 2, children: 0, infants: 0, guest_name: 'Ana', guest_surname: 'Silva', location_id: location.id, timezone: TIME_ZONE, request_id: paid.data!.stay.request_id, version: 1 }])
  const calendarPath = api(`stay-homes/${productId}/calendar?from=${checkIn}&to=${checkOut}`)
  const beforeInvalidCalendarResponse = await request.get(calendarPath)
  expect(beforeInvalidCalendarResponse.status()).toBe(200)
  const beforeInvalidCalendar = await beforeInvalidCalendarResponse.json()
  for (const fields of [{}, { reset: false }, { reset: true, closed: true }, { reset: true, price_minor: null }]) {
    const refused = await call('set_stay_nights', { product_id: productId, from: checkIn, to: checkOut, ...fields })
    expect(refused.error).toContain('Invalid arguments for tool set_stay_nights')
    const unchanged = await request.get(calendarPath)
    expect(unchanged.status()).toBe(200)
    expect(await unchanged.json()).toEqual(beforeInvalidCalendar)
  }
  const emptyEdit = await call('update_stay', { stay_id: paid.data!.stay.id, expected_version: paid.data!.stay.version })
  expect(emptyEdit.error).toContain('Invalid arguments for tool update_stay')
  const unchangedEdit = await call('update_stay', { stay_id: paid.data!.stay.id, expected_version: paid.data!.stay.version, guest_name: 'Ana' })
  expect(JSON.parse(unchangedEdit.error!)).toMatchObject({ status: 422, code: 'INVALID_STAY_FIELD' })
  const zeroPayment = await call('record_stay_payment', { stay_id: paid.data!.stay.id, amount_minor: 0, method: 'cash', paid_on: checkIn, idempotency_key: `${slug}-zero-payment` })
  expect(zeroPayment.error).toContain('Invalid arguments for tool record_stay_payment')
  type PaymentReceipt = { stay_id: string; payment: Omit<StayDetail['payments'][number], 'created_by'>; currency: string; paid_minor: number; payment_status: string }
  const paymentArgs = { stay_id: paid.data!.stay.id, amount_minor: 5000, method: 'bank_transfer', paid_on: checkIn, reference: 'Contract payment', note: 'Only this payment', idempotency_key: `${slug}-receipt-payment` }
  const recordedPayment = await call<PaymentReceipt>('record_stay_payment', paymentArgs)
  expect(recordedPayment.error).toBeNull()
  const nativePaymentRead = await request.get(api(`stays/${paid.data!.stay.id}`))
  expect(nativePaymentRead.status()).toBe(200)
  const nativePaid = (await nativePaymentRead.json() as { stay: StayDetail }).stay
  const savedPayment = nativePaid.payments.find(payment => payment.id === recordedPayment.data!.payment.id)!
  expect(savedPayment, 'The receipt identifies the actual persisted payment').toBeDefined()
  const { created_by: _paymentActor, ...expectedPayment } = savedPayment
  expect(recordedPayment.data).toEqual({ stay_id: paid.data!.stay.id, payment: expectedPayment, currency: 'THB', paid_minor: 15000, payment_status: 'partial' })
  const paymentReplay = await call<PaymentReceipt>('record_stay_payment', paymentArgs)
  expect(paymentReplay.error).toBeNull()
  expect(paymentReplay.data).toEqual(recordedPayment.data)
  const changedPaymentRetry = await call('record_stay_payment', { ...paymentArgs, note: 'A different note' })
  expect(JSON.parse(changedPaymentRetry.error!)).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' })
  const deletedPayment = await call('delete_stay_payment', { stay_id: paid.data!.stay.id, payment_id: savedPayment.id })
  expect(deletedPayment.error).toBeNull()
  expect(deletedPayment.data).toEqual({ stay_id: paid.data!.stay.id, deleted_payment_id: savedPayment.id, currency: 'THB', paid_minor: 10000, payment_status: 'partial' })
  const restoredPaymentRead = await request.get(api(`stays/${paid.data!.stay.id}`))
  expect(restoredPaymentRead.status()).toBe(200)
  expect((await restoredPaymentRead.json()).stay).toEqual(paid.data!.stay)

  const guide = { check_in_method: 'lockbox', check_in_instructions: 'Use the garden lockbox.', wifi_network: 'Cabin guests', wifi_password: 'private-cabin-wifi', directions: 'Use the east entrance.', house_manual: 'Keep the gate closed.', checkout_instructions: [{ task: 'return_keys', details: 'Leave keys in the box.' }] }
  const savedGuide = await request.patch(api(`stay-homes/${productId}`), { headers, data: guide })
  await expectStatus(savedGuide, 200)
  expect((await call('update_product', { product_id: productId, details: { pets_allowed: false, stairs_required: true, stairs_required_details: 'Two steps at the entrance.' } })).error).toBeNull()

  // The host hands the real conversation to the guest's own signed-in account.
  // Its confirmation link signs the same activity ID the account opens.
  const activityId = paid.data!.stay.request_id
  expect(activityId).toBeTruthy()
  expect(paid.data!.stay.user_id).toBeNull()
  const invited = await request.post(api(`organizations/${organizationId}/guest-threads/${activityId}/invite`), { headers, data: {} })
  await expectStatus(invited, 201)
  const invitation = await invited.json() as { url: string }
  const inviteToken = new URL(invitation.url).pathname.split('/').at(-1)!
  expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const signingSecret = process.env.EMAIL_REPLY_SECRET
  if (!signingSecret) throw new Error('The local receipt signing secret is not configured')
  const signed = await createReplayableReservationCancelToken(signingSecret, activityId!)
  const guest = await browser.newContext()
  try {
    await loginAs(guest.request, baseURL!, 'user-e2e-buyer')
    const claimed = await guest.request.post(`${baseURL}/api/guest-invites/${inviteToken}/claim`, { headers, data: {} })
    await expectStatus(claimed, 200)
    expect(await claimed.json()).toEqual({ thread_id: activityId, path: `/dashboard/account/messages/${activityId}` })
    // A returning buyer enters Personal without being sent to business onboarding.
    await loginAs(guest.request, baseURL!, 'user-e2e-buyer')
    const returnToAccount = await guest.request.get(`${baseURL}/api/post-login`, { maxRedirects: 0 })
    await expectStatus(returnToAccount, 302)
    expect(returnToAccount.headers().location).toBe('/dashboard/account')
    const billingWithoutOrganization = await guest.request.get(`${baseURL}/api/post-login?plan=business`, { maxRedirects: 0 })
    await expectStatus(billingWithoutOrganization, 409)
    const accountApi = `${baseURL}/api/account/stays/${activityId}`
    const receiptApi = `${baseURL}/api/public/guest-stays/${activityId}`
    const receiptHeaders = { 'x-preview-tenant': slug, authorization: `Bearer ${signed.token}` }
    const accountRead = await guest.request.get(accountApi)
    await expectStatus(accountRead, 200)
    const mapUrl = 'https://maps.google.com/maps?q=8.0326%2C98.822'
    const exactLocation = { address: exactAddress, ...mapPin, maps_url: mapUrl }
    expect(await accountRead.json()).toMatchObject({ organization_id: organizationId, stay: { id: stay.data!.stay.id, status: 'confirmed', user_id: 'user-e2e-buyer' }, home: { location: exactLocation, arrival_guide: { product_id: productId, ...guide }, house_rules: ['No pets'] } })
    const receiptRead = await guest.request.get(receiptApi, { headers: receiptHeaders })
    await expectStatus(receiptRead, 200)
    expect(await receiptRead.json()).toMatchObject({ stay: { id: stay.data!.stay.id, status: 'confirmed' }, home: { location: exactLocation, arrival_guide: { product_id: productId, ...guide }, house_rules: ['No pets'] } })

    const receiptPage = await guest.newPage()
    const receiptPageviews: string[] = []
    receiptPage.on('request', outgoing => { if (new URL(outgoing.url()).pathname === '/api/analytics/track') receiptPageviews.push(outgoing.url()) })
    const receiptUrl = new URL('/bookings/stay', baseURL!)
    receiptUrl.searchParams.set('id', activityId!)
    receiptUrl.hash = signed.token
    expect((await openTenantPage(receiptPage, receiptUrl.href, { 'x-preview-tenant': slug }))?.status()).toBe(200)
    await expect(receiptPage.getByText('Your stay at Cliff Cabin is confirmed.', { exact: true })).toBeVisible()
    const receiptHome = receiptPage.getByRole('region', { name: 'Cliff Cabin', exact: true })
    const addressText = '24 Guest Road, Ao Nang, Krabi Town, Krabi, 81180'
    const addressTerm = receiptHome.getByRole('term').filter({ hasText: /^Address$/ })
    await expect(addressTerm).toBeVisible()
    await expect(addressTerm.locator('..').getByRole('definition')).toHaveText(addressText)
    await expect(receiptHome.getByRole('link', { name: 'Open in Maps', exact: true })).toHaveAttribute('href', mapUrl)
    await expect(receiptHome.getByRole('link', { name: 'Message host', exact: true })).toHaveAttribute('href', `${baseURL}/dashboard/account/messages/${activityId}`)
    const accountPage = await guest.newPage()
    const buyerTelemetry: string[] = []
    accountPage.on('request', outgoing => { if (new URL(outgoing.url()).pathname === '/api/dashboard/telemetry') buyerTelemetry.push(outgoing.url()) })
    expect((await accountPage.goto(`${baseURL}/api/post-login`))?.status()).toBe(200)
    await expect(accountPage).toHaveURL(`${baseURL}/dashboard/account`)
    await accountPage.locator(`[data-testid=today-card][href="/dashboard/account/activity/stay/${activityId}"]`).click()
    await expect(accountPage).toHaveURL(`${baseURL}/dashboard/account/activity/stay/${activityId}`)
    await accountPage.goto(`${baseURL}/dashboard/account/calendar?view=list&month=${localDay(1).slice(0, 7)}`)
    await accountPage.locator(`[data-day="${localDay(1)}"] a[href="/dashboard/account/activity/stay/${activityId}"]`).click()
    await expect(accountPage).toHaveURL(`${baseURL}/dashboard/account/activity/stay/${activityId}`)
    const otherMonth = `${checkIn.slice(0, 4)}-${checkIn.slice(5, 7) === '01' ? '02' : '01'}`
    await accountPage.goto(`${baseURL}/dashboard/account/calendar?view=year&month=${otherMonth}`)
    const yearStayDay = accountPage.locator(`button[data-day="${checkIn}"]`).filter({ has: accountPage.locator('span.bg-primary') }).first()
    await yearStayDay.scrollIntoViewIfNeeded()
    await expect(yearStayDay).toBeInViewport()
    await yearStayDay.click()
    await accountPage.locator(`a[href="/dashboard/account/activity/stay/${activityId}"]`).click()
    await expect(accountPage).toHaveURL(`${baseURL}/dashboard/account/activity/stay/${activityId}`)
    const accountHome = accountPage.locator('#dashboard-panel-stay-details')
    await expect(accountHome.getByRole('heading', { name: "Where you'll be", exact: true })).toBeVisible()
    await expect(accountHome.getByText(addressText, { exact: true })).toBeVisible()
    await expect(accountHome.getByRole('link', { name: 'Open in Maps', exact: true })).toHaveAttribute('href', mapUrl)
    for (const guestPage of [receiptPage, accountPage]) {
      for (const width of [1280, 390]) {
        await guestPage.setViewportSize({ width, height: 844 })
        const arrivalGuide = guestPage.locator('[data-stay-arrival-guide]')
        await arrivalGuide.getByText(guide.check_in_instructions, { exact: true }).scrollIntoViewIfNeeded()
        await expect(arrivalGuide.getByText(guide.check_in_instructions, { exact: true })).toBeInViewport()
        await expect(arrivalGuide.getByText(guide.wifi_password, { exact: true })).toBeVisible()
        await expect(arrivalGuide.getByText('No pets', { exact: true })).toBeVisible()
        await expect(arrivalGuide.getByText('Guests must climb stairs\nTwo steps at the entrance.', { exact: true })).toBeVisible()
        await expect(arrivalGuide.getByText('Leave keys in the box.', { exact: true })).toBeVisible()
      }
    }
    await accountPage.getByRole('heading', { name: 'Arrival guide', exact: true }).scrollIntoViewIfNeeded()
    const guideScreenshot = test.info().outputPath('buyer-arrival-guide-mobile.png')
    await accountPage.screenshot({ path: guideScreenshot, fullPage: true })
    await test.info().attach('buyer-arrival-guide-mobile', { path: guideScreenshot, contentType: 'image/png' })
    await accountHome.getByRole('link', { name: 'Message host', exact: true }).click()
    await expect(accountPage).toHaveURL(`${baseURL}/dashboard/account/messages/${activityId}`)
    await accountPage.getByRole('textbox', { name: 'Write a message…', exact: true }).fill('Can I arrive at 4 pm?')
    const [buyerReply] = await Promise.all([accountPage.waitForResponse(response => response.url().includes(`/api/account/messages/${activityId}/reply`) && response.request().method() === 'POST'), accountPage.getByRole('button', { name: 'Send reply', exact: true }).click()])
    await expectStatus(buyerReply, 200)
    await expect(accountPage.locator('#dashboard-panel-account-message-thread').getByText('Can I arrive at 4 pm?', { exact: true })).toBeVisible()
    await page.goto(`/dashboard/${slug}/messages/${activityId}`)
    await expect(page.locator('#dashboard-panel-organization-messages-thread').getByText('Can I arrive at 4 pm?', { exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: 'Write a message…', exact: true }).fill('Yes, the lockbox is ready at 4 pm.')
    const [hostReply] = await Promise.all([page.waitForResponse(response => response.url().includes(`/guest-threads/${activityId}/operations/reply`) && response.request().method() === 'POST'), page.getByRole('button', { name: 'Send reply', exact: true }).click()])
    await expectStatus(hostReply, 200)
    await expect(page.locator('#dashboard-panel-organization-messages-thread').getByText('Yes, the lockbox is ready at 4 pm.', { exact: true })).toBeVisible()
    const alertsRead = await guest.request.get(`${baseURL}/api/dashboard/notifications?scope=personal`)
    await expectStatus(alertsRead, 200)
    const alerts = (await alertsRead.json() as { notifications: Array<{ id: string; template: string; deep_link: string }> }).notifications.filter(alert => alert.template === 'guest_thread_event' && alert.deep_link === `/dashboard/account/messages/${activityId}`)
    expect(alerts).toHaveLength(1)
    await accountPage.goto(`${baseURL}/dashboard/account/notifications`)
    await accountPage.getByTestId(`notification-${alerts[0]!.id}`).click()
    await expect(accountPage).toHaveURL(`${baseURL}/dashboard/account/messages/${activityId}`)
    await expect(accountPage.locator('#dashboard-panel-account-message-thread').getByText('Yes, the lockbox is ready at 4 pm.', { exact: true })).toBeVisible()
    await accountPage.getByRole('link', { name: 'Show stay', exact: true }).click()
    await expect(accountPage).toHaveURL(`${baseURL}/dashboard/account/activity/stay/${activityId}`)
    await page.goto(`/dashboard/${slug}/bookings/stay/${stay.data!.stay.id}`)

    await page.getByRole('button', { name: 'Cancel stay' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel stay' }).click()
    await expect(page.getByText('Cancelled', { exact: true })).toBeVisible()
    const calendar = await call<{ nights: Array<{ date: string; available: boolean }> }>('get_stay_calendar', { product_id: productId, from: checkIn, to: checkOut })
    expect(calendar.data!.nights.map(night => night.available)).toEqual([true, true])
    const cancelled = await call<{ stay: { status: string; cancelled_at: string | null } }>('get_stay', { stay_id: stay.data!.stay.id })
    expect(cancelled.data!.stay.status).toBe('cancelled')
    expect(cancelled.data!.stay.cancelled_at).toBeTruthy()

    // Cancellation withdraws the exact location from both independent reads
    // and from the receipt and account screens that previously displayed it.
    for (const response of await Promise.all([guest.request.get(accountApi), guest.request.get(receiptApi, { headers: receiptHeaders })])) {
      await expectStatus(response, 200)
      const cancelledGuest = await response.json() as GuestStay
      expect(cancelledGuest.stay.status).toBe('cancelled')
      expect(cancelledGuest.home.location).toBeNull()
      expect(cancelledGuest.home.arrival_guide).toBeNull()
      expect(JSON.stringify(cancelledGuest)).not.toContain(guide.wifi_password)
    }
    await Promise.all([receiptPage.reload(), accountPage.reload()])
    await expect(receiptPage.getByRole('heading', { name: 'Booking Cancelled', exact: true })).toBeVisible()
    await expect(accountHome.getByText('Cancelled', { exact: true })).toBeVisible()
    await expect(addressTerm).toHaveCount(0)
    await expect(accountHome.getByRole('heading', { name: "Where you'll be", exact: true })).toHaveCount(0)
    expect(receiptPageviews).toEqual([])
    expect(buyerTelemetry).toEqual([])
    for (const guestPage of [receiptPage, accountPage]) {
      await expect(guestPage.locator('[data-stay-arrival-guide]')).toHaveCount(0)
      await expect(guestPage.getByText(addressText, { exact: true })).toHaveCount(0)
      await expect(guestPage.getByRole('link', { name: 'Open in Maps', exact: true })).toHaveCount(0)
    }
  } finally {
    await guest.close()
  }

  const later = [localDay(10), localDay(13)] as const
  await page.goto(`/dashboard/${slug}/bookings/stay/new?${new URLSearchParams({ product_id: productId, check_in_date: later[0], check_out_date: later[1] })}`)
  await expect(page.getByRole('heading', { name: 'New stay', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Home', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Check-in', { exact: true })).toHaveValue(later[0])
  await expect(page.getByLabel('Checkout', { exact: true })).toHaveValue(later[1])
  await page.getByRole('textbox', { name: 'First name', exact: true }).fill('Kai')
  await page.getByRole('spinbutton', { name: 'Adults', exact: true }).fill('2')
  await page.getByRole('textbox', { name: 'Stay total (THB)', exact: true }).fill('450')
  await page.getByRole('switch', { name: 'Record a payment already received', exact: true }).click()
  await page.getByRole('textbox', { name: 'Amount received (THB)', exact: true }).fill('125')
  await page.getByRole('combobox', { name: 'Method', exact: true }).click()
  await page.getByRole('option', { name: 'Bank transfer', exact: true }).click()
  await page.getByLabel('Date received', { exact: true }).fill(checkIn)
  await page.getByRole('textbox', { name: 'Reference', exact: true }).fill('Deposit on booking')
  const [made] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/dashboard/stays' && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create stay', exact: true }).click(),
  ])
  await expectStatus(made, 201)
  const native = (await made.json() as { stay: { id: string; version: number } }).stay
  await expect(page).toHaveURL(new RegExp(`/bookings/stay/${native.id}$`))
  await expect(page.getByRole('listitem').filter({ hasText: /125\.00 · Bank transfer/ })).toBeVisible()
  const edited = await request.patch(api(`stays/${native.id}`), { headers, data: { expected_version: native.version, guest_name: 'Kai Mendes' } })
  await expectStatus(edited, 200)
  const nativeRead = await call<{ stay: StayDetail }>('get_stay', { stay_id: native.id })
  expect(nativeRead.error).toBeNull()
  expect(nativeRead.data!.stay).toMatchObject({ guest_name: 'Kai Mendes', check_in_date: later[0], check_out_date: later[1], total_minor: 450_00, paid_minor: 125_00, payment_status: 'partial', payments: [{ amount_minor: 125_00, method: 'bank_transfer', paid_on: checkIn, reference: 'Deposit on booking' }] })

  const listed = await request.get(api(`stays?from=${later[0]}&to=${later[1]}`))
  await expectStatus(listed, 200)
  expect((await listed.json() as { stays: Array<{ id: string }> }).stays.map(stay => stay.id)).toEqual([native.id])

  const closedNight = localDay(20)
  const closed = await request.put(api(`stay-homes/${productId}/nights`), { headers, data: { from: closedNight, to: localDay(21), closed: true } })
  await expectStatus(closed, 200)
  const nativeCalendar = await request.get(api(`stay-homes/${productId}/calendar?from=${later[0]}&to=${localDay(21)}`))
  await expectStatus(nativeCalendar, 200)
  const nights = (await nativeCalendar.json() as { nights: Array<{ date: string; available: boolean; stay_id: string | null; closed: boolean }> }).nights
  expect(nights.filter(night => night.stay_id === native.id).map(night => night.date)).toEqual([later[0], localDay(11), localDay(12)])
  expect(nights.find(night => night.date === closedNight)).toMatchObject({ available: false, closed: true })
  const mcpCalendar = await call<{ nights: Array<{ date: string; closed: boolean }> }>('get_stay_calendar', { product_id: productId, from: closedNight, to: localDay(21) })
  expect(mcpCalendar.data!.nights).toEqual([expect.objectContaining({ date: closedNight, closed: true })])
  const cancelledByMcp = await call('cancel_stay', { stay_id: native.id, expected_version: native.version + 1, reason: 'Contract cancellation' })
  expect(cancelledByMcp.error).toBeNull()
  const cancelledRead = await request.get(api(`stays/${native.id}`))
  expect(cancelledRead.status()).toBe(200)
  const savedCancellation = (await cancelledRead.json() as { stay: StayDetail }).stay
  expect(cancelledByMcp.data).toEqual({ stay: { id: native.id, product_id: productId, request_id: savedCancellation.request_id, status: 'cancelled', version: savedCancellation.version, updated_at: savedCancellation.updated_at, check_in_date: later[0], check_out_date: later[1], cancelled_at: savedCancellation.cancelled_at, cancellation_reason: 'Contract cancellation' }, channel_push: null })
})

// What the property journey authors through the UI, and what the description,
// settings, safety and preview journeys each start from through the canonical writer.
const propertyFacts = { property_type_group: 'unique_homes', property_type: 'treehouse', listing_type: 'entire_place', total_floors: 3, listing_floor: 2, year_built: 2019, property_size: 85.5, property_size_unit: 'square_meters' } as const
const listingDescription = 'A peaceful treehouse above the Krabi coast.'
const listingDetails = {
  your_property: 'Two airy floors and a shaded deck overlook the limestone cliffs.',
  guest_access: 'Guests have the whole treehouse and its private garden.',
  interaction_with_guests: 'Your host is available by message throughout your stay.',
  other_details_to_note: 'The treehouse is reached by a flight of outdoor stairs.',
}
const descriptionSections = [
  { section: 'listing-description', label: 'Listing description', value: listingDescription },
  { section: 'your_property', label: 'Your property', value: listingDetails.your_property },
  { section: 'guest_access', label: 'Guest access', value: listingDetails.guest_access },
  { section: 'interaction_with_guests', label: 'Interaction with guests', value: listingDetails.interaction_with_guests },
  { section: 'other_details_to_note', label: 'Other details to note', value: listingDetails.other_details_to_note },
]
const poolDetail = 'The plunge pool beside the deck does not have a fence.'
const specialSafety = 'Supervise children near the stone terrace.'
const monitorDetail = 'A sound-level sensor is mounted in the dining room.'
const stairsDetail = 'There are twelve steps from the street to the front door.'
const considerationPatch = { unsecured_pool: true, unsecured_pool_details: poolDetail, nearby_water: false, nearby_water_details: null, climbing_structures: null, climbing_structures_details: null, unprotected_heights: null, unprotected_heights_details: null, dangerous_animals: null, dangerous_animals_details: null, special_safety_considerations: specialSafety }
const devicePatch = { exterior_security_cameras: false, exterior_security_cameras_details: null, noise_decibel_monitors: true, noise_decibel_monitors_details: monitorDetail, carbon_monoxide_detector_details: null, smoke_detector_details: null }
const propertyInfoPatch = { stairs_required: true, stairs_required_details: stairsDetail, potential_noise: false, potential_noise_details: null, resident_pets: null, resident_pets_details: null, no_property_parking: null, no_property_parking_details: null, shared_spaces: null, shared_spaces_details: null, limited_essentials: null, limited_essentials_details: null, weapons_on_property: null, weapons_on_property_details: null }
const safetyFacts = { unsecured_pool: true, unsecured_pool_details: poolDetail, nearby_water: false, special_safety_considerations: specialSafety, exterior_security_cameras: false, noise_decibel_monitors: true, noise_decibel_monitors_details: monitorDetail, stairs_required: true, stairs_required_details: stairsDetail, potential_noise: false }
const authoredSafetyLines = [`Unsecured pool or hot tub\n${poolDetail}`, specialSafety, 'No exterior security cameras', `Noise decibel monitors\n${monitorDetail}`, `Guests must climb stairs\n${stairsDetail}`]

async function describedStayHome(page: Page, baseURL: string) {
  const home = await createStayHome(page, baseURL)
  const propertySetup = await home.call<{ product: Product }>('update_product', { product_id: home.productId, stay: { ...propertyFacts, amenities: ['dryer', 'wireless_internet'] } })
  expect(propertySetup.error).toBeNull()
  return { ...home, propertySetup, productWritePath: `/api/editor/organizations/${home.organizationId}/products/${home.productId}` }
}

test('a host authors property facts and amenities and previews their saved guest projection', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { request, slug, organizationId, call, productId, unknownPropertyFacts, home } = await createStayHome(page, baseURL!)
  const productWritePath = `/api/editor/organizations/${organizationId}/products/${productId}`
  const propertyPicker = page.locator('#dashboard-panel-product-property-type')
  const propertyGroup = propertyPicker.getByRole('combobox', { name: 'Which is most like your place?', exact: true })
  const propertyType = propertyPicker.getByRole('combobox', { name: 'Property type', exact: true })
  const listingType = propertyPicker.getByRole('combobox', { name: 'Listing type', exact: true })
  const totalFloors = propertyPicker.getByRole('spinbutton', { name: 'How many floors in the building?', exact: true })
  const listingFloor = propertyPicker.getByRole('spinbutton', { name: 'Which floor is the listing on?', exact: true })
  const yearBuilt = propertyPicker.getByRole('spinbutton', { name: 'Year built', exact: true })
  const propertySize = propertyPicker.getByRole('spinbutton', { name: 'Property size', exact: true })
  const sizeUnit = propertyPicker.getByRole('combobox', { name: 'Size unit', exact: true })
  await test.step('property facts survive an interrupted save and save only what the host authored', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/dashboard/${slug}/products`)
    const stayTile = page.getByTestId('catalog-grid').getByTestId(`selector-item-${productId}`)
    await expect(stayTile).toHaveAttribute('href', `/dashboard/${slug}/products/${productId}`)
    await expect(stayTile).toHaveAccessibleName('Cliff Cabin')
    await stayTile.click()
    await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}`)
    await expect(page.locator('#dashboard-panel-product').getByRole('heading', { name: 'Listing editor', exact: true })).toBeVisible()
    await expect(page.getByTestId('editor-card-name')).toContainText('Cliff Cabin')

    // Only authored property facts are saved. Unknowns remain nullable in the
    // editor, domain reads and the real guest projection.
    await page.getByRole('link', { name: /Property type/ }).click()
    await expect(listingType).not.toContainText('Entire place')
    for (const input of [totalFloors, listingFloor, yearBuilt, propertySize]) await expect(input).toHaveValue('')
    await expect(sizeUnit).not.toContainText('Square meters')
    await propertyGroup.click()
    await page.getByRole('option', { name: 'Unique space', exact: true }).click()
    await propertyType.click()
    await page.getByRole('option', { name: 'Treehouse', exact: true }).click()
    await listingType.click()
    await page.getByRole('option', { name: 'Entire place', exact: true }).click()
    await totalFloors.fill('3')
    await listingFloor.fill('2')
    await yearBuilt.fill('2019')
    await propertySize.fill('85.5')
    await sizeUnit.click()
    await page.getByRole('option', { name: 'Square meters', exact: true }).click()
    await totalFloors.fill('1')
    await totalFloors.press('Enter')
    await expect(propertyPicker.getByText('The listing floor cannot exceed the number of floors in the building.', { exact: true })).toBeVisible()
    await expect(propertyPicker.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await expect(totalFloors).toHaveValue('1')
    await expect(listingFloor).toHaveValue('2')
    await totalFloors.fill('3')
    await totalFloors.press('Enter')
    await expect(propertyPicker.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await expect(listingFloor).toHaveValue('2')
    await page.setViewportSize({ width: 1440, height: 900 })
    const savedPropertyCard = page.getByTestId('editor-card-property-type')
    await expect(savedPropertyCard).toBeVisible()
    await expect(savedPropertyCard).toContainText('Choose property type')
    const interceptProperty = (url: URL) => url.pathname === productWritePath
    await page.route(interceptProperty, async route => route.request().method() === 'PATCH' ? await route.abort('failed') : await route.continue())
    const interruptedProperty = page.waitForEvent('requestfailed', outgoing => outgoing.method() === 'PATCH' && new URL(outgoing.url()).pathname === productWritePath)
    await propertyPicker.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await interruptedProperty).failure()).toEqual({ errorText: 'net::ERR_FAILED' })
    await expect(propertyPicker.getByText('Failed to fetch', { exact: false })).toBeVisible()
    await expect(propertyGroup).toContainText('Unique space')
    await expect(propertyType).toContainText('Treehouse')
    await expect(listingType).toContainText('Entire place')
    await expect(totalFloors).toHaveValue('3')
    await expect(listingFloor).toHaveValue('2')
    await expect(yearBuilt).toHaveValue('2019')
    await expect(propertySize).toHaveValue('85.5')
    await expect(sizeUnit).toContainText('Square meters')
    await expect(savedPropertyCard).toBeVisible()
    await expect(savedPropertyCard).toContainText('Choose property type')
    const unwrittenProperty = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(unwrittenProperty.error).toBeNull()
    expect(unwrittenProperty.data!.product.stay).toEqual(home.data!.product.stay)
    await expect(propertyPicker.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await page.unroute(interceptProperty)
    const propertySaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
    await propertyPicker.getByRole('button', { name: 'Save', exact: true }).click()
    const propertyResponse = await propertySaved
    await expectStatus(propertyResponse, 200)
    expect(propertyResponse.request().postDataJSON()).toEqual({ stay: propertyFacts })
    await expect(propertyPicker).not.toBeVisible()
    const savedProperty = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(savedProperty.error).toBeNull()
    expect(savedProperty.data!.product.stay).toMatchObject(propertyFacts)
    const savedHome = await request.get(`/api/dashboard/stay-homes/${productId}`, { params: { org: slug } })
    await expectStatus(savedHome, 200)
    expect((await savedHome.json() as { home: Record<string, unknown> }).home).toMatchObject(propertyFacts)
  })
  await test.step('the amenity picker drafts, searches, removes and discards selections', async () => {
    await page.getByRole('link', { name: /Amenities/ }).click()
    const amenityOverview = page.locator('#dashboard-panel-product-amenities')
    await amenityOverview.getByTestId('list-editor-add').click()
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/amenities/add`))
    const amenityPicker = page.locator('#dashboard-panel-product-amenities-add')
    const dryer = amenityPicker.getByRole('button', { name: 'Dryer', exact: true })
    await dryer.focus()
    await dryer.press('Space')
    await expect(dryer).toHaveAttribute('aria-pressed', 'true')
    await amenityPicker.getByTestId('amenity-categories-bathroom').click()
    await expect(amenityPicker.getByTestId('amenity-categories-bathroom')).toHaveAttribute('aria-pressed', 'true')
    await expect(amenityPicker.getByRole('button', { name: 'Bathtub', exact: true })).toBeVisible()
    await expect(amenityPicker.getByRole('button', { name: 'Wifi', exact: true })).toHaveCount(0)
    await expect(dryer).toHaveCount(0)
    // Search crosses category boundaries while retaining the unsaved selection.
    await amenityPicker.getByRole('button', { name: 'Search amenities', exact: true }).click()
    await amenityPicker.getByRole('searchbox', { name: 'Search amenities', exact: true }).fill('e2e-no-matching-amenity')
    await expect(amenityPicker.getByRole('heading', { name: 'No amenities found', exact: true })).toBeVisible()
    await amenityPicker.getByRole('button', { name: 'Cancel search', exact: true }).click()
    await expect(amenityPicker.getByTestId('amenity-categories-all')).toHaveAttribute('aria-pressed', 'true')
    await expect(dryer).toHaveAttribute('aria-pressed', 'true')
    await amenityPicker.getByRole('button', { name: 'Search amenities', exact: true }).click()
    await amenityPicker.getByRole('searchbox', { name: 'Search amenities', exact: true }).fill('Wifi')
    const wifi = amenityPicker.getByRole('button', { name: 'Wifi', exact: true })
    await expect(wifi).toBeVisible()
    await wifi.click()
    await expect(wifi).toHaveAttribute('aria-pressed', 'true')
    await amenityPicker.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/amenities$`))
    const described = await call<{ product: { stay: { property_type_group: string; property_type: string; amenities: string[] } } }>('get_product', { product_id: productId })
    expect(described.error).toBeNull()
    expect(described.data!.product.stay).toMatchObject({ ...propertyFacts, amenities: ['dryer', 'wireless_internet'] })
    await expect(amenityOverview.getByText('Dryer', { exact: true })).toBeVisible()
    await expect(amenityOverview.getByText('Wifi', { exact: true })).toBeVisible()
    await expect(amenityOverview.getByText('Bathtub', { exact: true })).toHaveCount(0)

    // Editing the selected-only overview can be cancelled without changing saved amenities.
    await amenityOverview.getByTestId('list-editor-toggle').click()
    await amenityOverview.getByRole('button', { name: 'Remove Wifi', exact: true }).click()
    await expect(amenityOverview.getByText('Wifi', { exact: true })).toHaveCount(0)
    await amenityOverview.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(amenityOverview.getByText('Wifi', { exact: true })).toBeVisible()
    const cancelledAmenities = await call<{ product: { stay: { amenities: string[] } } }>('get_product', { product_id: productId })
    expect(cancelledAmenities.error).toBeNull()
    expect(cancelledAmenities.data!.product.stay.amenities).toEqual(['dryer', 'wireless_internet'])

    // Done commits a removal; a subsequent Add starts from that persisted selection.
    await amenityOverview.getByTestId('list-editor-toggle').click()
    await amenityOverview.getByRole('button', { name: 'Remove Wifi', exact: true }).click()
    const removalSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/editor/organizations/${organizationId}/products/${productId}`)
    await amenityOverview.getByTestId('list-editor-toggle').click()
    expect((await removalSaved).status()).toBe(200)
    const removedAmenity = await call<{ product: { stay: { amenities: string[] } } }>('get_product', { product_id: productId })
    expect(removedAmenity.error).toBeNull()
    expect(removedAmenity.data!.product.stay.amenities).toEqual(['dryer'])
    await expect(amenityOverview.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()

    // Removing the last amenity still leaves a way to commit the empty selection.
    await amenityOverview.getByTestId('list-editor-toggle').click()
    await amenityOverview.getByRole('button', { name: 'Remove Dryer', exact: true }).click()
    await expect(amenityOverview.getByRole('button', { name: 'Done', exact: true })).toBeVisible()
    const emptySaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/editor/organizations/${organizationId}/products/${productId}`)
    await amenityOverview.getByRole('button', { name: 'Done', exact: true }).click()
    expect((await emptySaved).status()).toBe(200)
    const emptyAmenities = await call<{ product: { stay: { amenities: string[] } } }>('get_product', { product_id: productId })
    expect(emptyAmenities.error).toBeNull()
    expect(emptyAmenities.data!.product.stay.amenities).toEqual([])
    await expect(amenityOverview.getByRole('heading', { name: 'No amenities added yet', exact: true })).toBeVisible()

    await amenityOverview.getByTestId('list-editor-add').click()
    await expect(dryer).toHaveAttribute('aria-pressed', 'false')
    await expect(wifi).toHaveAttribute('aria-pressed', 'false')
    await dryer.click()
    await wifi.click()
    await amenityPicker.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/amenities$`))
    await expect(amenityPicker).not.toBeVisible()
    await expect(amenityOverview.getByText('Wifi', { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 900 })

    // Desktop Back returns from Add to the selected overview and discards its draft.
    await amenityOverview.getByTestId('list-editor-add').click()
    await expect(amenityPicker).toBeVisible()
    const airConditioning = amenityPicker.getByRole('button', { name: 'Air conditioning', exact: true })
    await expect(airConditioning).toHaveAttribute('aria-pressed', 'false')
    await airConditioning.click()
    await expect(airConditioning).toHaveAttribute('aria-pressed', 'true')
    await amenityOverview.getByRole('link', { name: 'Back', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/amenities$`))
    await expect(amenityPicker).not.toBeVisible()
    await expect(amenityOverview.getByText('Air conditioning', { exact: true })).toHaveCount(0)
    const discardedAmenity = await call<{ product: { stay: { amenities: string[] } } }>('get_product', { product_id: productId })
    expect(discardedAmenity.error).toBeNull()
    expect(discardedAmenity.data!.product.stay.amenities).toEqual(['dryer', 'wireless_internet'])

    const amenitiesCard = page.getByTestId('stay-editor-cards').getByTestId('editor-card-amenities')
    await expect(amenitiesCard).toBeVisible()
    await expect(amenitiesCard).toHaveAttribute('aria-current', 'page')
    await expect(amenitiesCard).toContainText('Dryer')
    await expect(amenitiesCard).toContainText('Wifi')

  })
  await test.step('the guest preview projects the saved property facts', async () => {
    const { previewLink, previewModal, preview } = previewLocators(page)
    await previewLink.click()
    await expect(preview.getByRole('heading', { name: 'Cliff Cabin', level: 1, exact: true })).toBeVisible()
    for (const [label, value] of [['Listing type', 'Entire place'], ['Floors in building', '3'], ['Listing floor', '2'], ['Year built', '2019'], ['Property size', '85.5 m²']] as const) {
      const term = preview.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) })
      await expect(term).toBeVisible()
      await expect(term.locator('..').getByRole('definition')).toHaveText(value)
    }
    const propertySchema = preview.locator('script[type="application/ld+json"]')
    await expect(propertySchema).toHaveCount(1)
    const accommodation = (JSON.parse((await propertySchema.textContent())!) as { '@graph': Array<Record<string, unknown>> })['@graph'].find(node => node['@type'] === 'Accommodation')
    expect(accommodation).toMatchObject({ additionalType: 'EntirePlace', floorSize: { '@type': 'QuantitativeValue', value: 85.5, unitText: 'Square meters' } })
    expect(accommodation!.additionalProperty).toEqual(expect.arrayContaining([
      { '@type': 'PropertyValue', name: 'totalFloors', value: 3 },
      { '@type': 'PropertyValue', name: 'listingFloor', value: 2 },
      { '@type': 'PropertyValue', name: 'yearBuilt', value: 2019 },
    ]))
    await previewModal.getByRole('button', { name: 'Close', exact: true }).click()
  })
  await test.step('clearing optional facts writes explicit nulls that a reload reads back', async () => {
    // year or area, and a reload reads that absence.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/dashboard/${slug}/products/${productId}`)
    await page.getByTestId('editor-card-property-type').click()
    await propertyPicker.getByRole('button', { name: 'Clear optional details', exact: true }).click()
    const propertyCleared = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
    await propertyPicker.getByRole('button', { name: 'Save', exact: true }).click()
    const clearedPropertyResponse = await propertyCleared
    await expectStatus(clearedPropertyResponse, 200)
    expect(clearedPropertyResponse.request().postDataJSON()).toEqual({ stay: { ...propertyFacts, ...unknownPropertyFacts } })
    await expect(propertyPicker).not.toBeVisible()
    const clearedHome = await request.get(`/api/dashboard/stay-homes/${productId}`, { params: { org: slug } })
    await expectStatus(clearedHome, 200)
    expect((await clearedHome.json() as { home: Record<string, unknown> }).home).toMatchObject({ ...propertyFacts, ...unknownPropertyFacts })
    await page.getByTestId('editor-card-property-type').click()
    await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/property-type`)
    await expect(propertyGroup).toBeVisible()
    await page.reload()
    await expect(propertyGroup).toContainText('Unique space')
    await expect(propertyType).toContainText('Treehouse')
    await expect(listingType).not.toContainText('Entire place')
    for (const input of [totalFloors, listingFloor, yearBuilt, propertySize]) await expect(input).toHaveValue('')
    await expect(sizeUnit).not.toContainText('Square meters')
  })
})

test('a host edits each description section through its own leaf and resolves a concurrent edit', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { slug, call, productId, propertySetup, productWritePath } = await describedStayHome(page, baseURL!)
  await page.goto(`/dashboard/${slug}/products/${productId}`)
  await page.getByTestId('editor-card-description').click()
  const descriptionOverview = page.locator('#dashboard-panel-product-description')
  const descriptionSection = page.locator('#dashboard-panel-product-description-section')
  await test.step('a concurrent edit refuses the stale section save until the host reviews it', async () => {
    // Switching a reused section leaf must not carry its uncommitted text into
    // the next section's save.
    await descriptionOverview.getByRole('link', { name: /^Guest access/ }).click()
    await descriptionSection.getByRole('textbox', { name: 'Guest access', exact: true }).fill('Uncommitted access instructions.')
    await descriptionOverview.getByRole('link', { name: /^Your property/ }).click()
    const propertyDescription = descriptionSection.getByRole('textbox', { name: 'Your property', exact: true })
    await propertyDescription.fill(listingDetails.your_property)
    const concurrentProperty = 'A newer description of the property, saved by another editor.'
    const concurrentDescription = await call('update_product', { product_id: productId, details_mode: 'merge', details: { your_property: concurrentProperty } })
    expect(concurrentDescription.error).toBeNull()
    const staleDescriptionSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
    await descriptionSection.getByRole('button', { name: 'Save', exact: true }).click()
    const staleDescriptionResponse = await staleDescriptionSaved
    await expectStatus(staleDescriptionResponse, 409)
    expect(staleDescriptionResponse.request().postDataJSON()).toEqual({ expected_updated_at: propertySetup.data!.product.updated_at, details_mode: 'merge', details: { your_property: listingDetails.your_property } })
    expect(await staleDescriptionResponse.json()).toMatchObject({ data: { code: 'PRODUCT_UPDATE_CONFLICT', field: 'expected_updated_at', product_id: productId } })
    await expect(descriptionSection).toContainText('The product changed while you were editing.')
    await expect(propertyDescription).toHaveValue(listingDetails.your_property)
    await expect(descriptionSection.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    const refusedDescription = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(refusedDescription.error).toBeNull()
    expect(refusedDescription.data!.product.details).toEqual({ ...propertySetup.data!.product.details, your_property: concurrentProperty })
    await descriptionSection.getByRole('button', { name: 'Use saved details', exact: true }).click()
    await expect(propertyDescription).toHaveValue(concurrentProperty)
    await expect(descriptionSection.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await propertyDescription.fill(listingDetails.your_property)
    const reviewedDescriptionSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
    await descriptionSection.getByRole('button', { name: 'Save', exact: true }).click()
    const reviewedDescriptionResponse = await reviewedDescriptionSaved
    await expectStatus(reviewedDescriptionResponse, 200)
    expect(reviewedDescriptionResponse.request().postDataJSON().expected_updated_at).toBe(refusedDescription.data!.product.updated_at)
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/description$`))
    const switchedDescription = await call<{ product: { details: Record<string, unknown> } }>('get_product', { product_id: productId })
    expect(switchedDescription.error).toBeNull()
    expect(switchedDescription.data!.product.details.your_property).toBe(listingDetails.your_property)
    expect(switchedDescription.data!.product.details).not.toHaveProperty('guest_access')
  })
  await test.step('each section saves, reloads and cancels on its own', async () => {
    for (const section of descriptionSections) {
      if (section.section === 'your_property') continue
      await descriptionOverview.getByRole('link', { name: new RegExp(`^${section.label}`) }).click()
      await descriptionSection.getByRole('textbox', { name: section.label, exact: true }).fill(section.value)
      await descriptionSection.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/products/${productId}/description$`))
      await expect(descriptionSection).not.toBeVisible()
      await expect(descriptionOverview.getByRole('link', { name: new RegExp(`^${section.label}`) })).toContainText(section.value)
    }
    await descriptionOverview.getByRole('link', { name: /^Guest access/ }).click()
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/description/guest_access$`))
    await page.reload()
    await expect(descriptionSection.getByRole('textbox', { name: 'Guest access', exact: true })).toHaveValue(listingDetails.guest_access)
    await descriptionSection.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/description$`))
    await descriptionOverview.getByRole('link', { name: /^Your property/ }).click()
    await descriptionSection.getByRole('textbox', { name: 'Your property', exact: true }).fill('An unsaved replacement that must be discarded.')
    await descriptionSection.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/description$`))
    await expect(descriptionOverview.getByRole('link', { name: /^Your property/ })).toContainText(listingDetails.your_property)
    const descriptionRead = await call<{ product: { description: string; details: Record<string, unknown> } }>('get_product', { product_id: productId })
    expect(descriptionRead.error).toBeNull()
    expect(descriptionRead.data!.product.description).toBe(listingDescription)
    expect(descriptionRead.data!.product.details).toMatchObject(listingDetails)
    await expect(descriptionOverview).toBeVisible()
  })
})

test('a host saves cancellation policies, guests, minimum nights and arrival times as separate concerns', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { request, slug, organizationId, location, homeAddress, call, api, productId } = await describedStayHome(page, baseURL!)
  expect((await call('update_product', { product_id: productId, description: listingDescription })).error).toBeNull()
  await page.goto(`/dashboard/${slug}/products/${productId}`)
  await test.step('the two cancellation periods keep their own policy', async () => {
    // The two cancellation periods retain their own policy. Reading more about
    // another policy does not select it, and cancelling an edit changes neither.
    await page.getByTestId('editor-card-cancellation').click()
    const cancellationOverview = page.locator('#dashboard-panel-product-cancellation')
    const cancellationPolicy = page.locator('#dashboard-panel-product-cancellation-policy')
    await cancellationOverview.getByRole('link', { name: /^Short-term stays/ }).click()
    await cancellationPolicy.getByText('Flexible', { exact: true }).click()
    const moderateInfo = cancellationPolicy.getByRole('button', { name: 'More about Moderate', exact: true })
    await moderateInfo.click()
    await expect(moderateInfo).toHaveAttribute('aria-expanded', 'true')
    await expect(cancellationPolicy.getByRole('radio', { name: /^Flexible/ })).toBeChecked()
    await expect(cancellationPolicy.getByRole('radio', { name: /^Moderate/ })).not.toBeChecked()
    await page.keyboard.press('Escape')
    await cancellationPolicy.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/cancellation$`))
    await cancellationOverview.getByRole('link', { name: /^Long-term stays/ }).click()
    await cancellationPolicy.getByText('Firm Long Term', { exact: true }).click()
    await cancellationPolicy.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/cancellation$`))
    await expect(cancellationOverview.getByRole('link', { name: /^Short-term stays/ })).toContainText('Flexible')
    await expect(cancellationOverview.getByRole('link', { name: /^Long-term stays/ })).toContainText('Firm Long Term')
    await cancellationOverview.getByRole('link', { name: /^Short-term stays/ }).click()
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/cancellation/standard$`))
    await page.reload()
    await expect(cancellationPolicy.getByRole('radio', { name: /^Flexible/ })).toBeChecked()
    await expect(cancellationPolicy).toBeVisible()
    await cancellationPolicy.getByText('Moderate', { exact: true }).click()
    await cancellationPolicy.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/cancellation$`))
    const policiesRead = await call<{ product: { stay: { cancellation_policy: string; long_term_cancellation_policy: string } } }>('get_product', { product_id: productId })
    expect(policiesRead.error).toBeNull()
    expect(policiesRead.data!.product.stay).toMatchObject({ cancellation_policy: 'flexible', long_term_cancellation_policy: 'firm' })
    await expect(cancellationOverview).toBeVisible()
  })
  const settingsRead = await test.step('each saved setting preserves the others', async () => {
    // Saved settings are separate concerns; each save preserves the other
    // concerns and a cancelled capacity edit restores the loaded value.
    await page.getByTestId('editor-card-guests').click()
    const guestsPanel = page.locator('#dashboard-panel-product-guests')
    await guestsPanel.getByRole('spinbutton', { name: 'Guests', exact: true }).fill('6')
    await guestsPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(guestsPanel).not.toBeVisible()
    await page.getByTestId('editor-card-guests').click()
    await expect(page).toHaveURL(new RegExp(`/products/${productId}/guests$`))
    await page.reload()
    await expect(guestsPanel.getByRole('spinbutton', { name: 'Guests', exact: true })).toHaveValue('6')
    await expect(guestsPanel).toBeVisible()
    await guestsPanel.getByRole('spinbutton', { name: 'Guests', exact: true }).fill('9')
    await guestsPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(guestsPanel).not.toBeVisible()
    await page.getByTestId('editor-card-availability').click()
    const availabilityPanel = page.locator('#dashboard-panel-product-stay-availability')
    await availabilityPanel.getByRole('spinbutton', { name: 'Minimum nights', exact: true }).fill('1')
    await availabilityPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(availabilityPanel).not.toBeVisible()
    await page.getByTestId('editor-card-availability').click()
    await expect(availabilityPanel.getByRole('spinbutton', { name: 'Minimum nights', exact: true })).toHaveValue('1')
    await expect(availabilityPanel).toBeVisible()
    await availabilityPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(availabilityPanel).not.toBeVisible()
    await page.getByRole('tab', { name: 'Arrival guide', exact: true }).click()
    const arrivalPanel = page.locator('#dashboard-panel-product-arrival-time')
    await arrivalPanel.getByLabel(/^Start time/).fill('16:00')
    await arrivalPanel.getByLabel(/^Time/).fill('10:00')
    const arrivalSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/editor/organizations/${organizationId}/products/${productId}`)
    await arrivalPanel.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await arrivalSaved).status()).toBe(200)
    await expect(arrivalPanel.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
    await expect(page).toHaveURL(url => url.pathname.endsWith(`/products/${productId}/arrival-time`) && url.searchParams.get('guide') === 'arrival')
    await page.reload()
    await expect(arrivalPanel.getByLabel(/^Start time/)).toHaveValue('16:00')
    await expect(arrivalPanel.getByLabel(/^Time/)).toHaveValue('10:00')
    await expect(arrivalPanel).toBeVisible()
    await arrivalPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('tab', { name: 'Your space', exact: true }).click()
    await expect(page).toHaveURL(url => url.pathname.endsWith(`/products/${productId}/photo`) && !url.searchParams.has('guide'))
    await expect(page.getByRole('tab', { name: 'Your space', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'Arrival guide', exact: true })).toHaveAttribute('aria-selected', 'false')
    await expect(arrivalPanel).not.toBeVisible()
    const settingsRead = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(settingsRead.error).toBeNull()
    expect(settingsRead.data!.product).toMatchObject({ description: listingDescription, stay: {
      ...propertyFacts,
      check_in_time: '16:00', check_out_time: '10:00', max_guests: 6, min_nights: 1,
      amenities: ['dryer', 'wireless_internet'], cancellation_policy: 'flexible', long_term_cancellation_policy: 'firm',
    } })
    return settingsRead
  })
  await test.step('the native home projection carries the editor choices', async () => {
    // The editor's listing choices persist through the native home projection.
    const homes = await request.get(api('stay-homes'))
    await expectStatus(homes, 200)
    // The editor created the home without a nightly price, so it has no base price; its currency is the organization's.
    expect((await homes.json() as { homes: unknown[] }).homes).toEqual([{
      product_id: productId, product_updated_at: settingsRead.data!.product.updated_at, name: 'Cliff Cabin', location_id: location.id, timezone: TIME_ZONE, currency: 'THB', base_price_minor: null, base_price_tax_behavior: null,
      // A home the editor creates has a flexible check-in end until the host chooses one.
      check_in_time: '16:00', check_in_end_time: null, check_out_time: '10:00', max_guests: 6, min_nights: 1, assigned_member_id: null, assigned_team_id: null, channel: null,
      check_in_instructions: null, photos: [], photo_rooms: [],
      // The editor's listing choices persist through the native home projection too.
      description: listingDescription, published: false, live: false, airbnb_listing_id: null, airbnb_editor_url: null, address: homeAddress, latitude: null, longitude: null, stay_map_sharing: 'general',
      ...propertyFacts, bedrooms: null, beds: null, bathrooms: null, amenities: ['dryer', 'wireless_internet'], cancellation_policy: 'flexible', long_term_cancellation_policy: 'firm',
      amenity_answers: [{ code: 'dryer', available: true }, { code: 'wireless_internet', available: true }],
      carbon_monoxide_detector_details: null, smoke_detector_details: null,
      accessibility: [
        { feature: 'disabled_parking_spot', available: null, photo_ids: [] },
        { feature: 'path_to_entrance_lit_at_night', available: null, photo_ids: [] },
        { feature: 'home_step_free_access', available: null, photo_ids: [] },
        { feature: 'home_wide_doorway', available: null, photo_ids: [] },
        { feature: 'pool_hoist', available: null, photo_ids: [] },
        { feature: 'ceiling_hoist', available: null, photo_ids: [] },
      ],
      check_in_method: null, wifi_network: null, wifi_password: null, directions: null, house_manual: null, checkout_instructions: [],
    }])
  })
})

test('a host answers guest safety disclosures and keeps an unanswered choice distinct from No', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { slug, organizationId, call, productId, productWritePath } = await describedStayHome(page, baseURL!)
  await page.goto(`/dashboard/${slug}/products/${productId}`)
  const safetyBefore = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(safetyBefore.error).toBeNull()
  for (const key of STAY_SAFETY_DETAIL_KEYS) expect(safetyBefore.data!.product.details).not.toHaveProperty(key)
  await page.getByTestId('editor-card-guest-safety').click()
  const safetyIndex = page.locator('#dashboard-panel-product-guest-safety')
  const considerationsLink = safetyIndex.getByRole('link', { name: /^Safety considerations/ })
  const devicesLink = safetyIndex.getByRole('link', { name: /^Safety devices/ })
  const propertyInfoLink = safetyIndex.getByRole('link', { name: /^Property info/ })
  await expect(safetyIndex.locator('a[href*="/guest-safety/"]')).toHaveCount(3)
  expect(await safetyIndex.locator('a[href*="/guest-safety/"]').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(['considerations', 'devices', 'property-info'].map(section => `/dashboard/${slug}/products/${productId}/guest-safety/${section}`))
  const savedConsiderations = await considerationsLink.innerText()
  const safetySection = page.locator('#dashboard-panel-product-guest-safety-section')
  const pool = safetySection.getByRole('group', { name: 'Unsecured pool or hot tub', exact: true })
  const poolYes = pool.getByRole('button', { name: 'Yes', exact: true })
  const safetyDetail = page.locator('#dashboard-panel-product-guest-safety-detail')
  await test.step('nested detail editors change only the draft, and Cancel writes nothing', async () => {
    await considerationsLink.click()
    for (const name of ['Unsecured pool or hot tub', 'Nearby water', 'Climbing or play structures', 'Unprotected heights', 'Potentially dangerous animals']) {
      const group = safetySection.getByRole('group', { name, exact: true })
      await expect(group.getByRole('button', { name: 'Yes', exact: true })).toHaveAttribute('aria-pressed', 'false')
      await expect(group.getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'false')
    }
    const safetyDraftRequests: string[] = []
    const trackSafetyDraft = (outgoing: Request) => {
      if (new URL(outgoing.url()).pathname === productWritePath && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(outgoing.method())) safetyDraftRequests.push(outgoing.url())
    }
    page.on('request', trackSafetyDraft)
    await poolYes.focus()
    await poolYes.press('Space')
    await expect(poolYes).toHaveAttribute('aria-pressed', 'true')
    await poolYes.press('Space')
    await expect(poolYes).toHaveAttribute('aria-pressed', 'false')
    await poolYes.press('Space')
    await safetySection.getByRole('link', { name: 'Unsecured pool or hot tub details', exact: true }).click()
    await safetyDetail.getByRole('textbox', { name: 'Unsecured pool or hot tub', exact: true }).fill(poolDetail)
    await safetyDetail.getByRole('button', { name: 'Continue', exact: true }).click()
    await safetySection.getByRole('link', { name: 'Unsecured pool or hot tub details', exact: true }).click()
    await safetyDetail.getByRole('textbox', { name: 'Unsecured pool or hot tub', exact: true }).fill('Discard this local replacement.')
    await safetyDetail.getByRole('button', { name: 'Cancel', exact: true }).click()
    await safetySection.getByRole('link', { name: 'Unsecured pool or hot tub details', exact: true }).click()
    await expect(safetyDetail.getByRole('textbox', { name: 'Unsecured pool or hot tub', exact: true })).toHaveValue(poolDetail)
    await safetyDetail.getByRole('button', { name: 'Continue', exact: true }).click()
    await safetySection.getByRole('group', { name: 'Nearby water', exact: true }).getByRole('button', { name: 'No', exact: true }).click()
    await safetySection.getByRole('link', { name: /^Special safety considerations/ }).click()
    await safetyDetail.getByRole('textbox', { name: 'Special safety considerations', exact: true }).fill(specialSafety)
    await safetyDetail.getByRole('button', { name: 'Continue', exact: true }).click()
    await safetySection.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/guest-safety`)
    expect(safetyDraftRequests).toEqual([])
    page.off('request', trackSafetyDraft)
    const cancelledSafety = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(cancelledSafety.error).toBeNull()
    expect(cancelledSafety.data!.product.details).toEqual(safetyBefore.data!.product.details)
  })
  await test.step('an interrupted save keeps the draft, and the retry writes only the considerations', async () => {
    await considerationsLink.click()
    await expect(poolYes).toHaveAttribute('aria-pressed', 'false')
    await poolYes.click()
    await safetySection.getByRole('group', { name: 'Nearby water', exact: true }).getByRole('button', { name: 'No', exact: true }).click()
    for (const [link, label, value] of [['Unsecured pool or hot tub details', 'Unsecured pool or hot tub', poolDetail], ['Special safety considerations', 'Special safety considerations', specialSafety]] as const) {
      await safetySection.getByRole('link', { name: new RegExp(`^${link}`) }).click()
      await safetyDetail.getByRole('textbox', { name: label, exact: true }).fill(value)
      await safetyDetail.getByRole('button', { name: 'Continue', exact: true }).click()
    }
    const newerSafetyFact = await call('update_product', { product_id: productId, details_mode: 'merge', details: { featured: true } })
    expect(newerSafetyFact.error).toBeNull()
    const interceptSafety = (url: URL) => url.pathname === productWritePath
    await page.route(interceptSafety, async route => route.request().method() === 'PATCH' ? await route.abort('failed') : await route.continue())
    const interruptedSafety = page.waitForEvent('requestfailed', outgoing => outgoing.method() === 'PATCH' && new URL(outgoing.url()).pathname === productWritePath)
    await safetySection.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await interruptedSafety).failure()).toEqual({ errorText: 'net::ERR_FAILED' })
    await expect(safetySection.getByText('Failed to fetch', { exact: false })).toBeVisible()
    await expect(poolYes).toHaveAttribute('aria-pressed', 'true')
    await expect(safetySection.getByRole('group', { name: 'Nearby water', exact: true }).getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(safetySection.getByText(poolDetail, { exact: true })).toBeVisible()
    await expect(safetySection.getByText(specialSafety, { exact: true })).toBeVisible()
    await expect(safetySection.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await expect.poll(() => considerationsLink.innerText()).toBe(savedConsiderations)
    const failedSafety = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(failedSafety.error).toBeNull()
    expect(failedSafety.data!.product.details).toEqual({ ...safetyBefore.data!.product.details, featured: true })
    await page.unroute(interceptSafety)
    const considerationsSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
    await safetySection.getByRole('button', { name: 'Save', exact: true }).click()
    const considerationsResponse = await considerationsSaved
    await expectStatus(considerationsResponse, 200)
    expect(considerationsResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: considerationPatch })
    await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/guest-safety`)
  })
  await test.step('devices and property info save, clear and restore their own facts', async () => {
    await devicesLink.click()
    for (const alarm of ['Smoke alarm', 'Carbon monoxide alarm']) {
      const choice = safetySection.getByRole('group', { name: alarm, exact: true })
      for (const answer of ['No', 'Yes']) await expect(choice.getByRole('button', { name: answer, exact: true })).toHaveAttribute('aria-pressed', 'false')
    }
    for (const name of ['Exterior security cameras', 'Noise decibel monitors']) {
      await expect(safetySection.getByRole('group', { name, exact: true }).getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'false')
      await safetySection.getByRole('group', { name, exact: true }).getByRole('button', { name: 'Yes', exact: true }).click()
      await safetySection.getByRole('link', { name: `${name} details`, exact: true }).click()
      await safetyDetail.getByRole('textbox', { name, exact: true }).fill(name === 'Exterior security cameras' ? 'This draft camera detail must be cleared by No.' : monitorDetail)
      await safetyDetail.getByRole('button', { name: 'Continue', exact: true }).click()
    }
    await safetySection.getByRole('group', { name: 'Exterior security cameras', exact: true }).getByRole('button', { name: 'No', exact: true }).click()
    await expect(safetySection.getByRole('link', { name: 'Exterior security cameras details', exact: true })).toHaveCount(0)
    const devicesSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
    await safetySection.getByRole('button', { name: 'Save', exact: true }).click()
    const devicesResponse = await devicesSaved
    await expectStatus(devicesResponse, 200)
    expect(devicesResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: devicePatch, stay: { amenity_answers: [] } })
    await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/guest-safety`)
    await propertyInfoLink.click()
    const stairsYes = safetySection.getByRole('group', { name: 'Guests must climb stairs', exact: true }).getByRole('button', { name: 'Yes', exact: true })
    await stairsYes.click()
    await safetySection.getByRole('group', { name: 'Potential noise during stays', exact: true }).getByRole('button', { name: 'No', exact: true }).click()
    await safetySection.getByRole('link', { name: 'Guests must climb stairs details', exact: true }).click()
    await safetyDetail.getByRole('textbox', { name: 'Guests must climb stairs', exact: true }).fill(stairsDetail)
    await safetyDetail.getByRole('button', { name: 'Continue', exact: true }).click()
    const propertyInfoSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
    await safetySection.getByRole('button', { name: 'Save', exact: true }).click()
    const propertyInfoResponse = await propertyInfoSaved
    await expectStatus(propertyInfoResponse, 200)
    expect(propertyInfoResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: propertyInfoPatch })
    await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/guest-safety`)
    await propertyInfoLink.click()
    await expect(stairsYes).toHaveAttribute('aria-pressed', 'true')
    await stairsYes.click()
    await expect(safetySection.getByRole('link', { name: 'Guests must climb stairs details', exact: true })).toHaveCount(0)
    const stairsCleared = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
    await safetySection.getByRole('button', { name: 'Save', exact: true }).click()
    const stairsClearResponse = await stairsCleared
    await expectStatus(stairsClearResponse, 200)
    expect(stairsClearResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: { ...propertyInfoPatch, stairs_required: null, stairs_required_details: null } })
    const clearedSafety = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(clearedSafety.error).toBeNull()
    expect(clearedSafety.data!.product.details).not.toHaveProperty('stairs_required')
    expect(clearedSafety.data!.product.details).not.toHaveProperty('stairs_required_details')
    await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/guest-safety`)
    await propertyInfoLink.click()
    await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/guest-safety/property-info`)
    await expect(stairsYes).toBeVisible()
    await page.reload()
    await expect(stairsYes).toHaveAttribute('aria-pressed', 'false')
    await expect(safetySection.getByRole('group', { name: 'Guests must climb stairs', exact: true }).getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await stairsYes.click()
    await safetySection.getByRole('link', { name: 'Guests must climb stairs details', exact: true }).click()
    await expect(safetyDetail.getByRole('textbox', { name: 'Guests must climb stairs', exact: true })).toHaveValue('')
    await safetyDetail.getByRole('textbox', { name: 'Guests must climb stairs', exact: true }).fill(stairsDetail)
    await safetyDetail.getByRole('button', { name: 'Continue', exact: true }).click()
    const stairsRestored = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
    await safetySection.getByRole('button', { name: 'Save', exact: true }).click()
    const stairsRestoreResponse = await stairsRestored
    await expectStatus(stairsRestoreResponse, 200)
    expect(stairsRestoreResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: propertyInfoPatch })
    await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/guest-safety`)
    await expect(safetySection).toHaveCount(0)
    await expect(safetyIndex).toBeVisible()
    await devicesLink.click()
    await expect(safetySection.getByRole('group', { name: 'Exterior security cameras', exact: true }).getByRole('button', { name: 'No', exact: true })).toBeVisible()
    await expect(safetySection.getByRole('group', { name: 'Exterior security cameras', exact: true }).getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(safetySection.getByRole('group', { name: 'Noise decibel monitors', exact: true }).getByRole('button', { name: 'Yes', exact: true })).toBeVisible()
    await expect(safetySection.getByRole('group', { name: 'Noise decibel monitors', exact: true }).getByRole('button', { name: 'Yes', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await safetySection.getByRole('group', { name: 'Smoke alarm', exact: true }).getByRole('button', { name: 'Yes', exact: true }).click()
    const alarmSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/editor/organizations/${organizationId}/products/${productId}`)
    await safetySection.getByRole('button', { name: 'Save', exact: true }).click()
    const alarmResponse = await alarmSaved
    await expectStatus(alarmResponse, 200)
    expect(alarmResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: devicePatch, stay: { amenity_answers: [{ code: 'smoke_detector', available: true }] } })
    await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/guest-safety`)
  })
  await test.step('saved answers read back on mobile and in the arrival guide', async () => {
    const savedSafety = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(savedSafety.error).toBeNull()
    expect(savedSafety.data!.product.details).toEqual({ ...safetyBefore.data!.product.details, featured: true, ...safetyFacts })
    expect(savedSafety.data!.product.stay!.amenities).toEqual(['dryer', 'wireless_internet', 'smoke_detector'])
    expect(savedSafety.data!.product.stay!.amenity_answers.filter(answer => answer.code === 'smoke_detector' || answer.code === 'carbon_monoxide_detector')).toEqual([{ code: 'smoke_detector', available: true }])
    await expect(safetySection).toHaveCount(0)
    await expect(safetyIndex).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await devicesLink.click()
    await expect(safetySection.getByRole('group', { name: 'Exterior security cameras', exact: true }).getByRole('button', { name: 'No', exact: true })).toBeVisible()
    await expect(safetySection.getByRole('group', { name: 'Exterior security cameras', exact: true }).getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(safetySection.getByRole('group', { name: 'Smoke alarm', exact: true }).getByRole('button', { name: 'Yes', exact: true })).toHaveAttribute('aria-pressed', 'true')
    for (const answer of ['No', 'Yes']) await expect(safetySection.getByRole('group', { name: 'Carbon monoxide alarm', exact: true }).getByRole('button', { name: answer, exact: true })).toHaveAttribute('aria-pressed', 'false')
    await safetySection.getByRole('link', { name: 'Noise decibel monitors details', exact: true }).click()
    await expect(safetyDetail.getByRole('textbox', { name: 'Noise decibel monitors', exact: true })).toBeVisible()
    await expect(safetyDetail.getByRole('textbox', { name: 'Noise decibel monitors', exact: true })).toHaveValue(monitorDetail)
    await safetyDetail.getByRole('button', { name: 'Cancel', exact: true }).click()
    await safetySection.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('tab', { name: 'Arrival guide', exact: true }).click()
    await page.locator('#dashboard-panel-product').getByRole('link', { name: 'View', exact: true }).click()
    const safetyGuidePreview = page.getByRole('dialog', { name: 'Arrival guide', exact: true })
    const safetyGuide = safetyGuidePreview.getByTestId('arrival-guide-preview')
    await expect(safetyGuide).toBeVisible()
    await expect(safetyGuide.getByRole('heading', { name: 'Safety & property', exact: true }).locator('..').getByRole('listitem')).toHaveText([...authoredSafetyLines, 'Smoke alarm'])
    await safetyGuidePreview.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('tab', { name: 'Your space', exact: true }).click()
    await expect(page).toHaveURL(url => url.pathname.endsWith(`/products/${productId}/photo`) && !url.searchParams.has('guide'))
  })
})

test('a stale detail leaf refuses its save after a concurrent safety answer until the host reviews it', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { slug, call, productId, propertySetup, productWritePath } = await describedStayHome(page, baseURL!)
  const safetySeed = await call<{ product: Product }>('update_product', { product_id: productId, details_mode: 'merge', details: { ...safetyFacts, featured: true } })
  expect(safetySeed.error).toBeNull()
  expect(safetySeed.data!.product.details).toEqual({ ...propertySetup.data!.product.details, ...safetyFacts, featured: true })
  await page.goto(`/dashboard/${slug}/products/${productId}/attributes/featured`)
  const featuredEditor = page.locator('#dashboard-panel-product-attribute')
  const featuredSwitch = featuredEditor.getByRole('switch', { name: 'Featured', exact: true })
  await expect(featuredSwitch).toBeChecked()
  await featuredSwitch.click()
  await expect(featuredSwitch).not.toBeChecked()
  await test.step('the stale save is refused, then the reviewed save lands', async () => {
    const concurrentSafety = await call('update_product', { product_id: productId, details_mode: 'merge', details: { dangerous_animals: false } })
    expect(concurrentSafety.error).toBeNull()
    const featuredSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
    await featuredEditor.getByRole('button', { name: 'Save', exact: true }).click()
    const featuredResponse = await featuredSaved
    await expectStatus(featuredResponse, 409)
    expect(featuredResponse.request().postDataJSON().expected_updated_at).toBe(safetySeed.data!.product.updated_at)
    expect(featuredResponse.request().postDataJSON().details_mode).toBe('merge')
    expect(featuredResponse.request().postDataJSON().details).toEqual({ featured: false })
    expect(await featuredResponse.json()).toMatchObject({ data: { code: 'PRODUCT_UPDATE_CONFLICT', field: 'expected_updated_at', product_id: productId } })
    await expect(featuredEditor).toContainText('The product changed while you were editing.')
    await expect(featuredSwitch).not.toBeChecked()
    await expect(featuredEditor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    const refusedAttribute = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(refusedAttribute.error).toBeNull()
    expect(refusedAttribute.data!.product.details).toEqual({ ...propertySetup.data!.product.details, ...safetyFacts, dangerous_animals: false, featured: true })
    await featuredEditor.getByRole('button', { name: 'Use saved details', exact: true }).click()
    await expect(featuredSwitch).toBeChecked()
    await expect(featuredEditor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await featuredSwitch.click()
    const reviewedAttributeSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
    await featuredEditor.getByRole('button', { name: 'Save', exact: true }).click()
    const reviewedAttributeResponse = await reviewedAttributeSaved
    await expectStatus(reviewedAttributeResponse, 200)
    expect(reviewedAttributeResponse.request().postDataJSON().expected_updated_at).toBe(refusedAttribute.data!.product.updated_at)
    await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/photo`)
    const savedAttributeSafety = await call<{ product: Product }>('get_product', { product_id: productId })
    expect(savedAttributeSafety.error).toBeNull()
    expect(savedAttributeSafety.data!.product.details).toEqual({ ...propertySetup.data!.product.details, ...safetyFacts, dangerous_animals: false, featured: false })
  })
})

test('a host previews the saved guest page around an unsaved draft without recording a visit', async ({ page, browser, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { request, slug, location, call, productId } = await describedStayHome(page, baseURL!)
  const pageSeed = await call<{ product: Product }>('update_product', { product_id: productId, description: listingDescription, details_mode: 'merge', details: { ...listingDetails, ...safetyFacts }, stay: { check_in_time: '16:00', check_out_time: '10:00', max_guests: 6, min_nights: 1, cancellation_policy: 'flexible', long_term_cancellation_policy: 'firm', amenity_answers: [{ code: 'smoke_detector', available: true }] } })
  expect(pageSeed.error).toBeNull()
  const titlePath = `/dashboard/${slug}/products/${productId}/name?location_id=${encodeURIComponent(location.id)}`
  await page.goto(titlePath)
  const titlePanel = page.locator('#dashboard-panel-product-name')
  const titleInput = titlePanel.getByRole('textbox', { name: 'Title', exact: true })
  await expect(titleInput).toHaveValue('Cliff Cabin')
  await titleInput.fill('An unsaved cliff cabin title')
  const previewSource = page.url()
  const { previewLink, previewModal, previewIframe, preview } = previewLocators(page)
  // The host previewing their own listing is not a guest visit: the guest page records nothing.
  const previewCollections: string[] = []
  page.on('request', outgoing => {
    const url = new URL(outgoing.url())
    if (outgoing.frame() !== page.mainFrame() && ['/api/analytics/track', '/api/analytics/interactions', '/api/public/conversion-events'].includes(url.pathname)) previewCollections.push(url.pathname)
  })
  const previewURL = await test.step('the listing preview shows marketing details without post-booking rules and safety', async () => {
    await expect(previewLink).toHaveAttribute('href', /editMode=preview/)
    await previewLink.click()
    await expect(page).toHaveURL(url => url.pathname.endsWith(`/products/${productId}/name`) && url.searchParams.get('location_id') === location.id && url.searchParams.get('editMode') === 'preview' && url.searchParams.get('previewViewport') === 'desktop')
    await expect(previewModal).toBeVisible()
    await expect(preview.getByRole('heading', { name: 'Cliff Cabin', level: 1, exact: true })).toBeVisible()
    const previewURL = new URL((await previewIframe.getAttribute('src'))!, baseURL!)
    expect(previewURL.pathname).toMatch(/^\/stays\//)
    expect(previewURL.searchParams.get('preview_token')).toBeTruthy()
    for (const section of descriptionSections) {
      await expect(preview.getByTestId(`stay-description-${section.section}`)).toHaveCount(1)
      await expect(preview.getByTestId(`stay-description-${section.section}`)).toContainText(section.value)
      await expect(preview.getByText(section.value, { exact: true })).toHaveCount(1)
    }
    await expect(preview.locator('article')).toContainText('6 guests')
    await expect(preview.locator('article')).toContainText('Flexible cancellation policy')
    await expect(preview.locator('#things-to-know')).toHaveCount(0)
    const publicRead = await request.get(new URL(previewURL.pathname.replace(/^\/stays\//, '/api/public/stays/'), previewURL).href)
    await expectStatus(publicRead, 200)
    const publicProduct = (await publicRead.json() as { product: { details: Record<string, unknown> } }).product
    expect(publicProduct).toMatchObject({ description: listingDescription, details: listingDetails, stay: {
      ...propertyFacts,
      check_in_time: '16:00', check_out_time: '10:00', max_guests: 6, min_nights: 1,
      cancellation_policy: 'flexible', long_term_cancellation_policy: 'firm',
    } })
    expect(publicProduct.details).toEqual(pageSeed.data!.product.details)
    await expect(preview.getByRole('heading', { name: 'Safety & property', exact: true })).toHaveCount(0)
    for (const line of authoredSafetyLines) await expect(preview.getByText(line, { exact: true })).toHaveCount(0)
    await expect(preview.getByText('This draft camera detail must be cleared by No.', { exact: true })).toHaveCount(0)
    for (const key of ['pets_allowed', 'events_allowed', 'smoking_allowed', 'quiet_hours', 'commercial_photography_allowed', 'quiet_hours_start', 'quiet_hours_end', 'house_rules']) expect(publicProduct.details).not.toHaveProperty(key)
    await expect(preview.getByRole('heading', { name: 'House rules', exact: true })).toHaveCount(0)
    return previewURL
  })
  const mobilePreviewRoute = await test.step('device modes and closing keep the URL-owned mode and the unsaved draft', async () => {
    await previewModal.getByRole('tab', { name: 'Mobile view', exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get('previewViewport') === 'mobile')
    await expect(previewIframe).toHaveJSProperty('clientWidth', 390)
    await expect(previewIframe).toHaveAttribute('src', previewURL.href)
    await previewModal.getByRole('tab', { name: 'Desktop view', exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get('previewViewport') === 'desktop')
    expect(await previewIframe.evaluate(element => element.clientWidth)).toBeGreaterThan(390)
    await previewModal.getByRole('tab', { name: 'Mobile view', exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get('previewViewport') === 'mobile')
    await expect(previewIframe).toHaveJSProperty('clientWidth', 390)
    const mobilePreviewRoute = page.url()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(previewModal.getByRole('tab', { name: 'Desktop view', exact: true, includeHidden: true })).not.toBeVisible()
    await expect(previewModal.getByRole('tab', { name: 'Mobile view', exact: true, includeHidden: true })).not.toBeVisible()
    await expect(preview.getByRole('heading', { name: 'Cliff Cabin', level: 1, exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    expect(await preview.locator('html').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(390)
    await previewModal.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page).toHaveURL(previewSource)
    await expect(previewModal).not.toBeVisible()
    await expect(titleInput).toHaveValue('An unsaved cliff cabin title')
    expect(previewCollections).toEqual([])
    await page.setViewportSize({ width: 1440, height: 900 })
    await previewLink.click()
    await expect(previewModal).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(previewSource)
    await expect(previewModal).not.toBeVisible()
    await expect(titleInput).toHaveValue('An unsaved cliff cabin title')
    await titlePanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    return mobilePreviewRoute
  })
  await test.step('a reload rebuilds the device mode, and the page is hidden without its token', async () => {
    // Direct entry and a reload reconstruct the same device mode from its URL.
    await page.goto(mobilePreviewRoute)
    await page.reload()
    await expect(previewModal).toBeVisible()
    await expect(previewModal.getByRole('tab', { name: 'Mobile view', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(previewIframe).toHaveJSProperty('clientWidth', 390)
    await expect(preview.getByRole('heading', { name: 'Cliff Cabin', level: 1, exact: true })).toBeVisible()
    await previewModal.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page).toHaveURL(previewSource)
    await expect(titleInput).toHaveValue('Cliff Cabin')
    await titlePanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    const anonymous = await browser.newContext()
    try {
      previewURL.searchParams.delete('preview_token')
      const hidden = await anonymous.request.get(previewURL.href)
      expect(hidden.status()).toBe(404)
      expect(await hidden.text()).not.toContain('Cliff Cabin')
    } finally {
      await anonymous.close()
    }
  })
})

test('a host edits the shared lodging location and protects its exact address and pin in every guest projection', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { request, slug, organizationId, location, call, productId } = await createStayHome(page, baseURL!)
  await page.setViewportSize({ width: 1440, height: 900 })
  const productWritePath = `/api/editor/organizations/${organizationId}/products/${productId}`
  // A stay edits its saved Location's one address, even when the catalog has
  // no location scope. Unedited postal lines and language metadata survive.
  const authoredAddress: PostalAddress = { regionCode: 'TH', addressLines: ['12 Test Road', 'Apartment 4', 'East building'], languageCode: 'en', locality: 'Krabi Town', sublocality: 'Ao Nang', administrativeArea: 'Krabi', postalCode: '81180' }
  const addressAuthored = await call('update_location', { location_id: location.id, address: authoredAddress })
  expect(addressAuthored.error).toBeNull()
  const addressBefore = await call<{ location: { id: string; slug: string; updated_at: string; address: PostalAddress | null } }>('get_location', { location_id: location.id })
  expect(addressBefore.error).toBeNull()
  expect(addressBefore.data!.location.address).toEqual(authoredAddress)
  const savedLocationSlug = addressBefore.data!.location.slug
  await page.goto(`/dashboard/${slug}/products/${productId}/location`)
  await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/location`)
  const productLocation = page.locator('#dashboard-panel-product-location')
  const addressLink = productLocation.getByRole('link', { name: /^Address/ })
  await expect(addressLink).toContainText('12 Test Road, Apartment 4, East building, Ao Nang, Krabi Town, Krabi, 81180')
  const locationDescriptions = [
    ['neighborhood_description', 'Neighborhood description', 'A fictional coastal neighborhood beside the mangroves.'],
    ['getting_around', 'Getting around', 'Walk to the village pier or arrange a local taxi.'],
  ] as const
  const locationDescription = page.locator('#dashboard-panel-product-location-description')
  await productLocation.getByRole('link', { name: /^Neighborhood description/ }).click()
  await locationDescription.getByRole('textbox', { name: 'Neighborhood description', exact: true }).fill('An unsaved neighborhood draft')
  await locationDescription.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/location`)
  const cancelledDescription = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(cancelledDescription.error).toBeNull()
  expect(cancelledDescription.data!.product.details).not.toHaveProperty('neighborhood_description')
  for (const [field, label, value] of locationDescriptions) {
    await productLocation.getByRole('link', { name: new RegExp(`^${label}`) }).click()
    await expect(locationDescription.getByRole('textbox', { name: label, exact: true })).toHaveValue('')
    await locationDescription.getByRole('textbox', { name: label, exact: true }).fill(value)
    const textSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
    await locationDescription.getByRole('button', { name: 'Save', exact: true }).click()
    const textResponse = await textSaved
    await expectStatus(textResponse, 200)
    expect(textResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: { [field]: value } })
    await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/location`)
    await expect(productLocation.getByRole('link', { name: new RegExp(`^${label}`) })).toContainText(value)
  }
  const savedDescriptions = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(savedDescriptions.error).toBeNull()
  expect(savedDescriptions.data!.product.details).toMatchObject(Object.fromEntries(locationDescriptions.map(([field, , value]) => [field, value])))
  await productLocation.getByRole('link', { name: /^Scenic views/ }).click()
  const scenicPicker = page.locator('#dashboard-panel-product-amenities-add')
  await expect(page).toHaveURL(url => url.pathname.endsWith(`/products/${productId}/amenities/add`) && url.searchParams.get('amenity_group') === 'scenic_views')
  await expect(scenicPicker.getByTestId('amenity-categories-scenic_views')).toHaveAttribute('aria-pressed', 'true')
  await expect(scenicPicker.getByRole('list').getByRole('button')).toHaveCount(21)
  await scenicPicker.getByRole('button', { name: 'Mountain view', exact: true }).click()
  await expect(scenicPicker.getByRole('button', { name: 'Mountain view', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const scenicSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === productWritePath)
  await scenicPicker.getByRole('button', { name: 'Done', exact: true }).click()
  const scenicResponse = await scenicSaved
  await expectStatus(scenicResponse, 200)
  expect(scenicResponse.request().postDataJSON()).toEqual({ stay: { amenities: ['mountain_view'] } })
  const savedView = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(savedView.error).toBeNull()
  expect(savedView.data!.product.stay!.amenities).toEqual(['mountain_view'])
  await page.goto(`/dashboard/${slug}/products/${productId}/location`)
  await expect(productLocation.getByRole('link', { name: /^Scenic views/ })).toContainText('Mountain view')
  await addressLink.click()
  const addressPanel = page.locator('#dashboard-panel-location-address')
  const streetAddress = addressPanel.getByRole('textbox', { name: 'Street address', exact: true })
  const apartment = addressPanel.getByRole('textbox', { name: 'Apt, suite, unit', exact: true })
  const thirdAddressLine = addressPanel.getByRole('textbox', { name: 'Address line 3', exact: true })
  const addressCity = addressPanel.getByRole('textbox', { name: 'City or town', exact: true })
  const country = addressPanel.getByRole('button', { name: 'Country', exact: true })
  await expect(streetAddress).toHaveValue('12 Test Road')
  await expect(apartment).toHaveValue('Apartment 4')
  await expect(thirdAddressLine).toHaveValue('East building')
  await expect(country).toContainText('Thailand')
  const locationWritePath = `/api/dashboard/locations/${location.id}`
  const addressDraftRequests: string[] = []
  const trackAddressDraft = (outgoing: Request) => {
    if (new URL(outgoing.url()).pathname === locationWritePath && outgoing.method() === 'PATCH') addressDraftRequests.push(outgoing.url())
  }
  page.on('request', trackAddressDraft)
  await addressPanel.getByRole('button', { name: 'Clear address', exact: true }).click()
  await expect(streetAddress).toHaveValue('')
  await expect(addressCity).toHaveValue('')
  await addressPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/location`)
  expect(addressDraftRequests).toEqual([])
  page.off('request', trackAddressDraft)
  const cancelledAddress = await call<{ location: { address: PostalAddress | null } }>('get_location', { location_id: location.id })
  expect(cancelledAddress.error).toBeNull()
  expect(cancelledAddress.data!.location.address).toEqual(authoredAddress)
  await addressLink.click()
  await addressPanel.getByRole('button', { name: 'Clear address', exact: true }).click()
  const clearAddressSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === locationWritePath)
  await addressPanel.getByRole('button', { name: 'Save', exact: true }).click()
  const clearAddressResponse = await clearAddressSaved
  await expectStatus(clearAddressResponse, 200)
  expect(clearAddressResponse.request().postDataJSON()).toEqual({ address: null, expected_updated_at: addressBefore.data!.location.updated_at })
  await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/location`)
  const clearedAddress = await call<{ location: { address: PostalAddress | null } }>('get_location', { location_id: location.id })
  expect(clearedAddress.error).toBeNull()
  expect(clearedAddress.data!.location.address).toBeNull()
  const addressRestored = await call('update_location', { location_id: location.id, address: authoredAddress })
  expect(addressRestored.error).toBeNull()
  await page.reload()
  await addressLink.click()
  await expect(addressCity).toHaveValue('Krabi Town')
  const editAddressVersion = await call<{ location: { updated_at: string } }>('get_location', { location_id: location.id })
  expect(editAddressVersion.error).toBeNull()
  await addressCity.fill('Nong Thale')
  const changedAddress = { ...authoredAddress, locality: 'Nong Thale' }
  const newerLocation = await call('update_location', { location_id: location.id, title: 'Cliff Cabin Location' })
  expect(newerLocation.error).toBeNull()
  const locationAfterRename = await call<{ location: { slug: string; title: string; updated_at: string; address: PostalAddress | null } }>('get_location', { location_id: location.id })
  expect(locationAfterRename.error).toBeNull()
  expect(locationAfterRename.data!.location).toMatchObject({ slug: savedLocationSlug, title: 'Cliff Cabin Location', address: authoredAddress })
  expect(locationAfterRename.data!.location.updated_at).not.toBe(editAddressVersion.data!.location.updated_at)
  const staleAddressSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === locationWritePath)
  await addressPanel.getByRole('button', { name: 'Save', exact: true }).click()
  const staleAddressResponse = await staleAddressSaved
  await expectStatus(staleAddressResponse, 409)
  expect(staleAddressResponse.request().postDataJSON()).toEqual({ address: changedAddress, expected_updated_at: editAddressVersion.data!.location.updated_at })
  await expect(addressPanel.getByText('The location changed since it was read. Reload it and try again.', { exact: false })).toBeVisible()
  await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/location/address`)
  await expect(streetAddress).toHaveValue('12 Test Road')
  await expect(apartment).toHaveValue('Apartment 4')
  await expect(thirdAddressLine).toHaveValue('East building')
  await expect(addressCity).toHaveValue('Nong Thale')
  await expect(country).toContainText('Thailand')
  await expect(addressPanel.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  const rejectedAddress = await call<{ location: { address: PostalAddress | null; slug: string } }>('get_location', { location_id: location.id })
  expect(rejectedAddress.error).toBeNull()
  expect(rejectedAddress.data!.location).toMatchObject({ address: authoredAddress, slug: savedLocationSlug })
  const addressRetried = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === locationWritePath)
  await addressPanel.getByRole('button', { name: 'Save', exact: true }).click()
  const addressRetryResponse = await addressRetried
  await expectStatus(addressRetryResponse, 200)
  expect(addressRetryResponse.request().postDataJSON()).toEqual({ address: changedAddress, expected_updated_at: locationAfterRename.data!.location.updated_at })
  await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/location`)
  await expect(addressPanel).toHaveCount(0)
  await expect(addressLink).toContainText('12 Test Road, Apartment 4, East building, Ao Nang, Nong Thale, Krabi, 81180')
  await expect(page.getByTestId('editor-card-location')).toContainText('Nong Thale')
  const savedAddress = await call<{ location: { address: PostalAddress | null; slug: string } }>('get_location', { location_id: location.id })
  expect(savedAddress.error).toBeNull()
  expect(savedAddress.data!.location.address).toEqual(changedAddress)
  expect(savedAddress.data!.location.slug).toBe(savedLocationSlug)
  const homeAfterAddress = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(homeAfterAddress.error).toBeNull()
  expect(homeAfterAddress.data!.product.stay!.location_id).toBe(location.id)
  await expect(productLocation).toBeVisible()
  await addressLink.click()
  await expect(streetAddress).toHaveValue('12 Test Road')
  await expect(apartment).toHaveValue('Apartment 4')
  await expect(thirdAddressLine).toHaveValue('East building')
  await expect(addressCity).toHaveValue('Nong Thale')
  await addressPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/location`)

  // The canonical Location owns its stored pair. The address form has no
  // coordinate or map-link control; the free guest map reads this saved fact.
  const mapPin = { latitude: 8.0326, longitude: 98.822 }
  const initialPin = await call<{ location: { latitude: number | null; longitude: number | null } }>('get_location', { location_id: location.id })
  expect(initialPin.error).toBeNull()
  expect(initialPin.data!.location).toMatchObject({ latitude: null, longitude: null })
  const pinSaved = await call('update_location', { location_id: location.id, ...mapPin })
  expect(pinSaved.error).toBeNull()
  const savedPin = await call<{ location: { latitude: number | null; longitude: number | null; address: PostalAddress | null } }>('get_location', { location_id: location.id })
  expect(savedPin.error).toBeNull()
  expect(savedPin.data!.location).toMatchObject({ ...mapPin, address: changedAddress })

  // The same saved Location owns its map choice. Draft previews change the
  // point guests would see; Cancel never commits either switch position.
  const sharingLink = productLocation.getByRole('link', { name: /^Location sharing/ })
  await expect(sharingLink).toContainText('Show general location')
  await sharingLink.click()
  const sharingPanel = page.locator('#dashboard-panel-location-sharing')
  const specificLocation = sharingPanel.getByRole('switch', { name: "Show your home's specific location", exact: true })
  await expect(specificLocation).not.toBeChecked()
  const sharingDraftRequests: string[] = []
  const trackSharingDraft = (outgoing: Request) => {
    if (new URL(outgoing.url()).pathname === locationWritePath && outgoing.method() === 'PATCH') sharingDraftRequests.push(outgoing.url())
  }
  page.on('request', trackSharingDraft)
  await specificLocation.click()
  const specificPreview = sharingPanel.locator('iframe[title="Specific location preview"]')
  await expect(specificPreview).toBeVisible()
  expect(new URL((await specificPreview.getAttribute('src'))!).searchParams.get('q')).toBe('8.0326,98.822')
  await expect(sharingPanel.locator('figcaption')).toHaveText('Your listing shows a precise pin. Your street address stays private.')
  await specificLocation.click()
  const generalPreview = sharingPanel.locator('iframe[title="General location preview"]')
  await expect(generalPreview).toBeVisible()
  expect(new URL((await generalPreview.getAttribute('src'))!).searchParams.get('q')).toBe('8.03,98.83')
  await expect(sharingPanel.locator('figcaption')).toHaveText('Your listing shows the approximate area. Your exact pin and street address stay private.')
  await specificLocation.click()
  await expect(specificLocation).toBeChecked()
  await sharingPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/location`)
  page.off('request', trackSharingDraft)
  expect(sharingDraftRequests).toEqual([])
  const cancelledSharing = await call<{ location: { stay_map_sharing: string; updated_at: string } }>('get_location', { location_id: location.id })
  expect(cancelledSharing.error).toBeNull()
  expect(cancelledSharing.data!.location.stay_map_sharing).toBe('general')
  await sharingLink.click()
  await expect(specificLocation).not.toBeChecked()
  await specificLocation.click()
  const specificSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === locationWritePath)
  await sharingPanel.getByRole('button', { name: 'Save', exact: true }).click()
  const specificResponse = await specificSaved
  await expectStatus(specificResponse, 200)
  expect(specificResponse.request().postDataJSON()).toEqual({ stay_map_sharing: 'specific', expected_updated_at: cancelledSharing.data!.location.updated_at })
  await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/location`)
  await expect(sharingLink).toContainText('Show specific location')
  const savedSpecific = await call<{ location: { stay_map_sharing: string; updated_at: string; address: PostalAddress | null } }>('get_location', { location_id: location.id })
  expect(savedSpecific.error).toBeNull()
  expect(savedSpecific.data!.location).toMatchObject({ stay_map_sharing: 'specific', address: changedAddress })
  const { previewLink: sharingView, previewModal: sharingModal, previewIframe: sharingFrame, preview: sharingGuest } = previewLocators(page)
  await sharingView.click()
  await expect(sharingGuest.getByRole('heading', { name: 'Cliff Cabin', level: 1, exact: true })).toBeVisible()
  await expect(sharingGuest.getByText('This map shows the specific location. You’ll receive the street address after your reservation is confirmed.', { exact: true })).toBeVisible()
  await expect(sharingGuest.locator('article')).not.toContainText('12 Test Road')
  const sharingPublicURL = new URL((await sharingFrame.getAttribute('src'))!, baseURL!)
  sharingPublicURL.pathname = sharingPublicURL.pathname.replace(/^\/stays\//, '/api/public/stays/')
  const specificPublic = await request.get(sharingPublicURL.href)
  await expectStatus(specificPublic, 200)
  const specificPublicData = await specificPublic.json() as { location: PublicLocationDisclosure; product: Product }
  expect(specificPublicData.location).toMatchObject({ address: null, maps_url: null, ...mapPin, stay_map_sharing: 'specific', public_area: { approximate: false, center: mapPin } })
  expect(JSON.stringify(specificPublicData)).not.toContain('12 Test Road')
  for (const [field, label, value] of locationDescriptions) {
    expect(specificPublicData.product.details[field]).toBe(value)
    await expect(sharingGuest.getByRole('heading', { name: label, exact: true }).locator('..').getByText(value, { exact: true })).toBeVisible()
  }
  expect(specificPublicData.product.stay!.amenities).toEqual(['mountain_view'])
  await sharingModal.getByRole('button', { name: 'Close', exact: true }).click()
  await sharingLink.click()
  await expect(specificLocation).toBeChecked()
  await specificLocation.click()
  const generalSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === locationWritePath)
  await sharingPanel.getByRole('button', { name: 'Save', exact: true }).click()
  const generalResponse = await generalSaved
  await expectStatus(generalResponse, 200)
  expect(generalResponse.request().postDataJSON()).toEqual({ stay_map_sharing: 'general', expected_updated_at: savedSpecific.data!.location.updated_at })
  await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}/location`)
  await expect(sharingLink).toContainText('Show general location')
  const savedGeneral = await call<{ location: { stay_map_sharing: string; address: PostalAddress | null } }>('get_location', { location_id: location.id })
  expect(savedGeneral.error).toBeNull()
  expect(savedGeneral.data!.location).toMatchObject({ stay_map_sharing: 'general', address: changedAddress })
  const generalPublic = await request.get(sharingPublicURL.href)
  await expectStatus(generalPublic, 200)
  const generalPublicData = await generalPublic.json() as { location: PublicLocationDisclosure }
  expect(generalPublicData.location).toMatchObject({ address: null, maps_url: null, latitude: null, longitude: null, stay_map_sharing: 'general', public_area: { approximate: true } })
  expect(generalPublicData.location.public_area).toMatchObject({ center: { latitude: 8.03, longitude: 98.83 }, radius_meters: 2000 })
  expect(JSON.stringify(generalPublicData)).not.toContain('12 Test Road')
  expect(JSON.stringify(generalPublicData)).not.toContain('8.0326')
  expect(JSON.stringify(generalPublicData)).not.toContain('98.822')
  const generalGuestURL = new URL(sharingPublicURL)
  generalGuestURL.pathname = generalGuestURL.pathname.replace(/^\/api\/public\/stays\//, '/stays/')
  const generalHTML = await request.get(generalGuestURL.href)
  await expectStatus(generalHTML, 200)
  const generalMarkup = await generalHTML.text()
  for (const privateFact of ['12 Test Road', '8.0326', '98.822']) expect(generalMarkup).not.toContain(privateFact)
  expect(generalMarkup).not.toMatch(/"@type"\s*:\s*"GeoCoordinates"/)
  for (const [, , value] of locationDescriptions) expect(generalMarkup).toContain(value)
  await sharingView.click()
  await expect(sharingGuest.getByText('This map shows the approximate area. You’ll receive the exact location and street address after your reservation is confirmed.', { exact: true })).toBeVisible()
  await expect(sharingGuest.locator('article')).not.toContainText('12 Test Road')
  await sharingModal.getByRole('button', { name: 'Close', exact: true }).click()
  await productLocation.getByRole('link', { name: /^Location features/ }).click()
  const locationAmenities = page.locator('#dashboard-panel-product-amenities-add')
  await expect(page).toHaveURL(url => url.pathname.endsWith(`/products/${productId}/amenities/add`) && url.searchParams.get('amenity_group') === 'location')
  await expect(locationAmenities.getByTestId('amenity-categories-location')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#dashboard-panel-product-amenities').getByRole('link', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(url => url.pathname === `/dashboard/${slug}/products/${productId}/amenities`)
  await expect(locationAmenities).toHaveCount(0)

  // The native Location route uses the same form, with the saved slug. An
  // address with its country removed is invalid rather than an implicit clear.
  await page.goto(`/dashboard/${slug}/locations/${savedLocationSlug}/address`)
  await expect(streetAddress).toHaveValue('12 Test Road')
  await expect(apartment).toHaveValue('Apartment 4')
  await expect(thirdAddressLine).toHaveValue('East building')
  await expect(addressCity).toHaveValue('Nong Thale')
  await expect(addressPanel.getByRole('textbox', { name: 'Neighbourhood', exact: true })).toHaveValue('Ao Nang')
  await expect(addressPanel.getByRole('textbox', { name: 'State or territory', exact: true })).toHaveValue('Krabi')
  await expect(addressPanel.getByRole('textbox', { name: 'Postal code', exact: true })).toHaveValue('81180')
  await expect(country).toContainText('Thailand')
  await addressPanel.getByRole('button', { name: 'Clear country', exact: true }).click()
  await expect(addressPanel.getByText('Choose a valid country for the address.', { exact: true })).toBeVisible()
  await expect(addressPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  const invalidAddress = await call<{ location: { address: PostalAddress | null } }>('get_location', { location_id: location.id })
  expect(invalidAddress.error).toBeNull()
  expect(invalidAddress.data!.location.address).toEqual(changedAddress)
  await addressPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/dashboard/${slug}/locations/${savedLocationSlug}/address`)
  await expect(addressCity).toHaveValue('Nong Thale')
  const nativeAddressVersion = await call<{ location: { updated_at: string } }>('get_location', { location_id: location.id })
  expect(nativeAddressVersion.error).toBeNull()
  await addressPanel.getByRole('textbox', { name: 'Postal code', exact: true }).fill('81000')
  const nativeChangedAddress = { ...changedAddress, postalCode: '81000' }
  const nativeLocationRenamed = await call('update_location', { location_id: location.id, title: 'Cliff Cabin Address' })
  expect(nativeLocationRenamed.error).toBeNull()
  const nativeRenamedVersion = await call<{ location: { title: string; slug: string; updated_at: string; address: PostalAddress | null } }>('get_location', { location_id: location.id })
  expect(nativeRenamedVersion.error).toBeNull()
  expect(nativeRenamedVersion.data!.location).toMatchObject({ title: 'Cliff Cabin Address', slug: savedLocationSlug, address: changedAddress })
  expect(nativeRenamedVersion.data!.location.updated_at).not.toBe(nativeAddressVersion.data!.location.updated_at)
  const nativeAddressConflict = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === locationWritePath)
  await addressPanel.getByRole('button', { name: 'Save', exact: true }).click()
  const nativeConflictResponse = await nativeAddressConflict
  await expectStatus(nativeConflictResponse, 409)
  expect(nativeConflictResponse.request().postDataJSON()).toEqual({ address: nativeChangedAddress, expected_updated_at: nativeAddressVersion.data!.location.updated_at })
  await expect(addressPanel.getByText('The location changed since it was read. Reload it and try again.', { exact: false })).toBeVisible()
  await expect(page).toHaveURL(`/dashboard/${slug}/locations/${savedLocationSlug}/address`)
  await expect(streetAddress).toHaveValue('12 Test Road')
  await expect(apartment).toHaveValue('Apartment 4')
  await expect(thirdAddressLine).toHaveValue('East building')
  await expect(addressCity).toHaveValue('Nong Thale')
  await expect(addressPanel.getByRole('textbox', { name: 'Postal code', exact: true })).toHaveValue('81000')
  await expect(addressPanel.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  const nativeAddressRejected = await call<{ location: { slug: string; address: PostalAddress | null } }>('get_location', { location_id: location.id })
  expect(nativeAddressRejected.error).toBeNull()
  expect(nativeAddressRejected.data!.location).toMatchObject({ slug: savedLocationSlug, address: changedAddress })
  const nativeAddressRetried = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === locationWritePath)
  await addressPanel.getByRole('button', { name: 'Save', exact: true }).click()
  const nativeRetryResponse = await nativeAddressRetried
  await expectStatus(nativeRetryResponse, 200)
  expect(nativeRetryResponse.request().postDataJSON()).toEqual({ address: nativeChangedAddress, expected_updated_at: nativeRenamedVersion.data!.location.updated_at })
  await expect(page).toHaveURL(`/dashboard/${slug}/locations/${savedLocationSlug}/address`)
  await expect(addressPanel.getByRole('textbox', { name: 'Postal code', exact: true })).toHaveValue('81000')
  const nativeAddressSaved = await call<{ location: { id: string; slug: string; address: PostalAddress | null } }>('get_location', { location_id: location.id })
  expect(nativeAddressSaved.error).toBeNull()
  expect(nativeAddressSaved.data!.location).toMatchObject({ id: location.id, slug: savedLocationSlug, address: nativeChangedAddress })

})

test('a host distinguishes absent alarms from unanswered alarms and clears their descriptions and room claims together', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { request, slug, organizationId, location, call, productId } = await createStayHome(page, baseURL!)
  const root = `/dashboard/${slug}/products/${productId}`
  const locationQuery = new URL(page.url()).search
  expect(new URL(page.url()).searchParams.get('location_id')).toBe(location.id)
  const productWritePath = `/api/editor/organizations/${organizationId}/products/${productId}`
  const { previewLink, previewModal, previewIframe, preview } = previewLocators(page)
  await previewLink.click()
  const publicSafety = preview.getByRole('heading', { name: 'Safety & property', exact: true })
  await expect(publicSafety).toHaveCount(0)
  const publicURL = new URL((await previewIframe.getAttribute('src'))!, baseURL!)
  publicURL.pathname = publicURL.pathname.replace(/^\/stays\//, '/api/public/stays/')
  await previewModal.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByTestId('editor-card-guest-safety').click()
  const safetyIndex = page.locator('#dashboard-panel-product-guest-safety')
  const devicesLink = safetyIndex.getByRole('link', { name: /^Safety devices/ })
  await devicesLink.click()
  const devices = page.locator('#dashboard-panel-product-guest-safety-section')
  const smoke = devices.getByRole('group', { name: 'Smoke alarm', exact: true })
  const carbon = devices.getByRole('group', { name: 'Carbon monoxide alarm', exact: true })
  const detail = page.locator('#dashboard-panel-product-guest-safety-detail')
  const description = detail.getByRole('textbox', { name: 'Smoke alarm', exact: true })
  for (const alarm of [smoke, carbon]) for (const answer of ['No', 'Yes']) await expect(alarm.getByRole('button', { name: answer, exact: true })).toHaveAttribute('aria-pressed', 'false')
  const draftWrites: string[] = []
  const trackDraft = (outgoing: Request) => {
    if (new URL(outgoing.url()).pathname === productWritePath && outgoing.method() === 'PATCH') draftWrites.push(outgoing.url())
  }
  page.on('request', trackDraft)
  await smoke.getByRole('button', { name: 'Yes', exact: true }).click()
  await devices.getByRole('link', { name: 'Smoke alarm details', exact: true }).click()
  await description.fill('This draft alarm description is discarded.')
  await detail.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page).toHaveURL(`${baseURL}${root}/guest-safety/devices${locationQuery}`)
  await devices.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(`${baseURL}${root}/guest-safety${locationQuery}`)
  expect(draftWrites).toEqual([])
  page.off('request', trackDraft)
  const cancelled = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(cancelled.error).toBeNull()
  expect(cancelled.data!.product.stay!.amenity_answers).toEqual([])
  expect(cancelled.data!.product.details).not.toHaveProperty('smoke_detector_details')

  await devicesLink.click()
  await smoke.getByRole('button', { name: 'No', exact: true }).click()
  const absentSaved = page.waitForResponse(response => new URL(response.url()).pathname === productWritePath && response.request().method() === 'PATCH')
  await devices.getByRole('button', { name: 'Save', exact: true }).click()
  const absentResponse = await absentSaved
  await expectStatus(absentResponse, 200)
  expect(absentResponse.request().postDataJSON().stay).toEqual({ amenity_answers: [{ code: 'smoke_detector', available: false }] })
  const absent = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(absent.error).toBeNull()
  expect(absent.data!.product.stay!.amenity_answers).toEqual([{ code: 'smoke_detector', available: false }])
  expect(absent.data!.product.stay!.amenities).toEqual([])
  await expect(page).toHaveURL(`${baseURL}${root}/guest-safety${locationQuery}`)
  await previewLink.click()
  await expect(publicSafety).toHaveCount(0)
  const absentPublic = await request.get(publicURL.href)
  await expectStatus(absentPublic, 200)
  expect((await absentPublic.json() as { product: Product }).product.stay!.amenity_answers).toEqual([{ code: 'smoke_detector', available: false }])
  const absentSchema = JSON.parse((await preview.locator('script[type="application/ld+json"]').textContent())!) as { '@graph': Array<Record<string, unknown>> }
  expect(absentSchema['@graph'].find(node => node['@type'] === 'Accommodation')!.amenityFeature).toEqual([{ '@type': 'LocationFeatureSpecification', name: 'Smoke alarm', value: false }])
  await previewModal.getByRole('button', { name: 'Close', exact: true }).click()
  await devicesLink.click()
  await expect(smoke.getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(carbon.getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'false')

  await smoke.getByRole('button', { name: 'Yes', exact: true }).click()
  await devices.getByRole('link', { name: 'Smoke alarm details', exact: true }).click()
  await expect(description).toHaveValue('')
  await description.fill('A cancelled detail must not be saved.')
  await detail.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(`${baseURL}${root}/guest-safety/devices${locationQuery}`)
  await devices.getByRole('link', { name: 'Smoke alarm details', exact: true }).click()
  await expect(description).toHaveValue('')
  const alarmDescription = 'A smoke alarm is mounted outside the bedroom.\nAnother is in the kitchen.'
  await description.fill(alarmDescription)
  await page.setViewportSize({ width: 1440, height: 900 })
  page.on('request', trackDraft)
  await detail.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page).toHaveURL(`${baseURL}${root}/guest-safety/devices${locationQuery}`)
  expect(draftWrites).toEqual([])
  page.off('request', trackDraft)
  const installedSaved = page.waitForResponse(response => new URL(response.url()).pathname === productWritePath && response.request().method() === 'PATCH')
  await devices.getByRole('button', { name: 'Save', exact: true }).click()
  const installedResponse = await installedSaved
  await expectStatus(installedResponse, 200)
  expect(installedResponse.request().postDataJSON().stay).toEqual({ amenity_answers: [{ code: 'smoke_detector', available: true }] })
  expect(installedResponse.request().postDataJSON().details.smoke_detector_details).toBe(alarmDescription)
  const installed = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(installed.error).toBeNull()
  expect(installed.data!.product.stay!.amenity_answers).toEqual([{ code: 'smoke_detector', available: true }])
  expect(installed.data!.product.stay!.amenities).toEqual(['smoke_detector'])
  expect(installed.data!.product.details.smoke_detector_details).toBe(alarmDescription)
  const createdRoom = await call<{ room: Pick<StayPhotoRoom, 'id' | 'type' | 'photo_ids' | 'details_version'> }>('create_home_room', { product_id: productId, type: 'bedroom' })
  expect(createdRoom.error).toBeNull()
  const roomId = createdRoom.data!.room.id
  const assignedAlarm = await call('update_home_room', { product_id: productId, room_id: roomId, expected_details_version: 1, amenities: ['smoke_detector'] })
  expect(assignedAlarm.error).toBeNull()
  const roomAlarm = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(roomAlarm.error).toBeNull()
  expect(roomAlarm.data!.product.stay!.photo_rooms[0]!.amenities).toEqual(['smoke_detector'])

  await page.reload()
  await devicesLink.click()
  await expect(smoke.getByRole('button', { name: 'Yes', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(devices.getByText(alarmDescription, { exact: true })).toBeVisible()
  await smoke.getByRole('button', { name: 'Yes', exact: true }).click()
  await expect(devices.getByRole('link', { name: 'Smoke alarm details', exact: true })).toHaveCount(0)
  const unknownSaved = page.waitForResponse(response => new URL(response.url()).pathname === productWritePath && response.request().method() === 'PATCH')
  await devices.getByRole('button', { name: 'Save', exact: true }).click()
  const unknownResponse = await unknownSaved
  await expectStatus(unknownResponse, 200)
  expect(unknownResponse.request().postDataJSON().stay).toEqual({ amenity_answers: [{ code: 'smoke_detector', available: null }] })
  expect(unknownResponse.request().postDataJSON().details.smoke_detector_details).toBeNull()
  const unknown = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(unknown.error).toBeNull()
  expect(unknown.data!.product.stay!.amenity_answers).toEqual([])
  expect(unknown.data!.product.stay!.amenities).toEqual([])
  expect(unknown.data!.product.stay!.photo_rooms[0]).toMatchObject({ id: roomId, amenities: [], details_version: 3 })
  expect(unknown.data!.product.details).not.toHaveProperty('smoke_detector_details')
  await expect(page).toHaveURL(`${baseURL}${root}/guest-safety${locationQuery}`)
  await previewLink.click()
  await expect(publicSafety).toHaveCount(0)
  await expect(preview.getByText(alarmDescription, { exact: true })).toHaveCount(0)
  const unknownSchema = JSON.parse((await preview.locator('script[type="application/ld+json"]').textContent())!) as { '@graph': Array<Record<string, unknown>> }
  expect(unknownSchema['@graph'].find(node => node['@type'] === 'Accommodation')).not.toHaveProperty('amenityFeature')
  await previewModal.getByRole('button', { name: 'Close', exact: true }).click()
})

test("a host uploads, arranges, describes and removes a place to stay's photos", async ({ page, baseURL }) => {
  // Author the home, upload media, exercise its editors, and finish independent readbacks.
  test.setTimeout(120_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { request, headers, slug, organizationId, location, call, api, productId } = await createStayHome(page, baseURL!)
  const { previewLink, previewModal, preview } = previewLocators(page)
  const checkIn = localDay(0)
  const checkOut = localDay(2)

  // A home's photos are its product's media; the photo routes refuse what is not a photo before storing anything.
  const photos = api(`stay-homes/${productId}/photos`)
  const ordered = await request.put(photos, { headers, data: { photo_ids: [] } })
  await expectStatus(ordered, 200)
  expect((await ordered.json() as { home: { photos: unknown[] } }).home.photos).toEqual([])
  const notAPhoto = await request.post(photos, { headers, multipart: { image: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') } } })
  await expectStatus(notAPhoto, 415)
  expect(await notAPhoto.json()).toMatchObject({ data: { code: 'UNSUPPORTED_PHOTO_TYPE', field: 'image' } })
  const missing = await request.patch(api(`stay-homes/${productId}/photos/absent`), { headers, data: { alt_text: 'The deck at sunset' } })
  await expectStatus(missing, 404)
  expect(await missing.json()).toMatchObject({ data: { code: 'PHOTO_NOT_FOUND', field: 'photo_id' } })

  // Technical AVIF inputs exercise the real picker/R2 upload; they are not property photos.
  await page.setViewportSize({ width: 1440, height: 900 })
  const photoPath = `/dashboard/${slug}/products/${productId}/photo`
  const allPhotosPath = `${photoPath}/photos`
  await page.goto(allPhotosPath)
  const photoOverview = page.locator('#dashboard-panel-product-photo')
  const uploadGrid = page.locator('#dashboard-panel-product-all-photos')
  type PhotoProduct = { image: { asset_id: string; alt_text: string | null } | null; gallery: Array<{ asset_id: string; alt_text: string | null }>; stay: { photo_rooms: StayPhotoRoom[] } }
  const uploadedPhotos: Array<{ id: string; url: string; width: number; height: number }> = []
  await expect(uploadGrid.getByRole('heading', { name: 'Add your first photo', exact: true })).toBeVisible()
  const stalePhotoPage = await page.context().newPage()
  try {
    await stalePhotoPage.goto(allPhotosPath)
    const staleOverview = stalePhotoPage.locator('#dashboard-panel-product-all-photos')
    await expect(staleOverview.getByRole('heading', { name: 'Add your first photo', exact: true })).toBeVisible()
    for (const [name, background, width, height] of [
      ['red-upload-proof.avif', '#dc2626', 120, 80],
      ['blue-upload-proof.avif', '#2563eb', 96, 128],
      ['green-upload-proof.avif', '#16a34a', 144, 96],
    ] as const) {
      // The second editor was loaded empty before red became the cover.
      // Its Add must append blue against the server's current placements.
      const activePage = name === 'blue-upload-proof.avif' ? stalePhotoPage : page
      const activeOverview = activePage.locator('#dashboard-panel-product-all-photos')
      if (activePage === stalePhotoPage) await expect(activeOverview.getByRole('heading', { name: 'Add your first photo', exact: true })).toBeVisible()
      await activeOverview.getByRole('button', { name: 'Add photos', exact: true }).click()
      const picker = activePage.getByRole('dialog', { name: 'Add photos', exact: true })
      const uploaded = activePage.waitForResponse(response => new URL(response.url()).pathname === `/api/editor/organizations/${organizationId}/media/upload` && response.request().method() === 'POST')
      await picker.locator('input[type="file"]').setInputFiles({ name, mimeType: 'image/avif', buffer: await sharp({ create: { width, height, channels: 3, background } }).avif().toBuffer() })
      const uploadResponse = await uploaded
      await expectStatus(uploadResponse, 200)
      const asset = await uploadResponse.json() as { asset_id: string; public_url: string; kind: string; status: string; thumbnail_url: string | null }
      expect(asset).toMatchObject({ kind: 'image', status: 'active', thumbnail_url: null })
      uploadedPhotos.push({ id: asset.asset_id, url: asset.public_url, width, height })
      await picker.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(picker).not.toBeVisible()
      await expect(activeOverview.locator('img')).toHaveCount(uploadedPhotos.length)
      const image = activeOverview.locator('img').nth(uploadedPhotos.length - 1)
      await expect(image).toHaveAttribute('src', asset.public_url)
      await expect(image).toHaveJSProperty('naturalWidth', width)
      await expect(image).toHaveJSProperty('naturalHeight', height)
      if (activePage === stalePhotoPage) {
        const appendedProduct = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
        expect(appendedProduct.error).toBeNull()
        expect(appendedProduct.data!.product.image!.asset_id).toBe(uploadedPhotos[0]!.id)
        expect(appendedProduct.data!.product.gallery.map(item => item.asset_id)).toEqual([asset.asset_id])
        await page.reload()
        for (const overview of [uploadGrid, staleOverview]) {
          await expect(overview.locator('img')).toHaveCount(2)
          for (const [index, photo] of uploadedPhotos.entries()) {
            await expect(overview.locator('img').nth(index)).toHaveAttribute('src', photo.url)
            await expect(overview.locator('img').nth(index)).toHaveJSProperty('naturalWidth', photo.width)
          }
        }
      }
    }
  } finally {
    await stalePhotoPage.close()
  }
  await page.goto(photoPath)
  const [red, blue, green] = uploadedPhotos as [typeof uploadedPhotos[number], typeof uploadedPhotos[number], typeof uploadedPhotos[number]]
  const storedUploads = await call<{ assets: Array<{ asset_id: string; public_url: string; provider: string; status: string; kind: string; alt_text: string | null }> }>('list_media_assets', { kind: 'image' })
  expect(storedUploads.error).toBeNull()
  expect(storedUploads.data!.assets.map(asset => ({ id: asset.asset_id, url: asset.public_url, provider: asset.provider, status: asset.status, kind: asset.kind })).sort((a, b) => a.id.localeCompare(b.id)))
    .toEqual(uploadedPhotos.map(photo => ({ id: photo.id, url: photo.url, provider: 'cloudflare_r2', status: 'active', kind: 'image' })).sort((a, b) => a.id.localeCompare(b.id)))
  // Generic media permits one asset in both slots; the stay photo order is
  // still a unique list, and an uncommitted reorder must preserve both slots.
  const sharedCover = await call('attach_media', { placement: { owner_type: 'product', owner_id: productId, slot: 'gallery' }, asset_id: red.id })
  expect(sharedCover.error).toBeNull()
  const duplicatePlacement = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(duplicatePlacement.error).toBeNull()
  expect(duplicatePlacement.data!.product.image!.asset_id).toBe(red.id)
  expect(duplicatePlacement.data!.product.gallery.map(asset => asset.asset_id)).toEqual([blue.id, green.id, red.id])
  expect(duplicatePlacement.data!.product.stay.photo_rooms).toEqual([])
  await page.reload()
  await expect(photoOverview.getByTestId('stay-additional-photos')).toContainText('3 photos')
  await expect(photoOverview.getByTestId('stay-additional-photos').locator('img')).toHaveAttribute('src', red.url)
  const projectedHome = await request.get(api(`stay-homes/${productId}`))
  await expectStatus(projectedHome, 200)
  expect((await projectedHome.json() as { home: { photos: Array<{ id: string; position: number }> } }).home.photos.map(photo => ({ id: photo.id, position: photo.position })))
    .toEqual(uploadedPhotos.map((photo, position) => ({ id: photo.id, position })))
  const projectedCalendar = await call<{ home: Record<string, unknown> }>('get_stay_calendar', { product_id: productId, from: checkIn, to: checkOut })
  expect(projectedCalendar.error).toBeNull()
  expect(projectedCalendar.data!.home).toEqual({ product_id: productId, name: 'Cliff Cabin', location_id: location.id, timezone: TIME_ZONE, currency: 'THB', base_price_minor: null, base_price_tax_behavior: null, check_in_time: '15:00', check_in_end_time: null, check_out_time: '11:00', max_guests: 4, min_nights: 2, channel: null })
  await previewLink.click()
  await expect(previewModal).toBeVisible()
  await expect(preview.getByRole('heading', { name: 'Cliff Cabin', level: 1, exact: true })).toBeVisible()
  const guestPhotos = preview.locator('[data-media-gallery] img')
  await expect(guestPhotos).toHaveCount(3)
  for (const [index, photo] of uploadedPhotos.entries()) {
    await expect(guestPhotos.nth(index)).toHaveAttribute('src', photo.url)
    await expect(guestPhotos.nth(index)).toHaveJSProperty('naturalWidth', photo.width)
    await expect(guestPhotos.nth(index)).toHaveJSProperty('naturalHeight', photo.height)
  }
  await previewModal.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page).toHaveURL(`${baseURL}${photoPath}`)

  const photoCard = page.getByTestId('editor-card-photo')
  await expect(photoCard).toBeVisible()
  await expect(photoCard).toHaveAccessibleName('Photos 3 photos')
  await expect(photoCard).toContainText('3 photos')
  await expect(photoCard).not.toContainText('None set')
  const allPhotosAction = photoOverview.getByRole('link', { name: 'All photos', exact: true })
  await allPhotosAction.click()
  await expect(page).toHaveURL(`${baseURL}${allPhotosPath}`)
  const photoGrid = page.locator('#dashboard-panel-product-all-photos')
  const photoLinks = photoGrid.getByRole('link', { name: /^Open Photo \d+$/ })
  await expect(photoLinks).toHaveCount(3)
  const allPhotosBack = photoGrid.getByRole('link', { name: 'Back', exact: true })
  await expect(allPhotosBack).toBeVisible()
  await expect(allPhotosBack).toHaveAttribute('href', photoPath)
  await allPhotosBack.click()
  await expect(page).toHaveURL(`${baseURL}${photoPath}`)
  await expect(photoOverview).toBeVisible()
  await allPhotosAction.click()
  await expect(page).toHaveURL(`${baseURL}${allPhotosPath}`)
  await expect(photoLinks).toHaveCount(3)
  const managePhotosAction = photoGrid.getByRole('button', { name: 'Manage photos', exact: true })

  // Reordering is one local draft until Save; Cancel restores the saved order.
  await photoGrid.getByRole('button', { name: 'Options for photo 3', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Move backward', exact: true }).click()
  await expect(photoLinks.nth(1)).toHaveAttribute('href', `${allPhotosPath}/${green.id}`)
  const unsavedOrder = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(unsavedOrder.error).toBeNull()
  expect([unsavedOrder.data!.product.image!.asset_id, ...unsavedOrder.data!.product.gallery.map(asset => asset.asset_id)]).toEqual([red.id, blue.id, green.id, red.id])
  await photoGrid.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(photoLinks.nth(1)).toHaveAttribute('href', `${allPhotosPath}/${blue.id}`)
  const cancelledOrder = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(cancelledOrder.error).toBeNull()
  expect([cancelledOrder.data!.product.image!.asset_id, ...cancelledOrder.data!.product.gallery.map(asset => asset.asset_id)]).toEqual([red.id, blue.id, green.id, red.id])
  await photoGrid.getByRole('button', { name: 'Options for photo 3', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Move backward', exact: true }).click()
  await photoGrid.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(photoGrid.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await page.reload()
  for (const [index, id] of [red.id, green.id, blue.id].entries()) await expect(photoLinks.nth(index)).toHaveAttribute('href', `${allPhotosPath}/${id}`)
  const reorderedHome = await request.get(api(`stay-homes/${productId}`))
  await expectStatus(reorderedHome, 200)
  expect((await reorderedHome.json() as { home: { photos: Array<{ id: string; position: number }> } }).home.photos.map(photo => ({ id: photo.id, position: photo.position })))
    .toEqual([red.id, green.id, blue.id].map((id, position) => ({ id, position })))
  const reorderedProduct = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(reorderedProduct.error).toBeNull()
  expect(reorderedProduct.data!.product.image!.asset_id).toBe(red.id)
  expect(reorderedProduct.data!.product.gallery.map(asset => asset.asset_id)).toEqual([green.id, blue.id])

  await photoLinks.nth(2).click()
  await expect(page).toHaveURL(`${baseURL}${allPhotosPath}/${blue.id}`)
  const photoDetail = page.locator('#dashboard-panel-product-photo-detail')
  await photoDetail.getByRole('button', { name: 'Make cover photo', exact: true }).click()
  await expect(photoDetail.getByText('Cover photo', { exact: true })).toBeVisible()
  await expect(photoDetail.getByRole('button', { name: 'Remove photo', exact: true })).toBeEnabled()
  const coveredProduct = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(coveredProduct.error).toBeNull()
  expect([coveredProduct.data!.product.image!.asset_id, ...coveredProduct.data!.product.gallery.map(asset => asset.asset_id)]).toEqual([blue.id, red.id, green.id])

  // An upload stores no visual description until the host writes one.
  expect(storedUploads.data!.assets.find(asset => asset.asset_id === blue.id)!.alt_text).toBeNull()
  await photoDetail.getByRole('link', { name: 'Add a visual description', exact: true }).click()
  const photoDescriptionPanel = page.locator('#dashboard-panel-product-photo-visual-description')
  const visualDescription = photoDescriptionPanel.getByRole('textbox', { name: 'Visual description', exact: true })
  await expect(visualDescription).toHaveAttribute('maxlength', '500')
  await visualDescription.fill('An unsaved visual description')
  await photoDescriptionPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(`${baseURL}${allPhotosPath}/${blue.id}`)
  await photoDetail.getByRole('link', { name: 'Add a visual description', exact: true }).click()
  await expect(visualDescription).toHaveValue('')
  const photoDescription = 'A blue rectangular technical image used to verify a photo upload.'
  await visualDescription.fill(photoDescription)
  const photoEndpoint = `/api/dashboard/stay-homes/${productId}/photos/${blue.id}`
  const interceptPhoto = (url: URL) => url.pathname === photoEndpoint
  await page.route(interceptPhoto, async route => route.request().method() === 'PATCH' ? await route.abort('failed') : await route.continue())
  const interruptedPhoto = page.waitForEvent('requestfailed', request => request.method() === 'PATCH' && new URL(request.url()).pathname === photoEndpoint)
  await photoDescriptionPanel.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await interruptedPhoto).failure()).toEqual({ errorText: 'net::ERR_FAILED' })
  await expect(photoDescriptionPanel.getByText('Failed to fetch', { exact: false })).toBeVisible()
  await expect(visualDescription).toHaveValue(photoDescription)
  await expect(photoDescriptionPanel.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  const unwrittenDescription = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(unwrittenDescription.data!.product.image!.alt_text).toBeNull()
  await page.unroute(interceptPhoto)
  await photoDescriptionPanel.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page).toHaveURL(`${baseURL}${allPhotosPath}/${blue.id}`)
  await page.reload()
  await expect(photoDetail.locator('img')).toHaveAttribute('alt', photoDescription)
  const describedProduct = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(describedProduct.error).toBeNull()
  expect(describedProduct.data!.product.image).toMatchObject({ asset_id: blue.id, alt_text: photoDescription })

  await expect(page).toHaveURL(`${baseURL}${allPhotosPath}/${blue.id}`)
  await expect(photoDetail.locator('img')).toHaveAttribute('alt', photoDescription)
  await expect(photoDetail.locator('img')).toHaveJSProperty('naturalWidth', blue.width)
  await expect(photoDetail.locator('img')).toHaveJSProperty('naturalHeight', blue.height)
  await photoDetail.getByRole('button', { name: 'Remove photo', exact: true }).click()
  await expect(page).toHaveURL(`${baseURL}${allPhotosPath}`)
  await expect(photoLinks).toHaveCount(2)
  const promotedProduct = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(promotedProduct.error).toBeNull()
  expect([promotedProduct.data!.product.image!.asset_id, ...promotedProduct.data!.product.gallery.map(asset => asset.asset_id)]).toEqual([red.id, green.id])
  await managePhotosAction.click()
  const photoSelection = page.getByTestId('grid-editor-takeover')
  await photoSelection.getByRole('button', { name: 'Select Photo 2', exact: true }).click()
  await expect(photoSelection.getByRole('button', { name: 'Select Photo 2', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await photoSelection.getByRole('button', { name: 'Remove selected photos', exact: true }).click()
  await expect(photoSelection).not.toBeVisible()
  await expect(photoLinks).toHaveCount(1)
  const removedPhotos = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(removedPhotos.error).toBeNull()
  expect(removedPhotos.data!.product.image!.asset_id).toBe(red.id)
  expect(removedPhotos.data!.product.gallery).toEqual([])
  const retainedFiles = await call<{ assets: Array<{ asset_id: string; status: string; alt_text: string | null }> }>('list_media_assets', { kind: 'image' })
  expect(retainedFiles.error).toBeNull()
  expect(retainedFiles.data!.assets.map(asset => ({ id: asset.asset_id, status: asset.status })).sort((a, b) => a.id.localeCompare(b.id)))
    .toEqual(uploadedPhotos.map(photo => ({ id: photo.id, status: 'active' })).sort((a, b) => a.id.localeCompare(b.id)))
  expect(retainedFiles.data!.assets.find(asset => asset.asset_id === blue.id)!.alt_text).toBe(photoDescription)
  await page.setViewportSize({ width: 1440, height: 900 })
  await photoGrid.getByRole('button', { name: 'Add photos', exact: true }).click()
  const existingPhotoPicker = page.getByRole('dialog', { name: 'Add photos', exact: true })
  await existingPhotoPicker.getByRole('img', { name: photoDescription, exact: true }).click()
  await existingPhotoPicker.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(existingPhotoPicker).not.toBeVisible()
  await expect(photoLinks).toHaveCount(2)
  const reattachedProduct = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(reattachedProduct.error).toBeNull()
  expect([reattachedProduct.data!.product.image!.asset_id, ...reattachedProduct.data!.product.gallery.map(asset => asset.asset_id)]).toEqual([red.id, blue.id])
})

type PhotoProduct = { updated_at: string; image: { asset_id: string } | null; gallery: Array<{ asset_id: string }>; stay: { amenities: string[]; photo_rooms: StayPhotoRoom[]; accessibility: StayHomeAccessibility[] } }
const unknownHomeAccessibility: StayHomeAccessibility[] = [
  { feature: 'disabled_parking_spot', available: null, photo_ids: [] },
  { feature: 'path_to_entrance_lit_at_night', available: null, photo_ids: [] },
  { feature: 'home_step_free_access', available: null, photo_ids: [] },
  { feature: 'home_wide_doorway', available: null, photo_ids: [] },
  { feature: 'pool_hoist', available: null, photo_ids: [] },
  { feature: 'ceiling_hoist', available: null, photo_ids: [] },
]
const unknownRoomDetails = { sleeping_arrangements: null, private_attached_bathroom: null, details_version: 1, amenities: [], accessibility: [] }
const unknownBedroomAccessibility: StayPhotoRoom['accessibility'] = [{ feature: 'step_free_access', available: null, photo_ids: [] }, { feature: 'wide_doorway', available: null, photo_ids: [] }]
const unknownBedroomDetails = { ...unknownRoomDetails, accessibility: unknownBedroomAccessibility }

// The room journeys start from three technical photos placed through the
// home's photo route; the picker upload itself is the photo journey's concern.
async function photographedStayHome(page: Page, baseURL: string) {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.stack ?? error.message))
  const home = await createStayHome(page, baseURL)
  const photos: Array<{ id: string; url: string }> = []
  for (const background of ['#dc2626', '#2563eb', '#16a34a']) {
    const added = await home.request.post(home.api(`stay-homes/${home.productId}/photos`), { headers: home.headers, multipart: { image: { name: 'room-proof.avif', mimeType: 'image/avif', buffer: await sharp({ create: { width: 120, height: 80, channels: 3, background } }).avif().toBuffer() } } })
    await expectStatus(added, 201)
    const photo = (await added.json() as { home: { photos: Array<{ id: string; url: string }> } }).home.photos.at(-1)!
    photos.push({ id: photo.id, url: photo.url })
  }
  const [red, blue, green] = photos as [typeof photos[number], typeof photos[number], typeof photos[number]]
  const photoPath = `/dashboard/${home.slug}/products/${home.productId}/photo`
  return {
    ...home, pageErrors, uploadedPhotos: photos, red, blue, green, photoPath,
    photoOverview: page.locator('#dashboard-panel-product-photo'),
    roomGrid: page.locator('#dashboard-panel-product-all-photos'),
    chooseRoom: page.getByRole('dialog', { name: 'Choose a room or space', exact: true }),
    addBedroomPhotos: page.getByRole('dialog', { name: 'Add photos to Bedroom', exact: true }),
  }
}

// A bedroom with a queen bed and a private bathroom, authored through MCP.
async function addBedroom({ call, productId }: Awaited<ReturnType<typeof photographedStayHome>>, amenities: StayPhotoRoom['amenities'], photoIds: string[]) {
  const created = await call<{ room: Pick<StayPhotoRoom, 'id'> }>('create_home_room', { product_id: productId, type: 'bedroom' })
  expect(created.error).toBeNull()
  const bedroomId = created.data!.room.id
  expect((await call('update_product', { product_id: productId, stay: { beds: 3, bedrooms: 2, bathrooms: 1 } })).error).toBeNull()
  expect((await call('update_home_room', { product_id: productId, room_id: bedroomId, expected_details_version: 1, sleeping_arrangements: [{ type: 'queen', count: 1 }], private_attached_bathroom: true, amenities })).error).toBeNull()
  if (photoIds.length) expect((await call('assign_home_photos_to_room', { product_id: productId, room_id: bedroomId, photos: photoIds.map(photo_id => ({ photo_id, expected_room_id: null })) })).error).toBeNull()
  const bedroomFacts: Pick<StayPhotoRoom, 'sleeping_arrangements' | 'private_attached_bathroom' | 'details_version' | 'amenities' | 'accessibility'> = { sleeping_arrangements: [{ type: 'queen', count: 1 }], private_attached_bathroom: true, details_version: 2, amenities, accessibility: unknownBedroomAccessibility }
  const bedroom = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(bedroom.error).toBeNull()
  expect(bedroom.data!.product.stay.photo_rooms).toEqual([{ id: bedroomId, type: 'bedroom', photo_ids: photoIds, ...bedroomFacts }])
  return { bedroomId, bedroomFacts }
}

// The guest gallery journeys start from authored listing and bedroom
// accessibility, a photographed bedroom and an empty living room.
async function galleryStayHome(page: Page, baseURL: string) {
  const home = await photographedStayHome(page, baseURL)
  const { call, productId, red, blue, green } = home
  const { bedroomId, bedroomFacts } = await addBedroom(home, ['wireless_internet', 'bed_linens'], [red.id, blue.id])
  expect((await call('update_home_room', { product_id: productId, room_id: bedroomId, expected_details_version: 2, accessibility: { feature: 'step_free_access', available: true, photo_ids: [green.id] } })).error).toBeNull()
  expect((await call('update_home_room', { product_id: productId, room_id: bedroomId, expected_details_version: 3, accessibility: { feature: 'wide_doorway', available: false, photo_ids: [] } })).error).toBeNull()
  bedroomFacts.details_version = 4
  bedroomFacts.accessibility = [{ feature: 'step_free_access', available: true, photo_ids: [green.id] }, { feature: 'wide_doorway', available: false, photo_ids: [] }]
  for (const accessibility of [{ feature: 'disabled_parking_spot', available: false, photo_ids: [] }, { feature: 'path_to_entrance_lit_at_night', available: true, photo_ids: [red.id] }]) {
    const current = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(current.error).toBeNull()
    expect((await call('update_home_accessibility', { product_id: productId, expected_updated_at: current.data!.product.updated_at, accessibility })).error).toBeNull()
  }
  const authoredHomeAnswers: StayHomeAccessibility[] = unknownHomeAccessibility.map(answer => answer.feature === 'disabled_parking_spot' ? { ...answer, available: false } : answer.feature === 'path_to_entrance_lit_at_night' ? { ...answer, available: true, photo_ids: [red.id] } : answer)
  const livingRoom = await call<{ room: Pick<StayPhotoRoom, 'id'> }>('create_home_room', { product_id: productId, type: 'living_room' })
  expect(livingRoom.error).toBeNull()
  const livingRoomId = livingRoom.data!.room.id
  expect((await call('update_home_room', { product_id: productId, room_id: livingRoomId, expected_details_version: 1, amenities: ['tv'] })).error).toBeNull()
  const livingRoomFacts = { ...unknownRoomDetails, details_version: 2, amenities: ['tv'] }
  const seeded = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(seeded.error).toBeNull()
  expect(seeded.data!.product.stay).toMatchObject({ amenities: ['tv', 'wireless_internet', 'bed_linens'], accessibility: authoredHomeAnswers, photo_rooms: [
    { id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts },
    { id: livingRoomId, type: 'living_room', photo_ids: [], ...livingRoomFacts },
  ] })
  return { ...home, bedroomId, bedroomFacts, livingRoomId, livingRoomFacts, authoredHomeAnswers }
}

test('a host adds a bedroom and authors its beds and bathroom privacy through the CMS', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { call, productId, pageErrors, photoPath, photoOverview, roomGrid, chooseRoom } = await photographedStayHome(page, baseURL!)
  const bedPanel = page.locator('#dashboard-panel-product-room-beds')
  const privacyPanel = page.locator('#dashboard-panel-product-room-privacy')
  await page.setViewportSize({ width: 1440, height: 900 })
  const bedroomId = await test.step('an added room is an empty authored choice with a stable identity', async () => {
    await page.goto(photoPath)
    // Rooms are authored choices with stable identities. An empty authored room
    // keeps the guest gallery flat until the host gives every room a photo.
    await photoOverview.getByRole('button', { name: 'Add photos, room, or space', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Add a room or space', exact: true }).click()
    await chooseRoom.getByRole('textbox', { name: 'Search rooms and spaces', exact: true }).fill('Bedroom')
    await chooseRoom.getByText('Bedroom', { exact: true }).click()
    await expect(chooseRoom.getByRole('radio', { name: 'Bedroom', exact: true })).toBeChecked()
    await chooseRoom.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${photoPath}/rooms/[^/]+$`))
    const bedroomProduct = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(bedroomProduct.error).toBeNull()
    expect(bedroomProduct.data!.product.stay.photo_rooms).toEqual([{ id: expect.any(String), type: 'bedroom', photo_ids: [], ...unknownBedroomDetails }])
    const bedroomId = bedroomProduct.data!.product.stay.photo_rooms[0]!.id
    await expect(page).toHaveURL(`${baseURL}${photoPath}/rooms/${bedroomId}`)
    return bedroomId
  })
  const roomPath = `${photoPath}/rooms/${bedroomId}`
  await test.step('sleeping arrangements and privacy save, clear and cancel on their own', async () => {
    const declaredBeds = await call('update_product', { product_id: productId, stay: { beds: 3, bedrooms: 2, bathrooms: 1 } })
    expect(declaredBeds.error).toBeNull()
    await page.reload()
    await roomGrid.getByRole('link', { name: /^Sleeping arrangements/ }).click()
    await expect(bedPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await expect(bedPanel.getByRole('spinbutton', { name: 'Queen', exact: true })).toHaveValue('0')
    await bedPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
    await roomGrid.getByRole('link', { name: /^Sleeping arrangements/ }).click()
    await bedPanel.getByRole('button', { name: 'No beds in this room', exact: true }).click()
    await bedPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
    const noBeds = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(noBeds.error).toBeNull()
    expect(noBeds.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [], ...unknownBedroomDetails, sleeping_arrangements: [], details_version: 2 })
    await roomGrid.getByRole('link', { name: /^Sleeping arrangements/ }).click()
    await bedPanel.getByRole('button', { name: 'Clear details', exact: true }).click()
    await bedPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
    await roomGrid.getByRole('link', { name: /^Privacy info/ }).click()
    await expect(privacyPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await privacyPanel.getByRole('switch', { name: 'Private attached bathroom', exact: true }).click()
    await privacyPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
    const cancelledPrivacy = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(cancelledPrivacy.error).toBeNull()
    expect(cancelledPrivacy.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [], ...unknownBedroomDetails, details_version: 3 })
    await roomGrid.getByRole('link', { name: /^Privacy info/ }).click()
    await privacyPanel.getByRole('button', { name: 'No private attached bathroom', exact: true }).click()
    await privacyPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
    const noBathroom = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(noBathroom.error).toBeNull()
    expect(noBathroom.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [], ...unknownBedroomDetails, private_attached_bathroom: false, details_version: 4 })
    await roomGrid.getByRole('link', { name: /^Privacy info/ }).click()
    await privacyPanel.getByRole('button', { name: 'Clear details', exact: true }).click()
    await privacyPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
    await roomGrid.getByRole('link', { name: /^Sleeping arrangements/ }).click()
    await bedPanel.getByRole('spinbutton', { name: 'Queen', exact: true }).press('ArrowUp')
    await expect(bedPanel.getByRole('spinbutton', { name: 'Queen', exact: true })).toHaveValue('1')
    await expect(bedPanel.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await expect(bedPanel.getByText('Sleeping arrangements aren’t specified.', { exact: true })).not.toBeVisible()
    await bedPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
  })
  await test.step('a concurrent privacy edit refuses the stale save until the host reviews it', async () => {
    await roomGrid.getByRole('link', { name: /^Privacy info/ }).click()
    await privacyPanel.getByRole('switch', { name: 'Private attached bathroom', exact: true }).click()
    const beforeConcurrentPrivacy = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(beforeConcurrentPrivacy.error).toBeNull()
    const bedroomBeforeConcurrentPrivacy = beforeConcurrentPrivacy.data!.product.stay.photo_rooms.find(room => room.id === bedroomId)
    expect(bedroomBeforeConcurrentPrivacy).toMatchObject({ id: bedroomId, details_version: 6 })
    const concurrentPrivacy = await call('update_home_room', { product_id: productId, room_id: bedroomId, expected_details_version: bedroomBeforeConcurrentPrivacy!.details_version, private_attached_bathroom: false })
    expect(concurrentPrivacy.error).toBeNull()
    const staleRoom = page.waitForResponse(response => new URL(response.url()).pathname === `/api/dashboard/stay-homes/${productId}/rooms/${bedroomId}` && response.request().method() === 'PATCH')
    await privacyPanel.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await staleRoom).status()).toBe(409)
    await expect(privacyPanel).toContainText('The room details changed')
    await expect(privacyPanel.getByRole('switch', { name: 'Private attached bathroom', exact: true })).toBeChecked()
    await privacyPanel.getByRole('button', { name: 'Use saved details', exact: true }).click()
    await expect(privacyPanel.getByRole('switch', { name: 'Private attached bathroom', exact: true })).not.toBeChecked()
    await expect(privacyPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await privacyPanel.getByRole('switch', { name: 'Private attached bathroom', exact: true }).click()
    await expect(privacyPanel.getByRole('switch', { name: 'Private attached bathroom', exact: true })).toBeChecked()
    await privacyPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
    const bedroomFacts: Pick<StayPhotoRoom, 'sleeping_arrangements' | 'private_attached_bathroom' | 'details_version' | 'amenities' | 'accessibility'> = { sleeping_arrangements: [{ type: 'queen', count: 1 }], private_attached_bathroom: true, details_version: 8, amenities: [], accessibility: unknownBedroomAccessibility }
    const savedRoomFacts = await call<{ product: PhotoProduct & { stay: { beds: number; bedrooms: number; bathrooms: number } } }>('get_product', { product_id: productId })
    expect(savedRoomFacts.error).toBeNull()
    expect(savedRoomFacts.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [], ...bedroomFacts })
    expect(savedRoomFacts.data!.product.stay).toMatchObject({ beds: 3, bedrooms: 2, bathrooms: 1 })
    await roomGrid.getByRole('link', { name: /^Sleeping arrangements/ }).click()
    await expect(bedPanel.getByRole('spinbutton', { name: 'Queen', exact: true })).toHaveValue('1')
    await expect(bedPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await bedPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
  })
  expect(pageErrors).toEqual([])
})

test('a host chooses a room’s amenities from the shared catalog and resolves a concurrent edit', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const home = await photographedStayHome(page, baseURL!)
  const { call, productId, pageErrors, photoPath, roomGrid } = home
  const { bedroomId, bedroomFacts } = await addBedroom(home, [], [])
  const roomPath = `${photoPath}/rooms/${bedroomId}`
  const amenityPanel = page.locator('#dashboard-panel-product-room-amenities')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(roomPath)
  await test.step('Cancel keeps both the room and the listing unchanged', async () => {
    await roomGrid.getByRole('link', { name: /^Amenities/ }).click()
    await expect(amenityPanel.getByRole('heading', { name: 'Add amenities', exact: true })).toBeVisible()
    await expect(amenityPanel.getByTestId('room-amenities-suggested')).toHaveAttribute('aria-pressed', 'true')
    await expect(amenityPanel.getByRole('checkbox')).toHaveCount(11)
    await expect(amenityPanel.getByRole('button', { name: 'Done', exact: true })).toBeDisabled()
    await amenityPanel.getByRole('checkbox', { name: 'Bed linens', exact: true }).check()
    await expect(amenityPanel.getByRole('checkbox', { name: 'Bed linens', exact: true })).toBeChecked()
    await amenityPanel.getByRole('button', { name: 'Search amenities', exact: true }).click()
    await amenityPanel.getByRole('searchbox', { name: 'Search amenities', exact: true }).fill('Wifi')
    await expect(amenityPanel.getByRole('checkbox', { name: 'Wifi', exact: true })).toBeVisible()
    await amenityPanel.getByRole('button', { name: 'Cancel search', exact: true }).click()
    await expect(amenityPanel.getByTestId('room-amenities-suggested')).toHaveAttribute('aria-pressed', 'true')
    await expect(amenityPanel.getByRole('checkbox')).toHaveCount(11)
    await expect(amenityPanel.getByRole('checkbox', { name: 'Bed linens', exact: true })).toBeChecked()
    await amenityPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
    const cancelledRoomAmenities = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(cancelledRoomAmenities.error).toBeNull()
    expect(cancelledRoomAmenities.data!.product.stay.amenities).toEqual([])
    expect(cancelledRoomAmenities.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [], ...bedroomFacts })
  })
  await test.step('a concurrent edit refuses the stale choice; the reviewed choice also declares it on the listing', async () => {
    await roomGrid.getByRole('link', { name: /^Amenities/ }).click()
    await amenityPanel.getByRole('checkbox', { name: 'Bed linens', exact: true }).check()
    await amenityPanel.getByTestId('room-amenities-all').click()
    await expect(amenityPanel.getByTestId('room-amenities-all')).toHaveAttribute('aria-pressed', 'true')
    await amenityPanel.getByRole('button', { name: 'Search amenities', exact: true }).click()
    await amenityPanel.getByRole('searchbox', { name: 'Search amenities', exact: true }).fill('Wifi')
    await expect(amenityPanel.getByRole('checkbox')).toHaveCount(2)
    await amenityPanel.getByRole('checkbox', { name: 'Wifi', exact: true }).check()
    const concurrentAmenities = await call('update_home_room', { product_id: productId, room_id: bedroomId, expected_details_version: 2, amenities: ['bed_linens'] })
    expect(concurrentAmenities.error).toBeNull()
    const staleAmenities = page.waitForResponse(response => new URL(response.url()).pathname === `/api/dashboard/stay-homes/${productId}/rooms/${bedroomId}` && response.request().method() === 'PATCH')
    await amenityPanel.getByRole('button', { name: 'Done', exact: true }).click()
    const staleAmenityResponse = await staleAmenities
    expect(staleAmenityResponse.status()).toBe(409)
    expect(staleAmenityResponse.request().postDataJSON()).toEqual({ expected_details_version: 2, amenities: ['bed_linens', 'wireless_internet'] })
    await expect(amenityPanel).toContainText('The room details changed')
    await expect(amenityPanel.getByRole('checkbox', { name: 'Wifi', exact: true })).toBeChecked()
    await amenityPanel.getByRole('button', { name: 'Use saved details', exact: true }).click()
    await expect(amenityPanel.getByRole('checkbox', { name: 'Wifi', exact: true })).not.toBeChecked()
    await expect(amenityPanel.getByRole('button', { name: 'Done', exact: true })).toBeDisabled()
    await amenityPanel.getByRole('checkbox', { name: 'Wifi', exact: true }).check()
    await amenityPanel.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
    bedroomFacts.amenities = ['wireless_internet', 'bed_linens']
    bedroomFacts.details_version = 4
    const savedRoomAmenities = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(savedRoomAmenities.error).toBeNull()
    expect(savedRoomAmenities.data!.product.stay.amenities).toEqual(['wireless_internet', 'bed_linens'])
    expect(savedRoomAmenities.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [], ...bedroomFacts })
    await expect(roomGrid.getByRole('link', { name: /^Amenities/ })).toContainText('Bed linens')
    await expect(roomGrid.getByRole('link', { name: /^Amenities/ })).toContainText('Wifi')
    await roomGrid.getByRole('link', { name: /^Amenities/ }).click()
    await expect(amenityPanel.getByTestId('room-amenities-suggested')).toHaveAttribute('aria-pressed', 'true')
    await expect(amenityPanel.getByRole('checkbox', { name: 'Bed linens', exact: true })).toBeChecked()
    await expect(amenityPanel.getByRole('checkbox', { name: 'Wifi', exact: true })).toHaveCount(0)
    await amenityPanel.getByTestId('room-amenities-all').click()
    await expect(amenityPanel.getByRole('checkbox', { name: 'Wifi', exact: true })).toBeChecked()
    await expect(amenityPanel.getByRole('checkbox', { name: 'Bed linens', exact: true })).toBeChecked()
    await amenityPanel.getByTestId('room-amenities-suggested').click()
    await page.setViewportSize({ width: 1440, height: 900 })
    await amenityPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
  })
  expect(pageErrors).toEqual([])
})

test('a host adds gallery and library photos to a room and the open dialog recovers from concurrent moves', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const home = await photographedStayHome(page, baseURL!)
  const { request, call, api, productId, pageErrors, photoPath, roomGrid, addBedroomPhotos, red, blue, green } = home
  const { bedroomId, bedroomFacts } = await addBedroom(home, ['wireless_internet', 'bed_linens'], [])
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${photoPath}/rooms/${bedroomId}`)
  const afterRefusedRoomMove = await test.step('a concurrent move refuses the stale bulk write, and the retry adds the remaining choice', async () => {
    await roomGrid.getByRole('button', { name: 'Add photos', exact: true }).click()
    await addBedroomPhotos.getByRole('button', { name: 'Select photo 1', exact: true }).click()
    await addBedroomPhotos.getByRole('button', { name: 'Select photo 2', exact: true }).click()
    await expect(addBedroomPhotos.getByRole('button', { name: 'Select photo 2', exact: true })).toHaveAttribute('aria-pressed', 'true')
    // A concurrent MCP move refuses the stale bulk write without moving its
    // sibling. The open dialog refreshes its sources and retries the same choice.
    await page.route(`${baseURL}/api/dashboard/stay-homes/${productId}/photos/move**`, async route => {
      const concurrentRoomMove = await call('assign_home_photos_to_room', { product_id: productId, room_id: bedroomId, photos: [{ photo_id: red.id, expected_room_id: null }] })
      expect(concurrentRoomMove.error).toBeNull()
      await route.continue()
    }, { times: 1 })
    const refusedRoomMove = page.waitForResponse(response => new URL(response.url()).pathname === `/api/dashboard/stay-homes/${productId}/photos/move` && response.request().method() === 'PUT')
    await addBedroomPhotos.getByRole('button', { name: 'Add photos', exact: true }).click()
    expect((await refusedRoomMove).status()).toBe(409)
    await expect(addBedroomPhotos.getByText('A selected photo moved to another room; reload the photo tour', { exact: true })).toBeVisible()
    const afterRefusedRoomMove = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(afterRefusedRoomMove.error).toBeNull()
    expect(afterRefusedRoomMove.data!.product.stay.photo_rooms).toEqual([{ id: bedroomId, type: 'bedroom', photo_ids: [red.id], ...bedroomFacts }])
    await addBedroomPhotos.getByRole('button', { name: 'Add photos', exact: true }).click()
    await expect(addBedroomPhotos).not.toBeVisible()
    await expect(roomGrid.getByRole('link', { name: /^Open Photo \d+$/ })).toHaveCount(2)
    await expect(roomGrid.getByRole('link', { name: /^Sleeping arrangements/ }).getByText('1 queen bed', { exact: true })).toBeInViewport({ ratio: 1 })
    await expect(roomGrid.getByRole('link', { name: /^Amenities/ })).toContainText('Bed linens')
    await expect(roomGrid.getByRole('link', { name: /^Amenities/ })).toContainText('Wifi')
    return afterRefusedRoomMove
  })
  await test.step('a selection completed elsewhere closes the dialog instead of retrying empty', async () => {
    // If the complete selection reaches the destination concurrently, the
    // refreshed dialog completes instead of submitting an empty retry.
    await roomGrid.getByRole('button', { name: 'Add photos', exact: true }).click()
    await addBedroomPhotos.getByRole('button', { name: 'Select photo 3', exact: true }).click()
    await page.route(`${baseURL}/api/dashboard/stay-homes/${productId}/photos/move**`, async route => {
      const fulfilledElsewhere = await call('assign_home_photos_to_room', { product_id: productId, room_id: bedroomId, photos: [{ photo_id: green.id, expected_room_id: null }] })
      expect(fulfilledElsewhere.error).toBeNull()
      await route.continue()
    }, { times: 1 })
    const alreadyMoved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/dashboard/stay-homes/${productId}/photos/move` && response.request().method() === 'PUT')
    await addBedroomPhotos.getByRole('button', { name: 'Add photos', exact: true }).click()
    expect((await alreadyMoved).status()).toBe(409)
    await expect(addBedroomPhotos).not.toBeVisible()
    await expect(roomGrid.getByText('A selected photo moved to another room; reload the photo tour', { exact: true })).toBeVisible()
    await expect(roomGrid.getByRole('link', { name: /^Open Photo \d+$/ })).toHaveCount(3)
    const afterCompletedSelection = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(afterCompletedSelection.error).toBeNull()
    expect(afterCompletedSelection.data!.product.stay.photo_rooms).toEqual([{ ...afterRefusedRoomMove.data!.product.stay.photo_rooms[0]!, photo_ids: [red.id, blue.id, green.id] }])
    const returnedToAdditional = await call('assign_home_photos_to_room', { product_id: productId, room_id: null, photos: [{ photo_id: green.id, expected_room_id: bedroomId }] })
    expect(returnedToAdditional.error).toBeNull()
    await page.reload()
    await expect(roomGrid.getByRole('link', { name: /^Open Photo \d+$/ })).toHaveCount(2)
  })
  await test.step('a retained library photo appends directly to the room', async () => {
    // Append a retained library asset directly to an authored room through the
    // picker. Detaching blue first leaves it retained in the library, so its
    // return exercises the atomic placement and membership write.
    const detached = await request.delete(api(`stay-homes/${productId}/photos/${blue.id}`), { headers: authRequestHeaders(baseURL!) })
    await expectStatus(detached, 200)
    await page.goto(`${photoPath}/rooms/${bedroomId}`)
    await roomGrid.getByRole('button', { name: 'Add photos', exact: true }).click()
    await addBedroomPhotos.getByRole('button', { name: 'Add from media library', exact: true }).click()
    const libraryPicker = page.getByRole('dialog', { name: 'Add photos', exact: true })
    await libraryPicker.locator(`img[src="${blue.url}"]`).click()
    const roomAppend = page.waitForResponse(response => new URL(response.url()).pathname === `/api/dashboard/stay-homes/${productId}/photos` && response.request().method() === 'POST')
    await libraryPicker.getByRole('button', { name: 'Done', exact: true }).click()
    const appended = await roomAppend
    await expectStatus(appended, 201)
    await expect(addBedroomPhotos).not.toBeVisible()
    await expect(roomGrid.getByRole('link', { name: /^Open Photo \d+$/ })).toHaveCount(2)
    const afterLibraryRoomAppend = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(afterLibraryRoomAppend.error).toBeNull()
    expect(afterLibraryRoomAppend.data!.product.stay.photo_rooms).toEqual([{ id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts }])
    expect([afterLibraryRoomAppend.data!.product.image!.asset_id, ...afterLibraryRoomAppend.data!.product.gallery.map(asset => asset.asset_id)]).toEqual([red.id, green.id, blue.id])
  })
  expect(pageErrors).toEqual([])
})

test('a host answers listing-wide accessibility with gallery evidence and resolves a concurrent answer', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { request, headers, slug, call, api, productId, pageErrors, red, blue, green } = await photographedStayHome(page, baseURL!)
  const beforeRooms = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
  expect(beforeRooms.error).toBeNull()
  expect(beforeRooms.data!.product.stay.photo_rooms).toEqual([])
  expect(beforeRooms.data!.product.stay.amenities).toEqual([])
  expect(beforeRooms.data!.product.stay.accessibility).toEqual(unknownHomeAccessibility)
  const authoredHomeAnswers: StayHomeAccessibility[] = unknownHomeAccessibility.map(answer => answer.feature === 'disabled_parking_spot' ? { ...answer, available: false } : answer.feature === 'path_to_entrance_lit_at_night' ? { ...answer, available: true, photo_ids: [red.id] } : answer)
  const homeAccessibilityPath = `/dashboard/${slug}/products/${productId}/accessibility`
  const homeAccessibilityIndex = page.locator('#dashboard-panel-product-accessibility')
  const homeAccessibilityPanel = page.locator('#dashboard-panel-product-accessibility-feature')
  const homeFeatureLink = homeAccessibilityIndex.getByRole('link', { name: /^Path to entrance lit at night/ })
  const homeAccessibilityEndpoint = `/api/dashboard/stay-homes/${productId}/accessibility`
  const { absentHomeFeature, absentHomeAnswers } = await test.step('an absent answer saves and summarizes on the editor card', async () => {
    await page.goto(homeAccessibilityPath)
    await expect(homeAccessibilityIndex.getByRole('link').filter({ hasText: 'Add details' })).toHaveCount(6)
    await homeFeatureLink.click()
    await expect(homeAccessibilityPanel.getByRole('radio', { name: 'I don’t have this feature', exact: true })).not.toBeChecked()
    await expect(homeAccessibilityPanel.getByRole('radio', { name: 'I have this feature', exact: true })).not.toBeChecked()
    await expect(homeAccessibilityPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await homeAccessibilityPanel.getByRole('radio', { name: 'I don’t have this feature', exact: true }).check()
    const absentHomeFeatureResponse = page.waitForResponse(response => new URL(response.url()).pathname === homeAccessibilityEndpoint && response.request().method() === 'PATCH')
    await homeAccessibilityPanel.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await absentHomeFeatureResponse).status()).toBe(200)
    await expect(page).toHaveURL(`${baseURL}${homeAccessibilityPath}`)
    const absentHomeFeature = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(absentHomeFeature.error).toBeNull()
    const absentHomeAnswers = unknownHomeAccessibility.map(answer => answer.feature === 'path_to_entrance_lit_at_night' ? { ...answer, available: false } : answer)
    expect(absentHomeFeature.data!.product.stay.accessibility).toEqual(absentHomeAnswers)
    await expect(homeFeatureLink).toContainText('Not available')
    await expect(page.getByTestId('editor-card-accessibility')).toContainText('Path to entrance lit at night: Not available')
    await expect(page.getByTestId('editor-card-accessibility')).not.toContainText('Add details')
    return { absentHomeFeature, absentHomeAnswers }
  })
  await test.step('a concurrent answer refuses the stale evidence save until the host reviews it', async () => {
    await homeFeatureLink.click()
    await homeAccessibilityPanel.getByRole('radio', { name: 'I have this feature', exact: true }).check()
    await expect(homeAccessibilityPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await homeAccessibilityPanel.getByRole('button', { name: 'Use photo 1 as evidence', exact: true }).click()
    const concurrentHomeAnswer = await call<{ product_id: string; product_updated_at: string; accessibility: StayHomeAccessibility[] }>('update_home_accessibility', { product_id: productId, expected_updated_at: absentHomeFeature.data!.product.updated_at, accessibility: { feature: 'disabled_parking_spot', available: false, photo_ids: [] } })
    expect(concurrentHomeAnswer.error).toBeNull()
    const staleHomeFeatureResponse = page.waitForResponse(response => new URL(response.url()).pathname === homeAccessibilityEndpoint && response.request().method() === 'PATCH')
    await homeAccessibilityPanel.getByRole('button', { name: 'Save', exact: true }).click()
    const staleHomeResponse = await staleHomeFeatureResponse
    await expectStatus(staleHomeResponse, 409)
    expect(await staleHomeResponse.json()).toMatchObject({ data: { code: 'STAY_ACCESSIBILITY_CHANGED', field: 'expected_updated_at' } })
    await expect(homeAccessibilityPanel.getByRole('button', { name: 'Use saved details', exact: true })).toBeVisible()
    await expect(homeAccessibilityPanel.getByRole('button', { name: 'Use photo 1 as evidence', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const staleHomeFeature = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(staleHomeFeature.error).toBeNull()
    const concurrentHomeAnswers = absentHomeAnswers.map(answer => answer.feature === 'disabled_parking_spot' ? { ...answer, available: false } : answer)
    expect(concurrentHomeAnswer.data).toEqual({ product_id: productId, product_updated_at: staleHomeFeature.data!.product.updated_at, accessibility: concurrentHomeAnswers })
    expect(staleHomeFeature.data!.product.stay.accessibility).toEqual(concurrentHomeAnswers)
    expect([staleHomeFeature.data!.product.image!.asset_id, ...staleHomeFeature.data!.product.gallery.map(photo => photo.asset_id)]).toEqual([red.id, blue.id, green.id])
    await homeAccessibilityPanel.getByRole('button', { name: 'Use saved details', exact: true }).click()
    await expect(homeAccessibilityPanel.getByRole('radio', { name: 'I don’t have this feature', exact: true })).toBeChecked()
    await homeAccessibilityPanel.getByRole('radio', { name: 'I have this feature', exact: true }).check()
    await homeAccessibilityPanel.getByRole('button', { name: 'Use photo 1 as evidence', exact: true }).click()
    const savedHomeFeatureResponse = page.waitForResponse(response => new URL(response.url()).pathname === homeAccessibilityEndpoint && response.request().method() === 'PATCH')
    await homeAccessibilityPanel.getByRole('button', { name: 'Save', exact: true }).click()
    const homeFeatureResponse = await savedHomeFeatureResponse
    await expectStatus(homeFeatureResponse, 200)
    await expect(page).toHaveURL(`${baseURL}${homeAccessibilityPath}`)
    const savedHomeFeature = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(savedHomeFeature.error).toBeNull()
    expect(savedHomeFeature.data!.product.stay.accessibility).toEqual(authoredHomeAnswers)
    expect((await homeFeatureResponse.json() as { home: { product_updated_at: string; accessibility: StayHomeAccessibility[] } }).home).toMatchObject({ product_updated_at: savedHomeFeature.data!.product.updated_at, accessibility: authoredHomeAnswers })
  })
  await test.step('a photo that evidences an answer cannot be removed', async () => {
    const protectedHomeEvidence = await request.delete(api(`stay-homes/${productId}/photos/${red.id}`), { headers })
    await expectStatus(protectedHomeEvidence, 409)
    expect(await protectedHomeEvidence.json()).toMatchObject({ data: { code: 'ACCESSIBILITY_EVIDENCE_REQUIRED', field: 'photo_ids' } })
    const protectedHomeRead = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(protectedHomeRead.error).toBeNull()
    expect(protectedHomeRead.data!.product.stay.accessibility).toEqual(authoredHomeAnswers)
    expect([protectedHomeRead.data!.product.image!.asset_id, ...protectedHomeRead.data!.product.gallery.map(photo => photo.asset_id)]).toEqual([red.id, blue.id, green.id])
    await homeFeatureLink.click()
    await expect(homeAccessibilityPanel.getByRole('radio', { name: 'I have this feature', exact: true })).toBeChecked()
    await expect(homeAccessibilityPanel.getByRole('button', { name: 'Use photo 1 as evidence', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(homeAccessibilityPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  })
  expect(pageErrors).toEqual([])
})

test('a host answers bedroom accessibility with uploaded and existing evidence photos', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const home = await photographedStayHome(page, baseURL!)
  const { request, headers, organizationId, call, api, productId, pageErrors, uploadedPhotos, photoPath, roomGrid, red, blue, green } = home
  const { bedroomId, bedroomFacts } = await addBedroom(home, ['wireless_internet', 'bed_linens'], [red.id, blue.id])
  const roomPath = `${photoPath}/rooms/${bedroomId}`
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(roomPath)
  const evidenceUploads: Array<{ id: string; url: string }> = []
  const accessibilityIndex = page.locator('#dashboard-panel-product-room-accessibility')
  const accessibilityPanel = page.locator('#dashboard-panel-product-room-accessibility-feature')
  const accessibilityPath = `${roomPath}/accessibility`
  await test.step('an answer saves, clears and cancels without evidence', async () => {
    await roomGrid.getByRole('link', { name: /^Accessibility features/ }).click()
    await expect(accessibilityIndex.getByRole('link', { name: /^Step-free access/ })).toContainText('Add details')
    await accessibilityIndex.getByRole('link', { name: /^Step-free access/ }).click()
    await expect(accessibilityPanel.getByRole('radio')).toHaveCount(2)
    await expect(accessibilityPanel.getByRole('radio', { name: 'I don’t have this feature', exact: true })).not.toBeChecked()
    await expect(accessibilityPanel.getByRole('radio', { name: 'I have this feature', exact: true })).not.toBeChecked()
    await expect(accessibilityPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await accessibilityPanel.getByRole('radio', { name: 'I don’t have this feature', exact: true }).check()
    await accessibilityPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${accessibilityPath}`)
    const cancelledAnswer = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(cancelledAnswer.error).toBeNull()
    expect(cancelledAnswer.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts })
    await accessibilityIndex.getByRole('link', { name: /^Step-free access/ }).click()
    await accessibilityPanel.getByRole('radio', { name: 'I don’t have this feature', exact: true }).check()
    await accessibilityPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${accessibilityPath}`)
    await expect(accessibilityIndex.getByRole('link', { name: /^Step-free access/ })).toContainText('Not available')
    bedroomFacts.details_version = 3
    bedroomFacts.accessibility = [{ feature: 'step_free_access', available: false, photo_ids: [] }, unknownBedroomAccessibility[1]!]
    const unavailableAnswer = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(unavailableAnswer.error).toBeNull()
    expect(unavailableAnswer.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts })
    await accessibilityIndex.getByRole('link', { name: /^Step-free access/ }).click()
    await accessibilityPanel.getByRole('button', { name: 'Clear details', exact: true }).click()
    await accessibilityPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${accessibilityPath}`)
    bedroomFacts.details_version = 4
    bedroomFacts.accessibility = unknownBedroomAccessibility
  })
  await test.step('an uploaded evidence photo is committed only by Save, after a concurrent edit is reviewed', async () => {
    await accessibilityIndex.getByRole('link', { name: /^Step-free access/ }).click()
    await accessibilityPanel.getByRole('radio', { name: 'I have this feature', exact: true }).check()
    await expect(accessibilityPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await accessibilityPanel.getByRole('button', { name: 'Review photo guidelines', exact: true }).click()
    const photoGuidelines = page.getByRole('dialog', { name: 'Photo guidelines', exact: true })
    await expect(photoGuidelines).toContainText('Open the bedroom door and photograph it from outside, looking into the room.')
    await photoGuidelines.getByRole('button', { name: 'Got it', exact: true }).click()
    await expect(photoGuidelines).not.toBeVisible()
    for (const [name, background] of [['amber-cancelled-evidence.avif', '#d97706'], ['purple-saved-evidence.avif', '#9333ea']] as const) {
      await accessibilityPanel.getByRole('button', { name: 'Add photos', exact: true }).click()
      const picker = page.getByRole('dialog', { name: 'Add evidence photo', exact: true })
      const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === `/api/editor/organizations/${organizationId}/media/upload` && response.request().method() === 'POST')
      await picker.locator('input[type="file"]').setInputFiles({ name, mimeType: 'image/avif', buffer: await sharp({ create: { width: 120, height: 80, channels: 3, background } }).avif().toBuffer() })
      const response = await uploaded
      await expectStatus(response, 200)
      const asset = await response.json() as { asset_id: string; public_url: string }
      evidenceUploads.push({ id: asset.asset_id, url: asset.public_url })
      await picker.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(picker).not.toBeVisible()
      await expect(accessibilityPanel.getByRole('button', { name: 'Use photo 4 as evidence', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(accessibilityPanel.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
      if (name === 'amber-cancelled-evidence.avif') {
        await accessibilityPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(page).toHaveURL(`${baseURL}${accessibilityPath}`)
        const cancelledUpload = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
        expect(cancelledUpload.error).toBeNull()
        expect(cancelledUpload.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts })
        expect([cancelledUpload.data!.product.image!.asset_id, ...cancelledUpload.data!.product.gallery.map(photo => photo.asset_id)]).toEqual([red.id, blue.id, green.id])
        await accessibilityIndex.getByRole('link', { name: /^Step-free access/ }).click()
        await expect(accessibilityPanel.getByRole('radio', { name: 'I have this feature', exact: true })).not.toBeChecked()
        await accessibilityPanel.getByRole('radio', { name: 'I have this feature', exact: true }).check()
      }
    }
    const purpleEvidence = evidenceUploads[1]!
    const concurrentAccessibility = await call('update_home_room', { product_id: productId, room_id: bedroomId, expected_details_version: 4, accessibility: { feature: 'wide_doorway', available: false, photo_ids: [] } })
    expect(concurrentAccessibility.error).toBeNull()
    const staleAccessibility = page.waitForResponse(response => new URL(response.url()).pathname === `/api/dashboard/stay-homes/${productId}/rooms/${bedroomId}` && response.request().method() === 'PATCH')
    await accessibilityPanel.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await staleAccessibility).status()).toBe(409)
    await expect(accessibilityPanel).toContainText('The room details changed')
    await expect(accessibilityPanel.getByRole('button', { name: 'Use photo 4 as evidence', exact: true })).toHaveAttribute('aria-pressed', 'true')
    bedroomFacts.details_version = 5
    bedroomFacts.accessibility = [unknownBedroomAccessibility[0]!, { feature: 'wide_doorway', available: false, photo_ids: [] }]
    const staleEvidenceRead = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(staleEvidenceRead.error).toBeNull()
    expect(staleEvidenceRead.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts })
    expect([staleEvidenceRead.data!.product.image!.asset_id, ...staleEvidenceRead.data!.product.gallery.map(photo => photo.asset_id)]).toEqual([red.id, blue.id, green.id])
    await accessibilityPanel.getByRole('button', { name: 'Use saved details', exact: true }).click()
    await expect(accessibilityPanel.getByRole('radio', { name: 'I have this feature', exact: true })).not.toBeChecked()
    await expect(accessibilityPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await accessibilityPanel.getByRole('radio', { name: 'I have this feature', exact: true }).check()
    await accessibilityPanel.getByRole('button', { name: 'Add photos', exact: true }).click()
    const savedEvidencePicker = page.getByRole('dialog', { name: 'Add evidence photo', exact: true })
    await savedEvidencePicker.getByRole('button').filter({ hasText: /^purple-saved-evidence\.avif$/ }).click()
    await savedEvidencePicker.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(savedEvidencePicker).not.toBeVisible()
    await accessibilityPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${accessibilityPath}`)
    bedroomFacts.details_version = 6
    bedroomFacts.accessibility = [{ feature: 'step_free_access', available: true, photo_ids: [purpleEvidence.id] }, { feature: 'wide_doorway', available: false, photo_ids: [] }]
    const attachedEvidence = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(attachedEvidence.error).toBeNull()
    expect(attachedEvidence.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts })
    expect([attachedEvidence.data!.product.image!.asset_id, ...attachedEvidence.data!.product.gallery.map(photo => photo.asset_id)]).toEqual([red.id, blue.id, green.id, purpleEvidence.id])
    const protectedEvidence = await request.delete(api(`stay-homes/${productId}/photos/${purpleEvidence.id}`), { headers })
    await expectStatus(protectedEvidence, 409)
    expect(await protectedEvidence.json()).toMatchObject({ data: { code: 'ACCESSIBILITY_EVIDENCE_REQUIRED', field: 'photo_ids' } })
    const protectedEvidenceRead = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(protectedEvidenceRead.error).toBeNull()
    expect(protectedEvidenceRead.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts })
    expect(protectedEvidenceRead.data!.product.gallery.map(photo => photo.asset_id)).toEqual([blue.id, green.id, purpleEvidence.id])
    await accessibilityIndex.getByRole('link', { name: /^Step-free access/ }).click()
    await accessibilityPanel.getByRole('button', { name: 'Clear details', exact: true }).click()
    await accessibilityPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${accessibilityPath}`)
    const removedEvidence = await request.delete(api(`stay-homes/${productId}/photos/${purpleEvidence.id}`), { headers })
    await expectStatus(removedEvidence, 200)
  })
  await test.step('an existing gallery photo can be chosen as evidence, and every upload stays in the library', async () => {
    // A fresh owner read sees the removal before selecting an existing photo.
    await page.reload()
    await accessibilityIndex.getByRole('link', { name: /^Step-free access/ }).click()
    await accessibilityPanel.getByRole('radio', { name: 'I have this feature', exact: true }).check()
    await expect(accessibilityPanel.getByRole('button', { name: /^Use photo \d+ as evidence$/ })).toHaveCount(3)
    await accessibilityPanel.getByRole('button', { name: 'Use photo 3 as evidence', exact: true }).click()
    await accessibilityPanel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${accessibilityPath}`)
    bedroomFacts.details_version = 8
    bedroomFacts.accessibility = [{ feature: 'step_free_access', available: true, photo_ids: [green.id] }, { feature: 'wide_doorway', available: false, photo_ids: [] }]
    const greenEvidence = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(greenEvidence.error).toBeNull()
    expect(greenEvidence.data!.product.stay.photo_rooms[0]).toEqual({ id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts })
    expect([greenEvidence.data!.product.image!.asset_id, ...greenEvidence.data!.product.gallery.map(photo => photo.asset_id)]).toEqual([red.id, blue.id, green.id])
    await expect(accessibilityIndex.getByRole('link', { name: /^Step-free access/ })).toContainText('1 photo')
    await expect(accessibilityIndex.getByRole('link', { name: /^Entrance wider than 32 inches/ })).toContainText('Not available')
    await accessibilityIndex.getByRole('link', { name: /^Step-free access/ }).click()
    await expect(accessibilityPanel.getByRole('button', { name: 'Use photo 3 as evidence', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(accessibilityPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await accessibilityPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${accessibilityPath}`)
    await expect(accessibilityPanel).not.toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    const accessibilityBack = accessibilityIndex.getByRole('link', { name: 'Back', exact: true })
    await expect(accessibilityBack).toHaveAttribute('href', roomPath)
    await accessibilityBack.click()
    await expect(page).toHaveURL(`${baseURL}${roomPath}`)
    const retainedLibrary = await call<{ assets: Array<{ asset_id: string; status: string }> }>('list_media_assets', { kind: 'image' })
    expect(retainedLibrary.error).toBeNull()
    expect(retainedLibrary.data!.assets.map(asset => ({ id: asset.asset_id, status: asset.status })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([...uploadedPhotos, ...evidenceUploads].map(photo => ({ id: photo.id, status: 'active' })).sort((a, b) => a.id.localeCompare(b.id)))
  })
  expect(pageErrors).toEqual([])
})

test('the guest gallery stays flat while a room has no photo and shows room details and accessibility evidence', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { pageErrors, photoPath, red, green, bedroomId, livingRoomId } = await galleryStayHome(page, baseURL!)
  const { previewLink, previewModal, previewIframe, preview } = previewLocators(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(photoPath)
  await test.step('listing accessibility evidence opens in the gallery', async () => {
    await previewLink.click()
    await expect(previewModal).toBeVisible()
    const flatPreviewFrame = await (await previewIframe.elementHandle())!.contentFrame()
    expect(flatPreviewFrame).not.toBeNull()
    await waitForNuxtHydration(flatPreviewFrame!)
    expect(pageErrors).toEqual([])
    const guestHomeAccessibility = preview.getByTestId('stay-accessibility-features')
    await expect(guestHomeAccessibility.getByRole('heading', { name: 'Accessibility features', exact: true })).toBeVisible()
    await expect(guestHomeAccessibility.locator('li')).toHaveCount(1)
    await expect(guestHomeAccessibility).toContainText('Path to entrance lit at night')
    await expect(guestHomeAccessibility).toContainText('The path to the guest entrance is well lit at night.')
    await expect(guestHomeAccessibility).not.toContainText('Disabled parking spot')
    const guestHomeEvidence = guestHomeAccessibility.getByRole('button', { name: 'View Path to entrance lit at night, photo 1', exact: true })
    await expect(guestHomeEvidence.locator('img')).toHaveAttribute('src', red.url)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(previewIframe).toHaveJSProperty('clientWidth', 390)
    await page.setViewportSize({ width: 1440, height: 900 })
    await guestHomeEvidence.click()
    await expect(preview.locator(`img.object-contain[src="${red.url}"]`)).toBeInViewport({ ratio: 0.9 })
    await expect(preview.getByText('1 / 3', { exact: true })).toBeVisible()
    await preview.getByRole('button', { name: 'Close photos and videos', exact: true }).click()
  })
  await test.step('rooms show their details and evidence, and the gallery has no photo tour', async () => {
    const guestBedroom = preview.getByTestId(`stay-room-details-${bedroomId}`)
    await expect(preview.getByRole('heading', { name: "Where you'll sleep", exact: true })).toBeVisible()
    await expect(guestBedroom).toContainText('1 queen bed')
    await expect(guestBedroom).toContainText('Private attached bathroom')
    await expect(guestBedroom).toContainText('Bed linens')
    await expect(guestBedroom).toContainText('Wifi')
    await expect(guestBedroom).toContainText('Step-free access')
    await expect(guestBedroom).toContainText('The route from the guest entrance to the bedroom has no steps or thresholds higher than 5 cm (2 in).')
    await expect(guestBedroom).not.toContainText('Entrance wider than 32 inches')
    await expect(guestBedroom.getByRole('button', { name: 'View Step-free access, photo 1', exact: true }).locator('img')).toHaveAttribute('src', green.url)
    const guestLivingRoom = preview.getByTestId(`stay-room-details-${livingRoomId}`)
    await expect(guestLivingRoom).toBeVisible()
    await expect(guestLivingRoom).toContainText('TV')
    await expect(guestLivingRoom).not.toContainText('Private attached bathroom')
    await expect(guestLivingRoom).not.toContainText('No sleeping arrangements')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(previewIframe).toHaveJSProperty('clientWidth', 390)
    await page.setViewportSize({ width: 1440, height: 900 })
    await guestBedroom.getByRole('button', { name: 'View Step-free access, photo 1', exact: true }).click()
    await expect(preview.locator(`img.object-contain[src="${green.url}"]`)).toBeInViewport({ ratio: 0.9 })
    await expect(preview.getByText('3 / 3', { exact: true })).toBeVisible()
    await expect(preview.locator('[data-photo-tour]')).toHaveCount(0)
    await preview.getByRole('button', { name: 'Close photos and videos', exact: true }).click()
    await preview.getByRole('button', { name: 'Show all 3 photos', exact: true }).click()
    await expect(preview.locator('[data-photo-tour]')).toHaveCount(0)
    await expect(preview.getByRole('button', { name: 'Close photos and videos', exact: true })).toBeVisible()
    expect(pageErrors).toEqual([])
    await preview.getByRole('button', { name: 'Close photos and videos', exact: true }).click()
    await previewModal.getByRole('button', { name: 'Close', exact: true }).click()
  })
  expect(pageErrors).toEqual([])
})

test('moving a photo into the empty room publishes the authored photo tour, and deleting a room keeps its photos', async ({ page, baseURL }) => {
  // Includes gallery authoring and the independent post-deletion photo-preservation read.
  test.setTimeout(120_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { request, call, api, productId, pageErrors, uploadedPhotos, photoPath, photoOverview, roomGrid, red, blue, green, bedroomId, bedroomFacts, livingRoomId, livingRoomFacts, authoredHomeAnswers } = await galleryStayHome(page, baseURL!)
  const { previewLink, previewModal, previewIframe, preview } = previewLocators(page)
  const publicTour = preview.locator('[data-photo-tour]')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(photoPath)
  const authoredRooms = await test.step('the CMS moves a photo into the empty room', async () => {
    await photoOverview.getByTestId('stay-additional-photos').click()
    await roomGrid.getByRole('button', { name: 'Manage photos', exact: true }).click()
    const roomSelection = page.getByTestId('grid-editor-takeover')
    await roomSelection.getByRole('button', { name: 'Select Photo 3', exact: true }).click()
    await roomSelection.getByRole('button', { name: 'Move selected photos', exact: true }).click()
    const movePhotos = page.getByRole('dialog', { name: 'Move photos', exact: true })
    const livingRoomDestination = movePhotos.getByRole('radio', { name: /^Living room/ })
    await livingRoomDestination.locator('xpath=ancestor::label[1]').click()
    await expect(livingRoomDestination).toBeChecked()
    await movePhotos.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(movePhotos).not.toBeVisible()
    const authoredRooms = [
      { id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts },
      { id: livingRoomId, type: 'living_room', photo_ids: [green.id], ...livingRoomFacts },
    ]
    const roomHome = await request.get(api(`stay-homes/${productId}`))
    await expectStatus(roomHome, 200)
    expect((await roomHome.json() as { home: { photo_rooms: StayPhotoRoom[]; photos: Array<{ id: string }> } }).home).toMatchObject({ photo_rooms: authoredRooms, photos: uploadedPhotos.map(photo => ({ id: photo.id })) })
    const roomProduct = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(roomProduct.error).toBeNull()
    expect(roomProduct.data!.product.stay.photo_rooms).toEqual(authoredRooms)
    await roomGrid.getByRole('link', { name: 'Back', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${photoPath}`)
    await expect(photoOverview.getByTestId(`stay-photo-room-${livingRoomId}`)).toContainText('1 photo')
    return authoredRooms
  })
  await test.step('the guest page opens the authored photo tour', async () => {
    await previewLink.click()
    await expect(previewModal).toBeVisible()
    const authoredPreviewFrame = await (await previewIframe.elementHandle())!.contentFrame()
    expect(authoredPreviewFrame).not.toBeNull()
    await waitForNuxtHydration(authoredPreviewFrame!)
    const publicProductURL = new URL((await previewIframe.getAttribute('src'))!, baseURL)
    publicProductURL.pathname = publicProductURL.pathname.replace(/^\/stays\//, '/api/public/stays/')
    const authoredPublicRead = await request.get(publicProductURL.href)
    await expectStatus(authoredPublicRead, 200)
    const authoredPublicProduct = (await authoredPublicRead.json() as { product: PhotoProduct }).product
    expect(authoredPublicProduct.stay.photo_rooms).toEqual(authoredRooms)
    expect(authoredPublicProduct.stay.amenities).toEqual(['tv', 'wireless_internet', 'bed_linens'])
    expect(authoredPublicProduct.stay.accessibility).toEqual(authoredHomeAnswers)
    await preview.getByRole('button', { name: 'Show all 3 photos', exact: true }).click()
    await expect(publicTour).toBeVisible()
    await expect(publicTour.getByRole('heading', { name: 'Bedroom', exact: true })).toBeVisible()
    await expect(publicTour.getByRole('heading', { name: 'Living room', exact: true })).toBeVisible()
    await expect(publicTour.locator('section > div.grid img')).toHaveCount(3)
    await expect(publicTour.locator(`#photo-room-${bedroomId}`)).toContainText('1 queen bed')
    await expect(publicTour.locator(`#photo-room-${bedroomId}`)).toContainText('Private attached bathroom')
    await expect(publicTour.locator(`#photo-room-${bedroomId}`)).toContainText('Bed linens')
    await expect(publicTour.locator(`#photo-room-${bedroomId}`)).toContainText('Wifi')
    await expect(publicTour.locator(`#photo-room-${bedroomId}`)).toContainText('Step-free access')
    await expect(publicTour.locator(`#photo-room-${bedroomId}`)).not.toContainText('Entrance wider than 32 inches')
    await expect(publicTour.locator(`#photo-room-${bedroomId}`).getByRole('button', { name: 'View Step-free access, photo 1', exact: true }).locator('img')).toHaveAttribute('src', green.url)
    await expect(publicTour.locator(`#photo-room-${livingRoomId}`)).toContainText('TV')
    for (const [index, photo] of uploadedPhotos.entries()) await expect(publicTour.locator('section > div.grid img').nth(index)).toHaveAttribute('src', photo.url)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(previewIframe).toHaveJSProperty('clientWidth', 390)
    expect(await preview.locator('html').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(390)
    await expect(publicTour.getByRole('link', { name: 'Bedroom', exact: true })).toBeVisible()
    await publicTour.locator(`#photo-room-${bedroomId}`).getByRole('button', { name: 'View Step-free access, photo 1', exact: true }).click()
    await expect(preview.locator(`img.object-contain[src="${green.url}"]`)).toBeInViewport({ ratio: 0.9 })
    await expect(preview.getByText('3 / 3', { exact: true })).toBeVisible()
    await preview.getByRole('button', { name: 'Back to photo tour', exact: true }).click()
    await publicTour.getByRole('button', { name: 'Open Bedroom, photo 2', exact: true }).click()
    await expect(preview.getByRole('button', { name: 'Back to photo tour', exact: true })).toBeVisible()
    await preview.getByRole('button', { name: 'Back to photo tour', exact: true }).click()
    await expect(publicTour).toBeVisible()
    await preview.getByRole('button', { name: 'Close photos and videos', exact: true }).click()
    await previewModal.getByRole('button', { name: 'Close', exact: true }).click()
    await page.setViewportSize({ width: 1440, height: 900 })
  })
  await test.step('deleting a room returns its photos to Additional photos in the listing and the tour', async () => {
    // Deleting a room preserves its photos in the listing and public tour.
    await page.goto(`${photoPath}/rooms/${livingRoomId}`)
    await roomGrid.getByRole('button', { name: 'Delete room or space', exact: true }).click()
    const deleteRoom = page.getByRole('dialog', { name: 'Delete room or space?', exact: true })
    await deleteRoom.getByRole('button', { name: 'Delete room or space', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${photoPath}`)
    const roomDeletedProduct = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(roomDeletedProduct.error).toBeNull()
    expect(roomDeletedProduct.data!.product.stay.photo_rooms).toEqual([{ id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts }])
    expect(roomDeletedProduct.data!.product.stay.amenities).toEqual(['tv', 'wireless_internet', 'bed_linens'])
    expect([roomDeletedProduct.data!.product.image!.asset_id, ...roomDeletedProduct.data!.product.gallery.map(asset => asset.asset_id)]).toEqual([red.id, blue.id, green.id])
    await expect(photoOverview.getByTestId(`stay-photo-room-${bedroomId}`)).toContainText('2 photos')
    await expect(photoOverview.getByTestId('stay-additional-photos')).toContainText('1 photo')
    await previewLink.click()
    await expect(previewModal).toBeVisible()
    const remainingPreviewFrame = await (await previewIframe.elementHandle())!.contentFrame()
    expect(remainingPreviewFrame).not.toBeNull()
    await waitForNuxtHydration(remainingPreviewFrame!)
    await preview.getByRole('button', { name: 'Show all 3 photos', exact: true }).click()
    await expect(publicTour.getByRole('heading', { name: 'Additional photos', exact: true })).toBeVisible()
    await expect(publicTour.locator('section > div.grid img')).toHaveCount(3)
    await expect(publicTour.locator('#photo-room-additional img')).toHaveAttribute('src', green.url)
    await preview.getByRole('button', { name: 'Close photos and videos', exact: true }).click()
    await previewModal.getByRole('button', { name: 'Close', exact: true }).click()
  })
  expect(pageErrors).toEqual([])
})

test('native MCP room tools author the same room identities and selected-photo contract', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const home = await photographedStayHome(page, baseURL!)
  const { request, organizationId, call, api, productId, uploadedPhotos, red, blue, green } = home
  const { bedroomId, bedroomFacts } = await addBedroom(home, ['wireless_internet', 'bed_linens'], [red.id, blue.id])
  // Native MCP writes use the same authored IDs and selected-photo contract.
  type RoomIdentity = Pick<StayPhotoRoom, 'id' | 'type' | 'photo_ids' | 'details_version'>
  type Assignment = { product_id: string; destination_room_id: string | null; created_room_id: string | null; moved_photo_ids: string[] }
  const discovery = await mcpRequest(request, baseURL!, { method: 'tools/list' })
  expect(discovery.status()).toBe(200)
  const catalog = await discovery.json() as { result: { tools: Array<{ name: string; inputSchema: object; outputSchema: object }> } }
  const assignmentTool = catalog.result.tools.find(tool => tool.name === 'assign_home_photos_to_room')
  expect(assignmentTool).toBeDefined()
  const ajv = new Ajv({ strict: false, allErrors: true })
  const validAssignment = ajv.compile(assignmentTool!.inputSchema)
  const validAssignmentResult = ajv.compile(assignmentTool!.outputSchema)
  const { officeId, officeFacts, beforeAssignments } = await test.step('created and updated rooms read back through the dashboard and refuse stale versions', async () => {
    const addedByMcp = await call<{ product_id: string; room: RoomIdentity }>('create_home_room', { product_id: productId, type: 'office' })
    expect(addedByMcp.error).toBeNull()
    const officeId = addedByMcp.data!.room.id
    expect(addedByMcp.data).toEqual({ product_id: productId, room: { id: officeId, type: 'office', photo_ids: [], details_version: 1 } })
    const afterMcpCreate = await request.get(api(`stay-homes/${productId}`))
    await expectStatus(afterMcpCreate, 200)
    expect((await afterMcpCreate.json() as { home: { photo_rooms: StayPhotoRoom[] } }).home.photo_rooms).toEqual([
      { id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts },
      { id: officeId, type: 'office', photo_ids: [], ...unknownRoomDetails },
    ])
    const updatedOffice = await call<{ product_id: string; product_updated_at: string; room: StayPhotoRoom }>('update_home_room', { product_id: productId, room_id: officeId, expected_details_version: 1, amenities: ['tv'] })
    expect(updatedOffice.error).toBeNull()
    const beforeAssignments = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(beforeAssignments.error).toBeNull()
    const officeFacts = { ...unknownRoomDetails, details_version: 2, amenities: ['tv'] }
    expect(updatedOffice.data).toEqual({ product_id: productId, product_updated_at: beforeAssignments.data!.product.updated_at, room: { id: officeId, type: 'office', photo_ids: [], ...officeFacts } })
    const staleDetails = await call('update_home_room', { product_id: productId, room_id: officeId, expected_details_version: 1, amenities: [] })
    expect(JSON.parse(staleDetails.error!)).toMatchObject({ status: 409, code: 'ROOM_DETAILS_CHANGED' })
    return { officeId, officeFacts, beforeAssignments }
  })
  await test.step('assignments refuse ambiguous destinations and stale sources, then move, unassign and create', async () => {
    const selectedPhotos = [{ photo_id: green.id, expected_room_id: null }]
    for (const destination of [{}, { room_id: officeId, new_room_type: 'patio' }, { room_id: null, new_room_type: 'patio' }]) {
      const ambiguous = { organization_id: organizationId, product_id: productId, ...destination, photos: selectedPhotos }
      expect(validAssignment(ambiguous), JSON.stringify(ambiguous)).toBe(false)
      const refused = await call('assign_home_photos_to_room', ambiguous)
      expect(refused.error).toContain('Invalid arguments for tool assign_home_photos_to_room')
    }
    const afterRefusedAssignments = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(afterRefusedAssignments.error).toBeNull()
    expect(afterRefusedAssignments.data).toEqual(beforeAssignments.data)
    const existingRoomDestination = { product_id: productId, room_id: officeId, photos: selectedPhotos }
    expect(validAssignment({ organization_id: organizationId, ...existingRoomDestination }), JSON.stringify(validAssignment.errors)).toBe(true)
    const movedByMcp = await call<Assignment>('assign_home_photos_to_room', existingRoomDestination)
    expect(movedByMcp.error).toBeNull()
    expect(movedByMcp.data).toEqual({ product_id: productId, destination_room_id: officeId, created_room_id: null, moved_photo_ids: [green.id] })
    expect(validAssignmentResult(movedByMcp.data), JSON.stringify(validAssignmentResult.errors)).toBe(true)
    const afterMcpMove = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(afterMcpMove.error).toBeNull()
    expect(afterMcpMove.data!.product.stay.photo_rooms).toEqual([
      { id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts },
      { id: officeId, type: 'office', photo_ids: [green.id], ...officeFacts },
    ])
    const staleSource = await call('assign_home_photos_to_room', { product_id: productId, new_room_type: 'patio', photos: selectedPhotos })
    expect(JSON.parse(staleSource.error!)).toMatchObject({ status: 409, code: 'PHOTOS_CHANGED' })
    const afterStaleSource = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(afterStaleSource.error).toBeNull()
    expect(afterStaleSource.data).toEqual(afterMcpMove.data)
    const additionalDestination = { product_id: productId, room_id: null, photos: [{ photo_id: green.id, expected_room_id: officeId }] }
    expect(validAssignment({ organization_id: organizationId, ...additionalDestination }), JSON.stringify(validAssignment.errors)).toBe(true)
    const unassignedByMcp = await call<Assignment>('assign_home_photos_to_room', additionalDestination)
    expect(unassignedByMcp.error).toBeNull()
    expect(unassignedByMcp.data).toEqual({ product_id: productId, destination_room_id: null, created_room_id: null, moved_photo_ids: [green.id] })
    const newRoomDestination = { product_id: productId, new_room_type: 'patio', photos: selectedPhotos }
    expect(validAssignment({ organization_id: organizationId, ...newRoomDestination }), JSON.stringify(validAssignment.errors)).toBe(true)
    const createdByAssignment = await call<Assignment>('assign_home_photos_to_room', newRoomDestination)
    expect(createdByAssignment.error).toBeNull()
    const patioId = createdByAssignment.data!.created_room_id!
    expect(patioId).toMatch(/^[0-9a-f-]{36}$/)
    expect(createdByAssignment.data).toEqual({ product_id: productId, destination_room_id: patioId, created_room_id: patioId, moved_photo_ids: [green.id] })
    expect(validAssignmentResult(createdByAssignment.data), JSON.stringify(validAssignmentResult.errors)).toBe(true)
    const afterCreatedDestination = await call<{ product: PhotoProduct }>('get_product', { product_id: productId })
    expect(afterCreatedDestination.error).toBeNull()
    expect(afterCreatedDestination.data!.product.stay.photo_rooms).toEqual([
      { id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts },
      { id: officeId, type: 'office', photo_ids: [], ...officeFacts },
      { id: patioId, type: 'patio', photo_ids: [green.id], ...unknownRoomDetails },
    ])

    // Deleting rooms returns their photos to Additional photos.
    const removedOffice = await call('delete_home_room', { product_id: productId, room_id: officeId })
    expect(removedOffice.error).toBeNull()
    const removedByMcp = await call('delete_home_room', { product_id: productId, room_id: patioId })
    expect(removedByMcp.error).toBeNull()
    expect(removedByMcp.data).toEqual({ product_id: productId, deleted_room_id: patioId, photo_memberships: [{ photo_id: red.id, room_id: bedroomId }, { photo_id: blue.id, room_id: bedroomId }, { photo_id: green.id, room_id: null }] })
    const afterMcpRemove = await request.get(api(`stay-homes/${productId}`))
    await expectStatus(afterMcpRemove, 200)
    expect((await afterMcpRemove.json() as { home: { photo_rooms: StayPhotoRoom[]; photos: Array<{ id: string }> } }).home).toMatchObject({
      photo_rooms: [{ id: bedroomId, type: 'bedroom', photo_ids: [red.id, blue.id], ...bedroomFacts }],
      photos: uploadedPhotos.map(photo => ({ id: photo.id })),
    })
  })
})

test('a host lists, pauses and unlists a priced place to stay', async ({ page, browser, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const { request, slug, organizationId, call, productId } = await createStayHome(page, baseURL!)
  const { previewLink, previewModal, previewIframe } = previewLocators(page)
  await page.setViewportSize({ width: 1440, height: 900 })
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
  const nightlyPrice = page.locator('#dashboard-panel-product-price')
  await nightlyPrice.getByRole('textbox', { name: 'Per night (THB)', exact: true }).fill('150')
  const priceSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/editor/organizations/${organizationId}/products/${productId}`)
  await nightlyPrice.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await priceSaved).status()).toBe(200)
  await expect(page).toHaveURL(url => url.pathname.endsWith(`/products/${productId}/photo`))
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
  expect(JSON.parse(userIdAssignment.error!)).toMatchObject({ status: 404, message: 'stay.assigned_member_id is not a member of this organization' })
  const unchangedAssignment = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${productId}`)
  await expectStatus(unchangedAssignment, 200)
  expect((await unchangedAssignment.json()).product.stay).toMatchObject({ assigned_member_id: null, assigned_team_id: null })
  const hosted = await call<{ product: Product }>('update_product', { product_id: productId, stay: { assigned_member_id: host.memberId } })
  expect(hosted.error).toBeNull()
  expect(hosted.data!.product.stay).toMatchObject({ assigned_member_id: host.memberId, assigned_team_id: null })
  const productEndpoint = `/api/editor/organizations/${organizationId}/products/${productId}`
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
  await expect(savedVisibility).toContainText('Unlisted')
  await visibility.getByText('Listed', { exact: true }).click()
  await expect(visibility.getByRole('radio', { name: /^Listed/ })).toBeChecked()
  await expect(savedVisibility).toContainText('Unlisted')
  const interceptVisibility = (url: URL) => url.pathname === publicationEndpoint
  await page.route(interceptVisibility, async route => route.request().method() === 'PUT' ? await route.abort('failed') : await route.continue())
  const interruptedVisibility = page.waitForEvent('requestfailed', outgoing => outgoing.method() === 'PUT' && new URL(outgoing.url()).pathname === publicationEndpoint)
  await visibility.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await interruptedVisibility).failure()).toEqual({ errorText: 'net::ERR_FAILED' })
  await expect(visibility.getByText('Failed to fetch', { exact: false })).toBeVisible()
  await expect(visibility.getByRole('radio', { name: /^Listed/ })).toBeChecked()
  await expect(visibility.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  await expect(savedVisibility).toContainText('Unlisted')
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
  await expect(savedVisibility).toContainText('Listed')
  const listedProduct = await call<{ product: Product }>('get_product', { product_id: productId })
  expect(listedProduct.error).toBeNull()
  expect(listedProduct.data!.product).toMatchObject({ active: true, name: pricedProduct.data!.product.name, details: pricedProduct.data!.product.details })
  expect(listedProduct.data!.product.publications.find(item => item.organization_id === organizationId)!.published).toBe(true)
  expect(publicationBodies).toEqual([{ published: true }, { published: true }])
  expect(availabilityBodies).toEqual([])

  const anonymousListing = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const guest = await anonymousListing.newPage()
    const guestResponse = await guest.goto(previewURL.href)
    expect(guestResponse!.status()).toBe(200)
    await expect(guest.getByRole('heading', { name: 'Cliff Cabin', level: 1, exact: true })).toBeVisible()
    await expect(guest.locator('section[aria-label="Meet your host"]').getByText('Cliff Cabin host', { exact: true })).toBeVisible()
    await expect(guest.getByRole('button', { name: 'Check availability', exact: true }).last()).toBeVisible()
    const publicNights = new URL(`/api/public/products/${pricedProduct.data!.product.slug}/nights`, previewURL)
    publicNights.searchParams.set('from', localDay(1))
    publicNights.searchParams.set('to', localDay(4))
    const nightsRead = await anonymousListing.request.get(publicNights.href)
    await expectStatus(nightsRead, 200)
    const calendar = await nightsRead.json() as PublicStayCalendar
    expect(calendar.home).toMatchObject({ currency: 'THB', min_nights: 2, base_price_minor: 150_00 })
    expect(calendar.nights).toEqual([1, 2, 3].map(offset => expect.objectContaining({ date: localDay(offset), available: true, price_minor: 150_00, min_stay_arrival: 2, closed_to_arrival: false, closed_to_departure: false })))
    const checkIn = calendar.nights[0]!.date
    const checkOut = calendar.nights[2]!.date
    const guestDialog = guest.locator('#product-booking')
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
    await expect(guestDialog.locator('dl > div').last().locator('dd')).toHaveText(quotedTotal)
    await guest.keyboard.press('Escape')
    await expect(guestDialog).toBeHidden()
    await expect(guest.locator('article').getByText(`${quotedTotal} Total`, { exact: true })).toBeVisible()
    await guest.setViewportSize({ width: 390, height: 844 })
    const mobileQuoteTotal = guest.getByText(`${quotedTotal} Total`, { exact: true }).filter({ visible: true })
    await expect(mobileQuoteTotal).toBeVisible()
    const dayLabel = (date: string) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
    await expect(mobileQuoteTotal.locator('..').getByText(`${dayLabel(checkIn)} – ${dayLabel(checkOut)}`, { exact: true })).toBeVisible()
    await guest.setViewportSize({ width: 1440, height: 900 })
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
    const pausedRead = await anonymousListing.request.get(new URL(previewURL.pathname.replace(/^\/stays\//, '/api/public/stays/'), previewURL).href)
    await expectStatus(pausedRead, 200)
    expect((await pausedRead.json() as { product: Product }).product).toMatchObject({ name: 'Cliff Cabin', active: false })

    await page.goto(`${publicationPath}/visibility`)
    await visibility.getByText('Unlisted', { exact: true }).click()
    const hiddenSaved = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === publicationEndpoint)
    await visibility.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await hiddenSaved).status()).toBe(200)
    await expect(page).toHaveURL(`${baseURL}${publicationPath}`)
    await expect(savedVisibility).toContainText('Unlisted')
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

for (const concern of ['arrival-guide', 'calendar-and-cleaner'] as const) {
  test(concern === 'arrival-guide' ? 'a host authors a private arrival guide and public house rules with scoped access' : 'a cleaner sees only assigned-home arrivals and departures on Today and Upcoming', async ({ page, browser, baseURL }) => {
  test.setTimeout(60_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates local stays and uses disposable actors')
  await loginAs(page.request, baseURL!, 'user-e2e-lodging-host')
  const headers = authRequestHeaders(baseURL!)
  const slug = `e2e-stays-${crypto.randomUUID().slice(0, 8)}`
  const created = await page.request.post('/api/auth/organization/create', { headers, data: { name: `Cleaner ${slug}`, slug, default_currency: 'THB', timezone: TIME_ZONE } })
  await expectStatus(created, 200)
  const organizationId = (await created.json() as { id: string }).id
  const provisioned = await page.request.post('/api/organizations', { headers, data: { organizationId, name: `Cleaner ${slug}`, subdomain: slug, vertical: 'lodging', sourceLocale: 'en' } })
  await expectStatus(provisioned, 200)
  const api = (path: string) => `/api/dashboard/${path}?org=${encodeURIComponent(slug)}`
  const call = <T>(name: string, args: Record<string, unknown>) => tool<T>(page.request, baseURL!, organizationId, name, args)
  const cleaner = await browser.newContext({ baseURL: baseURL! })
  try {
    await loginAs(cleaner.request, baseURL!, 'user-e2e-demo-role-owner')
    const offered = await page.request.post(`/api/organizations/${organizationId}/invite-links`, { data: { role: 'member' } })
    await expectStatus(offered, 201)
    const token = (await offered.json() as { token: string }).token
    const accepted = await cleaner.request.post(`/api/invite-links/${encodeURIComponent(token)}/accept`, { data: {} })
    await expectStatus(accepted, 200)
    const memberId = (await accepted.json() as { memberId: string }).memberId
    const locations = await call<{ locations: Array<{ id: string }> }>('list_locations', {})
    expect(locations.error).toBeNull()
    expect(locations.data!.locations).toHaveLength(1)
    const madeHome = await page.request.post(api('stay-homes'), { data: { name: 'Assigned Cabin', timezone: TIME_ZONE, address: '1 Test Road', city: 'Krabi', country: 'TH',
      state: null, zip_code: null, phone: null, email: null, check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 1,
      base_price_minor: 320_000, idempotency_key: crypto.randomUUID() } })
    await expectStatus(madeHome, 201)
    const assignedHome = (await madeHome.json() as { home: { product_id: string; location_id: string } }).home
    const otherHomeInput = { kind: 'stay', name: 'Other Cabin', stay: {
      location_id: locations.data!.locations[0]!.id, check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 1,
      assigned_member_id: null, assigned_team_id: null,
    } }
    const otherHomeRequest = { idempotency_key: crypto.randomUUID(), products: [otherHomeInput] }
    const discovery = await mcpRequest(page.request, baseURL!, { method: 'tools/list' })
    expect(discovery.status()).toBe(200)
    const catalog = await discovery.json() as { result: { tools: Array<{ name: string; inputSchema: object; outputSchema: object }> } }
    const batchTool = catalog.result.tools.find(tool => tool.name === 'batch_create_products')
    const reconcileTool = catalog.result.tools.find(tool => tool.name === 'reconcile_products')
    const calendarTool = catalog.result.tools.find(tool => tool.name === 'get_stay_calendar')
    const arrivalTool = catalog.result.tools.find(tool => tool.name === 'update_stay_arrival_guide')
    for (const definition of [batchTool, reconcileTool, calendarTool, arrivalTool]) expect(definition).toBeDefined()
    const ajv = new Ajv({ strict: false, allErrors: true })
    const validateBatchInput = ajv.compile(batchTool!.inputSchema)
    const validateBatchOutput = ajv.compile(batchTool!.outputSchema)
    const validateReconcileInput = ajv.compile(reconcileTool!.inputSchema)
    const validateCalendar = ajv.compile(calendarTool!.outputSchema)
    const validateArrival = ajv.compile(arrivalTool!.outputSchema)
    const completeHomeRequest = { organization_id: organizationId, ...otherHomeRequest }
    expect(validateBatchInput(completeHomeRequest), JSON.stringify(validateBatchInput.errors)).toBe(true)
    expect(validateReconcileInput(completeHomeRequest), JSON.stringify(validateReconcileInput.errors)).toBe(true)
    const otherHomes = await call<{ products: Array<{ id: string }> }>('batch_create_products', otherHomeRequest)
    expect(otherHomes.error).toBeNull()
    expect(validateBatchOutput(otherHomes.data), JSON.stringify(validateBatchOutput.errors)).toBe(true)
    expect(otherHomes.data!.products).toHaveLength(1)
    const otherHome = otherHomes.data!.products[0]!
    const unpricedCalendar = await call<{ home: { product_id: string; base_price_minor: number | null }; nights: Array<{ price_minor: number | null }> }>('get_stay_calendar', { product_id: otherHome.id, from: localDay(0), to: localDay(2) })
    expect(unpricedCalendar.error).toBeNull()
    expect(validateCalendar(unpricedCalendar.data), JSON.stringify(validateCalendar.errors)).toBe(true)
    expect(unpricedCalendar.data!.home).toMatchObject({ product_id: otherHome.id, base_price_minor: null })
    expect(unpricedCalendar.data!.nights.map(night => night.price_minor)).toEqual([null, null])
    const homes = [assignedHome, { product_id: otherHome.id, location_id: locations.data!.locations[0]!.id }]
    const assigned = await call('update_product', { product_id: homes[0]!.product_id, stay: { assigned_member_id: memberId } })
    expect(assigned.error).toBeNull()
    const stays: Array<{ id: string }> = []
    for (const [index, home] of homes.entries()) {
      const made = await page.request.post(api('stays'), { data: { product_id: home.product_id, check_in_date: localDay(0), check_out_date: localDay(2), adults: 2,
        guest_name: index === 0 ? 'Ana' : 'Private', guest_surname: 'Silva', total_minor: 30_000, idempotency_key: crypto.randomUUID() } })
      await expectStatus(made, 201)
      stays.push((await made.json() as { stay: { id: string } }).stay)
    }

    if (concern === 'arrival-guide') {
      // The host's arrival guide writes through the existing private home API.
      // Each concern saves only its own fields; public house rules stay public.
      const productPath = `/dashboard/${slug}/products/${assignedHome.product_id}`
      const guide = {
        directions: 'Use the side gate by the blue postbox.',
        wifi_network: 'Cabin guest network',
        wifi_password: ' island breeze 42 ',
        house_manual: 'Turn off the air conditioning whenever you leave the cabin.',
        check_in_method: 'keypad',
        check_in_instructions: 'Enter 4826 then turn the brass handle.',
        checkout_instructions: [{ task: 'gather_towels', details: 'Leave used towels in the basket by the bathroom.' }],
      }
      const houseRules = 'Please keep the garden gate closed.'
      const houseRuleChoices = { pets_allowed: false, events_allowed: true, smoking_allowed: null, quiet_hours: true, commercial_photography_allowed: false, quiet_hours_start: '22:00', quiet_hours_end: '07:00' }
      const houseRuleLines = ['No pets', 'Events allowed', 'Quiet hours: 10:00 PM – 7:00 AM', 'No commercial photography or filming', houseRules]
      const sharedGarden = 'The shaded garden is shared with the neighbouring cabin.'
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`${productPath}/photo`)
      await page.getByRole('tab', { name: 'Arrival guide', exact: true }).click()
      await expect(page.getByRole('tab', { name: 'Arrival guide', exact: true })).toHaveAttribute('aria-selected', 'true')
      await page.getByTestId('editor-card-directions').click()
      const directionsPanel = page.locator('#dashboard-panel-product-directions')
      await directionsPanel.getByRole('textbox', { name: 'Directions', exact: true }).fill(guide.directions)
      const arrivalEndpoint = `/api/dashboard/stay-homes/${assignedHome.product_id}`
      const interceptArrival = (url: URL) => url.pathname === arrivalEndpoint
      let interruptedWrites = 0
      await page.route(interceptArrival, async route => {
        if (route.request().method() !== 'PATCH') return await route.continue()
        interruptedWrites += 1
        await route.abort('failed')
      })
      const failedDirectionWrite = page.waitForEvent('requestfailed', request => request.method() === 'PATCH' && new URL(request.url()).pathname === arrivalEndpoint)
      await directionsPanel.getByRole('button', { name: 'Save', exact: true }).click()
      expect((await failedDirectionWrite).failure()).toEqual({ errorText: 'net::ERR_FAILED' })
      await expect(directionsPanel.getByText('Failed to fetch', { exact: false })).toBeVisible()
      await expect(directionsPanel.getByRole('textbox', { name: 'Directions', exact: true })).toHaveValue(guide.directions)
      await expect(directionsPanel.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
      expect(interruptedWrites).toBe(1)
      const unwrittenGuide = await page.request.get(api(`stay-homes/${assignedHome.product_id}`))
      await expectStatus(unwrittenGuide, 200)
      expect((await unwrittenGuide.json() as { home: { directions: string | null } }).home.directions).toBeNull()
      await page.unroute(interceptArrival)
      await directionsPanel.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(directionsPanel).not.toBeVisible()
      await page.getByTestId('editor-card-directions').click()
      await expect(page).toHaveURL(url => url.pathname === `${productPath}/directions`)
      await page.reload()
      await expect(directionsPanel.getByRole('textbox', { name: 'Directions', exact: true })).toHaveValue(guide.directions)
      await directionsPanel.getByRole('textbox', { name: 'Directions', exact: true }).fill('This unsaved route must not replace the saved directions.')
      await directionsPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(directionsPanel).not.toBeVisible()
      await page.getByTestId('editor-card-wifi').click()
      const wifiPanel = page.locator('#dashboard-panel-product-wifi')
      await wifiPanel.getByRole('textbox', { name: 'Wifi network', exact: true }).fill(guide.wifi_network)
      await wifiPanel.getByLabel('Wifi password', { exact: true }).fill(guide.wifi_password)
      await wifiPanel.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(wifiPanel).not.toBeVisible()
      await page.getByTestId('editor-card-wifi').click()
      await wifiPanel.getByRole('textbox', { name: 'Wifi network', exact: true }).fill('An uncommitted network name')
      await page.getByTestId('editor-card-house-manual').click()
      const manualPanel = page.locator('#dashboard-panel-product-house-manual')
      await manualPanel.getByRole('textbox', { name: 'House manual', exact: true }).fill(guide.house_manual)
      await manualPanel.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(manualPanel).not.toBeVisible()
      await page.getByTestId('editor-card-wifi').click()
      await expect(wifiPanel.getByRole('textbox', { name: 'Wifi network', exact: true })).toHaveValue(guide.wifi_network)
      await expect(wifiPanel.getByLabel('Wifi password', { exact: true })).toHaveValue(guide.wifi_password)
      await wifiPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(wifiPanel).not.toBeVisible()
      await page.getByTestId('editor-card-check-in-method').click()
      const methodOverview = page.locator('#dashboard-panel-product-check-in-method')
      await methodOverview.getByRole('link', { name: 'Choose check-in method', exact: true }).click()
      const methodPanel = page.locator('#dashboard-panel-product-check-in-method-choice')
      await methodPanel.getByText('Keypad', { exact: true }).click()
      await expect(methodPanel.getByRole('radio', { name: /^Keypad/ })).toBeChecked()
      await methodPanel.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page).toHaveURL(url => url.pathname === `${productPath}/check-in-method`)
      await methodOverview.getByRole('link', { name: 'Edit check-in instructions', exact: true }).click()
      const instructionsPanel = page.locator('#dashboard-panel-product-check-in-instructions')
      await instructionsPanel.getByRole('textbox', { name: 'Check-in instructions', exact: true }).fill(guide.check_in_instructions)
      await instructionsPanel.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page).toHaveURL(url => url.pathname === `${productPath}/check-in-method`)
      // House rules distinguish an unanswered choice from an explicit No. The
      // focused text editor and preview retain pending rule and guest choices.
      await page.getByRole('tab', { name: 'Your space', exact: true }).click()
      await expect(page).toHaveURL(url => url.pathname === `${productPath}/photo` && !url.searchParams.has('guide'))
      const beforeRules = await call<{ product: Product }>('get_product', { product_id: assignedHome.product_id })
      expect(beforeRules.error).toBeNull()
      for (const key of [...Object.keys(houseRuleChoices), 'house_rules']) expect(beforeRules.data!.product.details).not.toHaveProperty(key)
      await page.getByTestId('editor-card-house-rules').click()
      const rulesPanel = page.locator('#dashboard-panel-product-house-rules')
      const pets = rulesPanel.getByRole('group', { name: 'Pets allowed', exact: true })
      const events = rulesPanel.getByRole('group', { name: 'Events allowed', exact: true })
      const smoking = rulesPanel.getByRole('group', { name: 'Smoking, vaping, e-cigarettes allowed', exact: true })
      const quiet = rulesPanel.getByRole('group', { name: 'Quiet hours', exact: true })
      const commercial = rulesPanel.getByRole('group', { name: 'Commercial photography and filming allowed', exact: true })
      const ruleGuests = rulesPanel.getByRole('spinbutton', { name: 'Number of guests', exact: true })
      const savedGuestsCard = page.getByTestId('editor-card-guests')
      const quietStart = rulesPanel.getByRole('combobox', { name: 'Quiet hours start', exact: true })
      const quietEnd = rulesPanel.getByRole('combobox', { name: 'Quiet hours end', exact: true })
      for (const group of [pets, events, smoking, quiet, commercial]) {
        await expect(group.getByRole('button', { name: 'Yes', exact: true })).toHaveAttribute('aria-pressed', 'false')
        await expect(group.getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'false')
      }
      await ruleGuests.fill('5')
      await ruleGuests.press('Enter')
      const petsNo = pets.getByRole('button', { name: 'No', exact: true })
      await petsNo.focus()
      await petsNo.press('Space')
      await expect(petsNo).toHaveAttribute('aria-pressed', 'true')
      await petsNo.press('Space')
      await expect(petsNo).toHaveAttribute('aria-pressed', 'false')
      await petsNo.press('Space')
      await events.getByRole('button', { name: 'Yes', exact: true }).click()
      await commercial.getByRole('button', { name: 'No', exact: true }).click()
      await quiet.getByRole('button', { name: 'Yes', exact: true }).click()
      await expect(rulesPanel.getByText('Choose a start time and an end time for quiet hours.', { exact: true })).toBeVisible()
      await expect(rulesPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
      await quietStart.click()
      await page.getByRole('option', { name: '22:00', exact: true }).click()
      await expect(rulesPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
      await quietEnd.click()
      await page.getByRole('option', { name: '07:00', exact: true }).click()
      await rulesPanel.getByRole('link', { name: /Check-in & checkout/ }).click()
      await expect(page).toHaveURL(`${productPath}/house-rules/arrival-time`)
      const rulesArrivalPanel = page.locator('#dashboard-panel-product-arrival-time')
      await rulesArrivalPanel.getByLabel(/^Start time/).fill('16:00')
      await rulesArrivalPanel.getByLabel(/^Time/).fill('10:00')
      await rulesArrivalPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(page).toHaveURL(`${productPath}/house-rules`)
      await expect(petsNo).toHaveAttribute('aria-pressed', 'true')
      await expect(ruleGuests).toHaveValue('5')
      await expect(quietStart).toContainText('22:00')
      await expect(savedGuestsCard.getByText('4 guests', { exact: true })).toBeVisible()
      const cancelledRuleTimes = await call<{ product: Product }>('get_product', { product_id: assignedHome.product_id })
      expect(cancelledRuleTimes.error).toBeNull()
      expect(cancelledRuleTimes.data!.product.stay).toMatchObject({ check_in_time: '15:00', check_out_time: '11:00', max_guests: 4 })
      await rulesPanel.getByRole('link', { name: /Check-in & checkout/ }).click()
      await expect(rulesArrivalPanel.getByLabel(/^Start time/)).toHaveValue('15:00')
      await expect(rulesArrivalPanel.getByLabel(/^Time/)).toHaveValue('11:00')
      await rulesArrivalPanel.getByLabel(/^Start time/).fill('')
      await expect(rulesArrivalPanel.getByText('Choose a check-in start time.', { exact: true })).toBeVisible()
      await expect(rulesArrivalPanel.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
      await rulesArrivalPanel.getByLabel(/^Start time/).fill('16:00')
      // Airbnb's check-in window: the end is Flexible until the host chooses an hour.
      const checkInEnd = rulesArrivalPanel.getByRole('combobox', { name: 'End time' })
      await expect(checkInEnd).toContainText('Flexible')
      await checkInEnd.click()
      await page.getByRole('option', { name: '21:00', exact: true }).click()
      await rulesArrivalPanel.getByLabel(/^Time/).fill('10:00')
      const rulesEndpoint = `/api/editor/organizations/${organizationId}/products/${assignedHome.product_id}`
      const interceptRules = (url: URL) => url.pathname === rulesEndpoint
      await page.route(interceptRules, async route => route.request().method() === 'PATCH' ? await route.abort('failed') : await route.continue())
      const interruptedRuleTimes = page.waitForEvent('requestfailed', outgoing => outgoing.method() === 'PATCH' && new URL(outgoing.url()).pathname === rulesEndpoint)
      await rulesArrivalPanel.getByRole('button', { name: 'Save', exact: true }).click()
      const failedRuleTimesRequest = await interruptedRuleTimes
      expect(failedRuleTimesRequest.failure()).toEqual({ errorText: 'net::ERR_FAILED' })
      expect(failedRuleTimesRequest.postDataJSON()).toEqual({ stay: { check_in_time: '16:00', check_in_end_time: '21:00', check_out_time: '10:00' } })
      await expect(rulesArrivalPanel.getByText('Failed to fetch', { exact: false })).toBeVisible()
      await expect(rulesArrivalPanel.getByLabel(/^Start time/)).toHaveValue('16:00')
      await expect(checkInEnd).toContainText('21:00')
      await expect(rulesArrivalPanel.getByLabel(/^Time/)).toHaveValue('10:00')
      const failedRuleTimes = await call<{ product: Product }>('get_product', { product_id: assignedHome.product_id })
      expect(failedRuleTimes.error).toBeNull()
      expect(failedRuleTimes.data!.product.stay).toMatchObject({ check_in_time: '15:00', check_in_end_time: null, check_out_time: '11:00', max_guests: 4 })
      expect(failedRuleTimes.data!.product.details).toEqual(beforeRules.data!.product.details)
      await page.unroute(interceptRules)
      const ruleTimesSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === rulesEndpoint)
      await rulesArrivalPanel.getByRole('button', { name: 'Save', exact: true }).click()
      const ruleTimesResponse = await ruleTimesSaved
      await expectStatus(ruleTimesResponse, 200)
      expect(ruleTimesResponse.request().postDataJSON()).toEqual({ stay: { check_in_time: '16:00', check_in_end_time: '21:00', check_out_time: '10:00' } })
      await expect(page).toHaveURL(`${productPath}/house-rules`)
      await expect(petsNo).toHaveAttribute('aria-pressed', 'true')
      await expect(ruleGuests).toHaveValue('5')
      await expect(quietStart).toContainText('22:00')
      await expect(quietEnd).toContainText('07:00')
      const savedRuleTimes = await call<{ product: Product }>('get_product', { product_id: assignedHome.product_id })
      expect(savedRuleTimes.error).toBeNull()
      expect(savedRuleTimes.data!.product.stay).toMatchObject({ check_in_time: '16:00', check_in_end_time: '21:00', check_out_time: '10:00', max_guests: 4 })
      expect(savedRuleTimes.data!.product.details).toEqual(beforeRules.data!.product.details)
      const newerDetail = await call('update_product', { product_id: assignedHome.product_id, details_mode: 'merge', details: { guest_access: sharedGarden } })
      expect(newerDetail.error).toBeNull()
      await rulesPanel.getByRole('link', { name: /Additional rules/ }).click()
      const additionalRulesPanel = page.locator('#dashboard-panel-product-additional-rules')
      const additionalRules = additionalRulesPanel.getByRole('textbox', { name: 'Additional rules', exact: true })
      await additionalRules.fill('An additional rule that must be discarded.')
      await additionalRulesPanel.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(page).toHaveURL(`${productPath}/house-rules`)
      await expect(petsNo).toHaveAttribute('aria-pressed', 'true')
      await expect(ruleGuests).toHaveValue('5')
      await rulesPanel.getByRole('link', { name: /Additional rules/ }).click()
      await expect(additionalRules).toHaveValue('')
      await additionalRules.fill(houseRules)
      await expect(additionalRulesPanel).toBeVisible()
      await page.route(interceptRules, async route => route.request().method() === 'PATCH' ? await route.abort('failed') : await route.continue())
      const interruptedAdditional = page.waitForEvent('requestfailed', outgoing => outgoing.method() === 'PATCH' && new URL(outgoing.url()).pathname === rulesEndpoint)
      await additionalRulesPanel.getByRole('button', { name: 'Save', exact: true }).click()
      const failedAdditionalRequest = await interruptedAdditional
      expect(failedAdditionalRequest.failure()).toEqual({ errorText: 'net::ERR_FAILED' })
      expect(failedAdditionalRequest.postDataJSON()).toEqual({ details_mode: 'merge', details: { house_rules: houseRules } })
      await expect(additionalRulesPanel.getByText('Failed to fetch', { exact: false })).toBeVisible()
      await expect(additionalRules).toHaveValue(houseRules)
      await expect(rulesPanel.getByRole('link', { name: /Additional rules/ })).toContainText('Add details')
      const failedAdditional = await call<{ product: Product }>('get_product', { product_id: assignedHome.product_id })
      expect(failedAdditional.error).toBeNull()
      expect(failedAdditional.data!.product.details).toEqual({ ...beforeRules.data!.product.details, guest_access: sharedGarden })
      expect(failedAdditional.data!.product.stay).toMatchObject({ check_in_time: '16:00', check_out_time: '10:00', max_guests: 4 })
      await page.unroute(interceptRules)
      const additionalSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === rulesEndpoint)
      await additionalRulesPanel.getByRole('button', { name: 'Save', exact: true }).click()
      const additionalResponse = await additionalSaved
      await expectStatus(additionalResponse, 200)
      expect(additionalResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: { house_rules: houseRules } })
      await expect(page).toHaveURL(`${productPath}/house-rules`)
      await expect(petsNo).toHaveAttribute('aria-pressed', 'true')
      await expect(quiet.getByRole('button', { name: 'Yes', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(ruleGuests).toHaveValue('5')
      await expect(savedGuestsCard.getByText('4 guests', { exact: true })).toBeVisible()
      const savedRulesCard = page.getByTestId('editor-card-house-rules')
      await expect(savedRulesCard).toContainText(houseRules)
      await expect(savedRulesCard).not.toContainText('No pets')
      const rulesSource = page.url()
      await page.locator('#dashboard-panel-product').getByRole('link', { name: 'View', exact: true }).click()
      const pendingRulesPreview = page.getByRole('dialog', { name: 'Listing preview', exact: true })
      const savedGuestRules = pendingRulesPreview.locator('iframe[title="Listing preview"]').contentFrame()
      await expect(savedGuestRules.getByRole('heading', { name: 'Assigned Cabin', exact: true, level: 1 })).toBeVisible()
      await expect(savedGuestRules.getByText(houseRules, { exact: true })).toHaveCount(0)
      await expect(savedGuestRules.locator('#things-to-know')).toHaveCount(0)
      await expect(savedGuestRules.locator('article')).toContainText('4 guests')
      await expect(savedGuestRules.getByText('No pets', { exact: true })).toHaveCount(0)
      await expect(savedGuestRules.getByText('Events allowed', { exact: true })).toHaveCount(0)
      await pendingRulesPreview.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(page).toHaveURL(rulesSource)
      await expect(petsNo).toHaveAttribute('aria-pressed', 'true')
      await expect(ruleGuests).toHaveValue('5')
      await page.route(interceptRules, async route => route.request().method() === 'PATCH' ? await route.abort('failed') : await route.continue())
      const interruptedRules = page.waitForEvent('requestfailed', outgoing => outgoing.method() === 'PATCH' && new URL(outgoing.url()).pathname === rulesEndpoint)
      await rulesPanel.getByRole('button', { name: 'Save', exact: true }).click()
      expect((await interruptedRules).failure()).toEqual({ errorText: 'net::ERR_FAILED' })
      await expect(rulesPanel.getByText('Failed to fetch', { exact: false })).toBeVisible()
      await expect(petsNo).toHaveAttribute('aria-pressed', 'true')
      await expect(events.getByRole('button', { name: 'Yes', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(commercial.getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(quietStart).toContainText('22:00')
      await expect(quietEnd).toContainText('07:00')
      await expect(ruleGuests).toHaveValue('5')
      await expect(savedRulesCard).toContainText(houseRules)
      await expect(savedRulesCard).not.toContainText('No pets')
      const failedRules = await call<{ product: Product }>('get_product', { product_id: assignedHome.product_id })
      expect(failedRules.error).toBeNull()
      expect(failedRules.data!.product.details).toEqual({ ...beforeRules.data!.product.details, guest_access: sharedGarden, house_rules: houseRules })
      expect(failedRules.data!.product.stay!.max_guests).toBe(4)
      await page.unroute(interceptRules)
      const rulesSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === rulesEndpoint)
      await rulesPanel.getByRole('button', { name: 'Save', exact: true }).click()
      const rulesResponse = await rulesSaved
      await expectStatus(rulesResponse, 200)
      expect(rulesResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: houseRuleChoices, stay: { max_guests: 5 } })
      await expect(rulesPanel).not.toBeVisible()
      const authoredRules = await call<{ product: Product }>('get_product', { product_id: assignedHome.product_id })
      expect(authoredRules.error).toBeNull()
      expect(authoredRules.data!.product.details).toEqual({ ...beforeRules.data!.product.details, guest_access: sharedGarden, house_rules: houseRules, pets_allowed: false, events_allowed: true, commercial_photography_allowed: false, quiet_hours: true, quiet_hours_start: '22:00', quiet_hours_end: '07:00' })
      expect(authoredRules.data!.product.stay!.max_guests).toBe(5)
      await expect(savedGuestsCard.getByText('5 guests', { exact: true })).toBeVisible()

      // Clearing a choice removes its value; disabling quiet hours removes its
      // range. Clearing the separate text concern never commits pending toggles.
      await page.getByTestId('editor-card-house-rules').click()
      await petsNo.click()
      await quiet.getByRole('button', { name: 'No', exact: true }).click()
      await expect(quietStart).toHaveCount(0)
      await rulesPanel.getByRole('link', { name: /Additional rules/ }).click()
      await additionalRules.fill('')
      const additionalCleared = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === rulesEndpoint)
      await additionalRulesPanel.getByRole('button', { name: 'Save', exact: true }).click()
      const additionalClearResponse = await additionalCleared
      await expectStatus(additionalClearResponse, 200)
      expect(additionalClearResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: { house_rules: null } })
      await expect(page).toHaveURL(`${productPath}/house-rules`)
      await expect(petsNo).toHaveAttribute('aria-pressed', 'false')
      await expect(quiet.getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'true')
      const rulesCleared = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === rulesEndpoint)
      await rulesPanel.getByRole('button', { name: 'Save', exact: true }).click()
      const rulesClearResponse = await rulesCleared
      await expectStatus(rulesClearResponse, 200)
      expect(rulesClearResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: { ...houseRuleChoices, pets_allowed: null, quiet_hours: false, quiet_hours_start: null, quiet_hours_end: null } })
      await expect(rulesPanel).not.toBeVisible()
      const clearedRules = await call<{ product: Product }>('get_product', { product_id: assignedHome.product_id })
      expect(clearedRules.error).toBeNull()
      expect(clearedRules.data!.product.details).toEqual({ ...beforeRules.data!.product.details, guest_access: sharedGarden, events_allowed: true, commercial_photography_allowed: false, quiet_hours: false })
      await page.getByTestId('editor-card-house-rules').click()
      await expect(page).toHaveURL(`${productPath}/house-rules`)
      await expect(ruleGuests).toBeVisible()
      await page.reload()
      await expect(petsNo).toHaveAttribute('aria-pressed', 'false')
      await expect(pets.getByRole('button', { name: 'Yes', exact: true })).toHaveAttribute('aria-pressed', 'false')
      await expect(quiet.getByRole('button', { name: 'No', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(quietStart).toHaveCount(0)
      await expect(ruleGuests).toHaveValue('5')
      await petsNo.click()
      await quiet.getByRole('button', { name: 'Yes', exact: true }).click()
      await quietStart.click()
      await page.getByRole('option', { name: '22:00', exact: true }).click()
      await quietEnd.click()
      await page.getByRole('option', { name: '07:00', exact: true }).click()
      await rulesPanel.getByRole('link', { name: /Additional rules/ }).click()
      await expect(additionalRules).toHaveValue('')
      await additionalRules.fill(houseRules)
      await additionalRulesPanel.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page).toHaveURL(`${productPath}/house-rules`)
      await expect(petsNo).toHaveAttribute('aria-pressed', 'true')
      await expect(ruleGuests).toHaveValue('5')
      const rulesRestored = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === rulesEndpoint)
      await rulesPanel.getByRole('button', { name: 'Save', exact: true }).click()
      const rulesRestoreResponse = await rulesRestored
      await expectStatus(rulesRestoreResponse, 200)
      expect(rulesRestoreResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: houseRuleChoices })
      await expect(rulesPanel).not.toBeVisible()
      await page.getByRole('tab', { name: 'Arrival guide', exact: true }).click()
      await expect(page.getByRole('tab', { name: 'Arrival guide', exact: true })).toHaveAttribute('aria-selected', 'true')
      await page.getByTestId('editor-card-checkout-instructions').click()
      const checkoutOverview = page.locator('#dashboard-panel-product-checkout-instructions')
      await checkoutOverview.getByRole('link', { name: 'Add instructions', exact: true }).click()
      const instructionChoices = page.locator('#dashboard-panel-product-checkout-instruction-choices')
      await instructionChoices.getByRole('link', { name: 'Gather used towels', exact: true }).click()
      const checkoutPanel = page.locator('#dashboard-panel-product-checkout-instruction')
      await checkoutPanel.getByRole('textbox', { name: 'Gather used towels', exact: true }).fill(guide.checkout_instructions[0]!.details)
      await checkoutPanel.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page).toHaveURL(url => url.pathname === `${productPath}/checkout-instructions`)
      await checkoutOverview.getByTestId('list-editor-toggle').click()
      await checkoutOverview.getByRole('button', { name: 'Remove Gather used towels', exact: true }).click()
      await checkoutOverview.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(checkoutOverview.getByRole('link', { name: /Gather used towels/ })).toContainText(guide.checkout_instructions[0]!.details)
      await checkoutOverview.getByRole('link', { name: /Gather used towels/ }).click()
      await checkoutPanel.getByRole('button', { name: 'Remove instruction', exact: true }).click()
      await expect(page).toHaveURL(url => url.pathname === `${productPath}/checkout-instructions`)
      const removedInstruction = await page.request.get(api(`stay-homes/${assignedHome.product_id}`))
      await expectStatus(removedInstruction, 200)
      expect((await removedInstruction.json() as { home: { checkout_instructions: unknown[] } }).home.checkout_instructions).toEqual([])
      await checkoutOverview.getByRole('link', { name: 'Add instructions', exact: true }).click()
      await instructionChoices.getByRole('link', { name: 'Gather used towels', exact: true }).click()
      await checkoutPanel.getByRole('textbox', { name: 'Gather used towels', exact: true }).fill(guide.checkout_instructions[0]!.details)
      await checkoutPanel.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page).toHaveURL(url => url.pathname === `${productPath}/checkout-instructions`)

      const guideRead = await call<{ home: Record<string, unknown> }>('get_stay_calendar', { product_id: assignedHome.product_id, from: localDay(0), to: localDay(2) })
      expect(guideRead.error).toBeNull()
      expect(validateCalendar(guideRead.data), JSON.stringify(validateCalendar.errors)).toBe(true)
      expect(guideRead.data!.home).toEqual({ product_id: assignedHome.product_id, name: 'Assigned Cabin', location_id: assignedHome.location_id, timezone: TIME_ZONE, currency: 'THB', base_price_minor: 320_000, base_price_tax_behavior: 'unspecified', check_in_time: '16:00', check_in_end_time: '21:00', check_out_time: '10:00', max_guests: 5, min_nights: 1, channel: null })
      const guideSaved = await call<{ product_id: string; guide: { directions: string }; channel_push: unknown; airbnb_unsynced: unknown[] }>('update_stay_arrival_guide', { product_id: assignedHome.product_id, directions: guide.directions })
      expect(guideSaved.error).toBeNull()
      expect(validateArrival(guideSaved.data), JSON.stringify(validateArrival.errors)).toBe(true)
      expect(guideSaved.data).toEqual({ product_id: assignedHome.product_id, guide: { directions: guide.directions }, channel_push: null, airbnb_unsynced: [] })
      const managerGuide = await page.request.get(api(`stay-homes/${assignedHome.product_id}`))
      await expectStatus(managerGuide, 200)
      expect(managerGuide.headers()['cache-control']).toBe('private, no-store, max-age=0')
      expect(await managerGuide.json()).toMatchObject({ manage: true, home: guide })
      const publicRules = await call<{ product: Product }>('get_product', { product_id: assignedHome.product_id })
      expect(publicRules.error).toBeNull()
      expect(publicRules.data!.product.details).toEqual({ ...beforeRules.data!.product.details, guest_access: sharedGarden, house_rules: houseRules, pets_allowed: false, events_allowed: true, commercial_photography_allowed: false, quiet_hours: true, quiet_hours_start: '22:00', quiet_hours_end: '07:00' })
      expect(publicRules.data!.product.stay).toMatchObject({ check_in_time: '16:00', check_out_time: '10:00', max_guests: 5 })
      await expect(checkoutOverview).toBeVisible()

      // The private View remains on the authenticated dashboard. The public
      // listing omits post-booking rules while its API preserves the saved data.
      const privateView = page.locator('#dashboard-panel-product').getByRole('link', { name: 'View', exact: true })
      const privateURL = new URL((await privateView.getAttribute('href'))!, baseURL!)
      expect(privateURL.pathname).toBe(new URL(page.url()).pathname)
      expect(privateURL.searchParams.get('editMode')).toBe('preview')
      expect(privateURL.searchParams.get('guide')).toBe('arrival')
      expect(privateURL.searchParams.has('preview_token')).toBe(false)
      await privateView.click()
      await expect(page).toHaveURL(privateURL.href)
      const privatePreview = page.getByRole('dialog', { name: 'Arrival guide', exact: true })
      const privateGuide = privatePreview.getByTestId('arrival-guide-preview')
      await expect(privateGuide).toBeVisible()
      await expect(privatePreview.getByTestId('preview-share')).toHaveCount(0)
      await expect(privatePreview.getByTestId('content-preview-frame')).toHaveCount(0)
      for (const value of [guide.directions, guide.wifi_network, guide.wifi_password, guide.house_manual, guide.check_in_instructions, guide.checkout_instructions[0]!.details, houseRules]) await expect(privateGuide).toContainText(value)
      const privateRules = privateGuide.getByRole('heading', { name: 'House rules', exact: true }).locator('..')
      for (const line of houseRuleLines) await expect(privateRules.getByText(line, { exact: true })).toHaveCount(1)
      await expect(privateRules.getByText('No smoking, vaping or e-cigarettes', { exact: true })).toHaveCount(0)
      await expect(privateRules.getByText('Smoking, vaping and e-cigarettes allowed', { exact: true })).toHaveCount(0)
      await expect(privateGuide.getByRole('heading', { name: 'Safety & property', exact: true })).toHaveCount(0)
      await privatePreview.getByRole('button', { name: 'Close', exact: true }).click()
      const anonymous = await browser.newContext({ baseURL: baseURL! })
      try {
        const privateDenied = await anonymous.request.get(privateURL.href, { maxRedirects: 0 })
        expect(privateDenied.status()).toBe(302)
        const loginURL = new URL(privateDenied.headers().location!, baseURL!)
        expect(loginURL.pathname).toBe('/login')
        expect(loginURL.searchParams.get('redirect')).toBe(`${privateURL.pathname}${privateURL.search}`)
        const homeDenied = await anonymous.request.get(api(`stay-homes/${assignedHome.product_id}`))
        expect(homeDenied.status()).toBe(401)
        expect(await homeDenied.json()).toMatchObject({ data: { code: 'UNAUTHORIZED' } })
      } finally { await anonymous.close() }
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`${productPath}/wifi?guide=arrival`)
      await expect(wifiPanel.getByRole('textbox', { name: 'Wifi network', exact: true })).toHaveValue(guide.wifi_network)
      await expect(wifiPanel).toBeVisible()
      await wifiPanel.getByTestId('dashboard-navbar-close').hover()
      await expect(wifiPanel.getByRole('button', { name: 'Save', exact: true })).toBeInViewport()
      await wifiPanel.getByRole('textbox', { name: 'Wifi network', exact: true }).fill('A cancelled mobile network draft')
      await wifiPanel.getByRole('link', { name: 'Close', exact: true }).click()
      await expect(page).toHaveURL(url => url.pathname === productPath && url.searchParams.get('guide') === 'arrival')
      const cancelledGuide = await page.request.get(api(`stay-homes/${assignedHome.product_id}`))
      await expectStatus(cancelledGuide, 200)
      expect((await cancelledGuide.json() as { home: Record<string, unknown> }).home).toMatchObject(guide)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.getByRole('tab', { name: 'Your space', exact: true }).click()
      await expect(page).toHaveURL(url => url.pathname === `${productPath}/photo` && !url.searchParams.has('guide'))
      const publicView = page.locator('#dashboard-panel-product').getByRole('link', { name: 'View', exact: true })
      await expect(publicView).toHaveAttribute('href', /editMode=preview/)
      await publicView.click()
      const publicPreviewModal = page.getByRole('dialog', { name: 'Listing preview', exact: true })
      const publicIframe = publicPreviewModal.locator('iframe[title="Listing preview"]')
      const publicPreview = publicIframe.contentFrame()
      await expect(publicPreviewModal).toBeVisible()
      await expect(publicPreview.getByRole('heading', { name: 'Assigned Cabin', level: 1, exact: true })).toBeVisible()
      await expect(publicPreview.locator('#things-to-know')).toHaveCount(0)
      await expect(publicPreview.getByRole('heading', { name: 'House rules', exact: true })).toHaveCount(0)
      for (const line of [houseRules, ...houseRuleLines]) await expect(publicPreview.getByText(line, { exact: true })).toHaveCount(0)
      await expect(publicPreview.getByText(sharedGarden, { exact: true })).toHaveCount(1)
      for (const line of ['Pets allowed', 'No events', 'No quiet hours', 'No smoking, vaping or e-cigarettes', 'Smoking, vaping and e-cigarettes allowed']) await expect(publicPreview.getByText(line, { exact: true })).toHaveCount(0)
      const publicURL = new URL((await publicIframe.getAttribute('src'))!, baseURL!)
      expect(publicURL.searchParams.get('preview_token')).toBeTruthy()
      const publicResponse = await page.request.get(new URL(publicURL.pathname.replace(/^\/stays\//, '/api/public/stays/'), publicURL).href)
      await expectStatus(publicResponse, 200)
      const publicPayload = await publicResponse.json() as { product: { details: Record<string, unknown>; stay: Record<string, unknown> } }
      expect(publicPayload.product.details).toEqual(publicRules.data!.product.details)
      for (const key of STAY_SAFETY_DETAIL_KEYS) expect(publicPayload.product.details).not.toHaveProperty(key)
      await expect(publicPreview.getByRole('heading', { name: 'Safety & property', exact: true })).toHaveCount(0)
      expect(publicPayload.product.stay).toMatchObject({ check_in_time: '16:00', check_out_time: '10:00', max_guests: 5 })
      expect(publicPayload.product.stay).toMatchObject({ listing_type: null, total_floors: null, listing_floor: null, year_built: null, property_size: null, property_size_unit: null })
      for (const label of ['Listing type', 'Floors in building', 'Listing floor', 'Year built', 'Property size']) await expect(publicPreview.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) })).toHaveCount(0)
      const unprovidedPropertySchema = publicPreview.locator('script[type="application/ld+json"]')
      await expect(unprovidedPropertySchema).toHaveCount(1)
      const unknownAccommodation = (JSON.parse((await unprovidedPropertySchema.textContent())!) as { '@graph': Array<Record<string, unknown>> })['@graph'].find(node => node['@type'] === 'Accommodation')
      expect(unknownAccommodation).toBeDefined()
      expect(unknownAccommodation).not.toHaveProperty('additionalType')
      expect(unknownAccommodation).not.toHaveProperty('floorSize')
      for (const name of ['totalFloors', 'listingFloor', 'yearBuilt']) expect(unknownAccommodation!.additionalProperty).not.toContainEqual(expect.objectContaining({ name }))
      for (const field of Object.keys(guide)) expect(publicPayload.product.stay).not.toHaveProperty(field)
      const publicHTML = await publicPreview.locator('html').innerHTML()
      const publicJSON = JSON.stringify(publicPayload)
      for (const value of [guide.directions, guide.wifi_network, guide.wifi_password.trim(), guide.house_manual, guide.check_in_instructions, guide.checkout_instructions[0]!.details]) {
        expect(publicHTML).not.toContain(value)
        expect(publicJSON).not.toContain(value)
      }
      await publicPreviewModal.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(page).toHaveURL(`${baseURL}${productPath}/photo`)

      // Reading the new private home endpoint follows the same assigned-home
      // scope as Today. A member can read the guide but cannot change it.
      const assignedGuide = await cleaner.request.get(api(`stay-homes/${assignedHome.product_id}`))
      await expectStatus(assignedGuide, 200)
      expect(await assignedGuide.json()).toMatchObject({ manage: false, home: guide })
      const memberWrite = await cleaner.request.patch(api(`stay-homes/${assignedHome.product_id}`), { data: { wifi_password: 'A member must not replace this' } })
      expect(memberWrite.status()).toBe(403)
      expect(await memberWrite.json()).toMatchObject({ data: { code: 'STAY_ROLE_REQUIRED' } })
      const hiddenGuide = await cleaner.request.get(api(`stay-homes/${otherHome.id}`))
      expect(hiddenGuide.status()).toBe(404)
      expect(await hiddenGuide.json()).toMatchObject({ data: { code: 'HOME_NOT_FOUND' } })
      const outsider = await browser.newContext({ baseURL: baseURL! })
      try {
        await loginAs(outsider.request, baseURL!, 'user-e2e-mcp-fresh-inaccessible')
        const outsideGuide = await outsider.request.get(api(`stay-homes/${assignedHome.product_id}`))
        expect(outsideGuide.status()).toBe(404)
        expect(await outsideGuide.json()).toMatchObject({ data: { code: 'ORGANIZATION_NOT_FOUND' } })
      } finally { await outsider.close() }
      const protectedGuide = await page.request.get(api(`stay-homes/${assignedHome.product_id}`))
      await expectStatus(protectedGuide, 200)
      expect((await protectedGuide.json() as { home: Record<string, unknown> }).home).toMatchObject(guide)

    } else {
      // Calendar edits target one explicit home and inclusive selected nights.
      // Native and MCP readers independently verify every saved override.
      await page.setViewportSize({ width: 1440, height: 900 })
      const calendarPath = `/dashboard/${slug}/calendar?product_id=${assignedHome.product_id}`
      await page.goto(`/dashboard/${slug}/calendar?product_id=missing-home`)
      await expect(page.getByText('That offering is not available in this organization.', { exact: true })).toBeVisible()
      await expect(page.getByTestId('stay-night-inspector')).toHaveCount(0)
      await expect(page.getByRole('combobox', { name: 'Calendar', exact: true })).toHaveCount(0)
      await page.goto(calendarPath)
      const calendar = page.locator('#dashboard-panel-stay-night-calendar')
      const inspector = page.getByTestId('stay-night-inspector')
      await expect(calendar.getByRole('combobox', { name: 'Calendar', exact: true })).toContainText('Availability: Assigned Cabin')
      await expect(calendar.getByText(`${TIME_ZONE} · THB`, { exact: true })).toBeVisible()
      await calendar.locator(`[data-reka-calendar-cell-trigger][data-value="${localDay(0)}"]:not([data-outside-view])`).click()
      await expect(inspector.getByText('Reserved', { exact: true })).toBeVisible()
      await inspector.getByRole('button', { name: 'Select nights', exact: true }).click()
      const dates = page.getByRole('dialog', { name: 'Select nights', exact: true })
      await dates.getByLabel('Start night', { exact: true }).fill(localDay(5))
      await dates.getByLabel('End night (optional)', { exact: true }).fill(localDay(7))
      await dates.getByRole('button', { name: 'Edit selected nights', exact: true }).click()
      await expect(dates).not.toBeVisible()
      const openNights = inspector.getByRole('switch', { name: 'Open selected nights', exact: true })
      await expect(openNights).toBeChecked()
      await openNights.click()
      await expect(openNights).not.toBeChecked()
      const blockedResponse = await page.request.get(`${api(`stay-homes/${assignedHome.product_id}/calendar`)}&from=${localDay(5)}&to=${localDay(8)}`)
      await expectStatus(blockedResponse, 200)
      const blocked = await blockedResponse.json() as { nights: import('../../server/domain/stays').StayNight[] }
      expect(blocked.nights).toEqual([5, 6, 7].map(offset => expect.objectContaining({ date: localDay(offset), closed: true, available: false, price_minor: 320_000, stay_id: null })))
      await openNights.click()
      await expect(openNights).toBeChecked()
      await inspector.getByRole('button', { name: /^Nightly price/ }).click()
      await inspector.getByRole('textbox', { name: 'Nightly price (THB)', exact: true }).fill('4200')
      await inspector.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(inspector.getByRole('button', { name: /^Nightly price/ })).toContainText('4,200')
      const priced = await call<{ nights: import('../../server/domain/stays').StayNight[] }>('get_stay_calendar', { product_id: assignedHome.product_id, from: localDay(5), to: localDay(8) })
      expect(priced.error).toBeNull()
      expect(priced.data!.nights).toEqual([5, 6, 7].map(offset => expect.objectContaining({ date: localDay(offset), closed: false, available: true, price_minor: 420_000 })))
      await inspector.getByRole('button', { name: 'Custom settings', exact: true }).click()
      await inspector.getByRole('button', { name: 'Minimum nights', exact: true }).click()
      await inspector.getByRole('spinbutton', { name: 'Minimum nights on arrival', exact: true }).fill('2')
      await inspector.getByRole('spinbutton', { name: 'Minimum nights through stay', exact: true }).fill('3')
      await inspector.getByRole('button', { name: 'Save', exact: true }).click()
      await inspector.getByRole('button', { name: 'Custom settings', exact: true }).click()
      await inspector.getByRole('button', { name: 'Maximum nights', exact: true }).click()
      await inspector.getByRole('spinbutton', { name: 'Maximum nights', exact: true }).fill('7')
      await inspector.getByRole('button', { name: 'Save', exact: true }).click()
      await inspector.getByRole('button', { name: 'Custom settings', exact: true }).click()
      await inspector.getByRole('button', { name: 'Check-in and checkout', exact: true }).click()
      for (const label of ['Allow check-in', 'Allow checkout']) {
        await inspector.getByRole('combobox', { name: label, exact: true }).click()
        await page.getByRole('option', { name: 'Not allowed', exact: true }).click()
      }
      await inspector.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(inspector.getByRole('button', { name: 'Custom settings', exact: true })).toBeVisible()
      const restrictedResponse = await page.request.get(`${api(`stay-homes/${assignedHome.product_id}/calendar`)}&from=${localDay(5)}&to=${localDay(8)}`)
      await expectStatus(restrictedResponse, 200)
      expect((await restrictedResponse.json() as { nights: import('../../server/domain/stays').StayNight[] }).nights)
        .toEqual([5, 6, 7].map(offset => expect.objectContaining({ date: localDay(offset), closed: false, price_minor: 420_000, min_stay_arrival: 2, min_stay_through: 3, max_stay: 7, closed_to_arrival: true, closed_to_departure: true })))

      // Changing only the price across a mixed range preserves each night's own
      // stay restrictions, then restoring the base price preserves them again.
      await inspector.getByRole('button', { name: 'Select nights', exact: true }).click()
      await dates.getByLabel('Start night', { exact: true }).fill(localDay(6))
      await dates.getByLabel('End night (optional)', { exact: true }).fill(localDay(8))
      await dates.getByRole('button', { name: 'Edit selected nights', exact: true }).click()
      await expect(dates).not.toBeVisible()
      await expect(inspector.getByRole('button', { name: /^Nightly price/ })).toContainText('Mixed prices')
      await inspector.getByRole('button', { name: /^Nightly price/ }).click()
      await inspector.getByRole('textbox', { name: 'Nightly price (THB)', exact: true }).fill('4300')
      await inspector.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(inspector.getByRole('button', { name: /^Nightly price/ })).toContainText('4,300')
      const mixed = await call<{ nights: import('../../server/domain/stays').StayNight[] }>('get_stay_calendar', { product_id: assignedHome.product_id, from: localDay(5), to: localDay(9) })
      expect(mixed.error).toBeNull()
      expect(mixed.data!.nights).toEqual([5, 6, 7, 8].map(offset => expect.objectContaining({ date: localDay(offset), price_minor: offset === 5 ? 420_000 : 430_000,
        min_stay_arrival: offset < 8 ? 2 : null, min_stay_through: offset < 8 ? 3 : null, max_stay: offset < 8 ? 7 : null,
        closed_to_arrival: offset < 8, closed_to_departure: offset < 8, closed: false })))
      await inspector.getByRole('button', { name: /^Nightly price/ }).click()
      await inspector.getByRole('button', { name: 'Restore base nightly price', exact: true }).click()
      await expect(inspector.getByRole('button', { name: /^Nightly price/ })).toContainText('3,200')
      const restored = await call<{ nights: import('../../server/domain/stays').StayNight[] }>('get_stay_calendar', { product_id: assignedHome.product_id, from: localDay(6), to: localDay(9) })
      expect(restored.error).toBeNull()
      expect(restored.data!.nights).toEqual([6, 7, 8].map(offset => expect.objectContaining({ date: localDay(offset), price_minor: 320_000,
        min_stay_arrival: offset < 8 ? 2 : null, min_stay_through: offset < 8 ? 3 : null, max_stay: offset < 8 ? 7 : null,
        closed_to_arrival: offset < 8, closed_to_departure: offset < 8 })))

      // Returning the visible month to Today retains the distant selection and
      // its draft without reading all the intervening years of nights.
      const distantNight = localDay(4000)
      await inspector.getByRole('button', { name: 'Select nights', exact: true }).click()
      await dates.getByLabel('Start night', { exact: true }).fill(distantNight)
      await dates.getByLabel('End night (optional)', { exact: true }).fill('')
      await dates.getByRole('button', { name: 'Edit selected nights', exact: true }).click()
      await expect(dates).not.toBeVisible()
      await inspector.getByRole('button', { name: /^Nightly price/ }).click()
      await inspector.getByRole('textbox', { name: 'Nightly price (THB)', exact: true }).fill('5100')
      const visibleMonth = new Date(`${localDay(0).slice(0, 7)}-01T00:00:00Z`)
      const visibleFrom = new Date(visibleMonth.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
      const visibleTo = new Date(Date.UTC(visibleMonth.getUTCFullYear(), visibleMonth.getUTCMonth() + 1, 8)).toISOString().slice(0, 10)
      const calendarEndpoint = `/api/dashboard/stay-homes/${assignedHome.product_id}/calendar`
      const returnedWindows: string[] = []
      const observeCalendarRead = (request: import('@playwright/test').Request) => {
        const url = new URL(request.url())
        if (request.method() === 'GET' && url.pathname === calendarEndpoint) returnedWindows.push(`${url.searchParams.get('from')}:${url.searchParams.get('to')}`)
      }
      page.on('request', observeCalendarRead)
      const visibleMonthRead = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === calendarEndpoint
        && new URL(response.url()).searchParams.get('from') === visibleFrom && new URL(response.url()).searchParams.get('to') === visibleTo, { timeout: 10_000 })
      const distantSelectionRead = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === calendarEndpoint
        && new URL(response.url()).searchParams.get('from') === distantNight && new URL(response.url()).searchParams.get('to') === localDay(4001), { timeout: 10_000 })
      await calendar.getByRole('button', { name: 'Today', exact: true }).click()
      for (const response of await Promise.all([visibleMonthRead, distantSelectionRead])) await expectStatus(response, 200)
      await expect(page).toHaveURL(url => url.searchParams.get('month') === localDay(0).slice(0, 7))
      await expect(inspector.getByRole('textbox', { name: 'Nightly price (THB)', exact: true })).toBeEnabled()
      await expect(inspector.getByRole('textbox', { name: 'Nightly price (THB)', exact: true })).toHaveValue('5100')
      await expect(inspector.getByRole('button', { name: 'Select nights', exact: true })).toContainText(distantNight.slice(0, 4))
      expect([...new Set(returnedWindows)].sort()).toEqual([`${visibleFrom}:${visibleTo}`, `${distantNight}:${localDay(4001)}`].sort())
      page.off('request', observeCalendarRead)
      await inspector.getByRole('button', { name: 'Cancel', exact: true }).click()
      await inspector.getByRole('button', { name: 'Select nights', exact: true }).click()
      await expect(dates.getByLabel('Start night', { exact: true })).toHaveValue(distantNight)
      await dates.getByLabel('Start night', { exact: true }).fill(localDay(6))
      await dates.getByLabel('End night (optional)', { exact: true }).fill(localDay(8))
      await dates.getByRole('button', { name: 'Edit selected nights', exact: true }).click()
      await expect(dates).not.toBeVisible()
      await expect(inspector.getByRole('button', { name: /^Nightly price/ })).toContainText('3,200')

      // The mobile sheet and desktop inspector share one draft; cancelling it
      // returns to the saved price and leaves the persisted range unchanged.
      await page.setViewportSize({ width: 390, height: 844 })
      await calendar.getByRole('button', { name: /^Edit / }).click()
      await inspector.getByRole('button', { name: /^Nightly price/ }).click()
      await inspector.getByRole('textbox', { name: 'Nightly price (THB)', exact: true }).fill('9999')
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect(inspector.getByRole('textbox', { name: 'Nightly price (THB)', exact: true })).toHaveValue('9999')
      await inspector.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(inspector.getByRole('button', { name: /^Nightly price/ })).toContainText('3,200')
      await expect(inspector.getByText(`${TIME_ZONE} · THB`, { exact: true })).toBeVisible()
      const cancelledPrice = await page.request.get(`${api(`stay-homes/${assignedHome.product_id}/calendar`)}&from=${localDay(6)}&to=${localDay(9)}`)
      await expectStatus(cancelledPrice, 200)
      expect((await cancelledPrice.json() as { nights: import('../../server/domain/stays').StayNight[] }).nights.map(night => night.price_minor)).toEqual([320_000, 320_000, 320_000])
      await inspector.getByRole('button', { name: 'Custom settings', exact: true }).click()
      await inspector.getByRole('button', { name: 'Reset all night settings', exact: true }).click()
      await expect(inspector.getByText('Remove all selected nights’ custom prices, closures and stay rules.', { exact: false })).toBeVisible()
      await inspector.getByRole('button', { name: 'Reset all night settings', exact: true }).click()
      await expect(inspector.getByRole('button', { name: 'Custom settings', exact: true })).toBeVisible()
      const reset = await call<{ nights: import('../../server/domain/stays').StayNight[] }>('get_stay_calendar', { product_id: assignedHome.product_id, from: localDay(6), to: localDay(9) })
      expect(reset.error).toBeNull()
      expect(reset.data!.nights).toEqual([6, 7, 8].map(offset => expect.objectContaining({ date: localDay(offset), price_minor: 320_000, closed: false,
        min_stay_arrival: null, min_stay_through: null, max_stay: null, closed_to_arrival: false, closed_to_departure: false })))

      // Opening occupied nights changes only the host closure. The reservation
      // remains the canonical reason those nights cannot be booked again.
      await inspector.getByRole('button', { name: 'Select nights', exact: true }).click()
      await dates.getByLabel('Start night', { exact: true }).fill(localDay(0))
      await dates.getByLabel('End night (optional)', { exact: true }).fill(localDay(1))
      await dates.getByRole('button', { name: 'Edit selected nights', exact: true }).click()
      await expect(dates).not.toBeVisible()
      await expect(inspector.getByText('Reserved', { exact: true })).toBeVisible()
      await expect(openNights).toBeChecked()
      await openNights.click()
      await expect(openNights).not.toBeChecked()
      await openNights.click()
      await expect(openNights).toBeChecked()
      const occupied = await call<{ nights: import('../../server/domain/stays').StayNight[] }>('get_stay_calendar', { product_id: assignedHome.product_id, from: localDay(0), to: localDay(2) })
      expect(occupied.error).toBeNull()
      expect(occupied.data!.nights).toEqual([0, 1].map(offset => expect.objectContaining({ date: localDay(offset), stay_id: stays[0]!.id, available: false, closed: false })))
      const calendarStay = inspector.getByRole('link', { name: 'View stay', exact: true })
      const calendarStayURL = new URL((await calendarStay.getAttribute('href'))!, baseURL!)
      expect(calendarStayURL.pathname).toBe(`/dashboard/${slug}/calendar/stay/${stays[0]!.id}`)
      expect(calendarStayURL.searchParams.get('product_id')).toBe(assignedHome.product_id)
      expect(calendarStayURL.searchParams.get('month')).toBe(localDay(0).slice(0, 7))
      await calendarStay.click()
      await expect(page).toHaveURL(calendarStayURL.href)
      const calendarStayDetails = page.locator('#dashboard-panel-stay-details')
      await expect(calendarStayDetails.getByRole('heading', { name: 'Ana Silva', level: 2, exact: true })).toBeVisible()
      await page.setViewportSize({ width: 390, height: 844 })
      const stayBack = calendarStayDetails.getByTestId('dashboard-navbar-back')
      await expect(stayBack).toBeVisible()
      await expect(stayBack).toHaveAttribute('href', `/dashboard/${slug}/calendar${calendarStayURL.search}`)
      await stayBack.click()
      await expect(page).toHaveURL(`/dashboard/${slug}/calendar${calendarStayURL.search}`)
      await expect(inspector.getByText('Reserved', { exact: true })).toBeVisible()
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect(calendar).toBeVisible()
      await expect(calendar.getByRole('combobox', { name: 'Calendar', exact: true })).toContainText('Availability: Assigned Cabin')

      // The home's overview and agenda read the same stays as its nightly grid.
      await calendar.getByRole('button', { name: 'View: Month', exact: true }).click()
      await page.getByRole('menuitemcheckbox', { name: 'Year', exact: true }).click()
      await expect(page).toHaveURL(url => url.searchParams.get('view') === 'year')
      await expect(calendar.getByRole('button', { name: 'January', exact: true })).toBeVisible()
      await expect(calendar.getByRole('button', { name: 'December', exact: true })).toBeVisible()
      await calendar.getByRole('button', { name: 'View: Year', exact: true }).click()
      await page.getByRole('menuitemcheckbox', { name: 'List', exact: true }).click()
      await expect(calendar.getByRole('link', { name: /Ana Silva/ })).toHaveAttribute('href', new RegExp(`/calendar/stay/${stays[0]!.id}\\?`))
      await calendar.getByRole('button', { name: 'View: List', exact: true }).click()
      await page.getByRole('menuitemcheckbox', { name: 'Month', exact: true }).click()

      // Separate-night selection must not alter the unselected night between them.
      const separateFrom = new Date(Date.UTC(Number(localDay(0).slice(0, 4)), Number(localDay(0).slice(5, 7)), 10)).toISOString().slice(0, 10)
      const separateMiddle = new Date(Date.parse(`${separateFrom}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
      const separateLast = new Date(Date.parse(`${separateFrom}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10)
      const separateTo = new Date(Date.parse(`${separateFrom}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10)
      await inspector.getByRole('button', { name: 'Select nights', exact: true }).click()
      await dates.getByLabel('Start night', { exact: true }).fill(separateFrom)
      await dates.getByLabel('End night (optional)', { exact: true }).fill(separateLast)
      await dates.getByRole('button', { name: 'Edit selected nights', exact: true }).click()
      await calendar.locator(`[data-reka-calendar-cell-trigger][data-value="${separateMiddle}"]:not([data-outside-view])`).click()
      await expect(inspector.getByRole('button', { name: 'Select nights', exact: true })).toHaveText('2 separate nights')
      await inspector.getByRole('button', { name: /^Nightly price/ }).click()
      await inspector.getByRole('textbox', { name: 'Nightly price (THB)', exact: true }).fill('4600')
      await inspector.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(inspector.getByRole('button', { name: /^Nightly price/ })).toContainText('4,600')
      const separate = await call<{ nights: import('../../server/domain/stays').StayNight[] }>('get_stay_calendar', { product_id: assignedHome.product_id, from: separateFrom, to: separateTo })
      expect(separate.error).toBeNull()
      expect(separate.data!.nights.map(night => [night.date, night.price_minor])).toEqual([[separateFrom, 460_000], [separateMiddle, 320_000], [separateLast, 460_000]])

      const todayResponse = await cleaner.request.get(api('today'))
      await expectStatus(todayResponse, 200)
      const today = await todayResponse.json() as import('../../shared/dashboard-today').TodayFeedPayload
      const arrivalPath = `/dashboard/${slug}/bookings/stay/${stays[0]!.id}`
      expect(today.cards).toEqual([expect.objectContaining({ id: `stay:${stays[0]!.id}:arrival`, to: arrivalPath, priority: 'schedule', bookingKind: 'stay',
        headline: 'Ana arrives today with 2 guests', description: 'Assigned Cabin', locationId: homes[0]!.location_id })])
      expect(today.locations.map(location => location.id)).toEqual([homes[0]!.location_id])
      const upcomingResponse = await cleaner.request.get(api('today'), { params: { range: 'upcoming', from: localDay(1), to: localDay(7) } })
      await expectStatus(upcomingResponse, 200)
      const upcoming = await upcomingResponse.json() as import('../../shared/dashboard-today').TodayFeedPayload
      expect(upcoming.cards).toEqual([expect.objectContaining({ id: `stay:${stays[0]!.id}:departure`, to: arrivalPath, priority: 'schedule', bookingKind: 'stay',
        headline: 'Ana leaves in 2 days with 2 guests', description: 'Assigned Cabin', locationId: homes[0]!.location_id })])
      const denied = await cleaner.request.get(api(`stays/${stays[1]!.id}`))
      expect(denied.status()).toBe(404)
      const deniedLocation = await cleaner.request.get(api('today'), { params: { locationId: homes[1]!.location_id } })
      expect(deniedLocation.status()).toBe(404)

      const cleanerPage = await cleaner.newPage()
      let deliveringSocket: WebSocket | undefined
      const liveEvents: DashboardInvalidation[] = []
      cleanerPage.on('websocket', socket => {
        socket.on('framereceived', frame => {
          if (frame.payload === 'pong') return
          const event: unknown = JSON.parse(String(frame.payload))
          expect(isDashboardInvalidation(event)).toBe(true)
          if (isDashboardInvalidation(event)) {
            liveEvents.push(event)
            deliveringSocket = socket
          }
        })
      })
      await cleanerPage.setViewportSize({ width: 390, height: 844 })
      expect((await cleanerPage.goto(`/dashboard/${slug}`))?.status()).toBe(200)
      const arrival = cleanerPage.getByTestId('today-card')
      await expect(arrival).toHaveCount(1)
      await expect(arrival).toHaveAttribute('href', arrivalPath)
      await arrival.click()
      await expect(cleanerPage.getByRole('heading', { name: 'Ana Silva', level: 2, exact: true })).toBeVisible()
      await expect(cleanerPage.getByRole('button', { name: 'Cancel stay', exact: true })).toHaveCount(0)
      await expect(cleanerPage.getByRole('button', { name: 'Record payment', exact: true })).toHaveCount(0)
      await cleanerPage.goto(`/dashboard/${slug}?range=upcoming`)
      const departure = cleanerPage.getByTestId('today-card')
      await expect(departure).toHaveCount(1)
      await expect(departure).toContainText('Ana leaves in 2 days with 2 guests')
      await expect(departure).toHaveAttribute('href', `${arrivalPath}?range=upcoming`)
      await departure.click()
      await expect(cleanerPage.getByRole('heading', { name: 'Ana Silva', level: 2, exact: true })).toBeVisible()

      // Another device's edit updates the assigned stay without navigation. An
      // ordered later event proves that the intervening other-home event was filtered.
      const current = await call<{ stay: { version: number } }>('get_stay', { stay_id: stays[0]!.id })
      const renamed = await call<{ stay: { version: number }; saved_fields: Record<string, unknown>; channel_push: unknown }>('update_stay', { stay_id: stays[0]!.id, expected_version: current.data!.stay.version, guest_name: 'Ana Live' })
      expect(renamed.error).toBeNull()
      expect(renamed.data!.saved_fields).toEqual({ guest_name: 'Ana Live' })
      expect(renamed.data!.channel_push).toBeNull()
      await expect(cleanerPage.getByRole('heading', { name: 'Ana Live Silva', level: 2, exact: true })).toBeVisible()
      const privateStay = await call<{ stay: { version: number } }>('get_stay', { stay_id: stays[1]!.id })
      expect((await call('update_stay', { stay_id: stays[1]!.id, expected_version: privateStay.data!.stay.version, notes: 'Other home only' })).error).toBeNull()
      const noted = await call<{ stay: { version: number } }>('update_stay', { stay_id: stays[0]!.id, expected_version: renamed.data!.stay.version, notes: 'Visible live note' })
      expect(noted.error).toBeNull()
      await expect(cleanerPage.getByText('Visible live note', { exact: true })).toBeVisible()
      // The page can render the note before the socket's frame is recorded here.
      await expect.poll(() => liveEvents.filter(event => 'stayId' in event).length).toBe(2)
      expect(liveEvents.filter(event => 'stayId' in event).map(event => event.stayId)).toEqual([stays[0]!.id, stays[0]!.id])

      // A cookie cache read must not keep this socket authorized after sign-out.
      expect((await cleaner.request.get('/api/auth/get-session')).status()).toBe(200)
      const signedInSocket = deliveringSocket
      expect(signedInSocket).toBeDefined()
      expect(signedInSocket!.isClosed()).toBe(false)
      const signedOutClosed = signedInSocket!.waitForEvent('close')
      const signedOut = await cleaner.request.post('/api/auth/sign-out', { headers, data: {} })
      await expectStatus(signedOut, 200)
      const revoked = await cleaner.request.get('/api/auth/get-session', { params: { disableCookieCache: 'true' } })
      await expectStatus(revoked, 200)
      expect(await revoked.json()).toBeNull()
      const beforeRevokedEvent = liveEvents.length
      const afterSignOut = await call<{ stay: { version: number } }>('update_stay', { stay_id: stays[0]!.id, expected_version: noted.data!.stay.version, notes: 'After session revocation' })
      expect(afterSignOut.error).toBeNull()
      await signedOutClosed
      expect(liveEvents).toHaveLength(beforeRevokedEvent)
      const unauthenticatedSocket = await cleaner.request.get(api('guest-inbox/socket'))
      expect(unauthenticatedSocket.status()).toBe(401)
      expect(await unauthenticatedSocket.json()).toMatchObject({ data: { code: 'UNAUTHORIZED', field: 'session' } })
    }

  } finally {
    await cleaner.close()
  }
})

}

test('a stay socket in a service organization closes when Better Auth removes its membership', async ({ page, browser, baseURL }) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates local homes and disposable memberships')
  await loginAs(page.request, baseURL!, 'user-e2e-lodging-host')
  const headers = authRequestHeaders(baseURL!)
  const slug = `e2e-stay-live-${crypto.randomUUID().slice(0, 8)}`
  const created = await page.request.post('/api/auth/organization/create', { headers, data: { name: `Live ${slug}`, slug, default_currency: 'THB', timezone: TIME_ZONE } })
  await expectStatus(created, 200)
  const organizationId = (await created.json() as { id: string }).id
  const provisioned = await page.request.post('/api/organizations', { headers, data: { organizationId, name: `Live ${slug}`, subdomain: slug, vertical: 'service', sourceLocale: 'en' } })
  await expectStatus(provisioned, 200)
  const api = (path: string) => `/api/dashboard/${path}?org=${encodeURIComponent(slug)}`
  const cleaner = await browser.newContext({ baseURL: baseURL! })
  try {
    await loginAs(cleaner.request, baseURL!, 'user-e2e-demo-role-owner')
    const offered = await page.request.post(`/api/organizations/${organizationId}/invite-links`, { data: { role: 'member' } })
    await expectStatus(offered, 201)
    const accepted = await cleaner.request.post(`/api/invite-links/${encodeURIComponent((await offered.json() as { token: string }).token)}/accept`, { data: {} })
    await expectStatus(accepted, 200)
    const memberId = (await accepted.json() as { memberId: string }).memberId

    // The actual canonical home API decides whether this vertical supports a
    // home; there is no SQL fixture or environment bypass supplying one.
    const madeHome = await page.request.post(api('stay-homes'), { data: { name: 'Retreat Cabin', timezone: TIME_ZONE, address: '1 Retreat Road', city: 'Krabi', country: 'TH',
      state: null, zip_code: null, phone: null, email: null, check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 1,
      base_price_minor: null, idempotency_key: crypto.randomUUID() } })
    await expectStatus(madeHome, 201)
    const home = (await madeHome.json() as { home: { product_id: string } }).home
    const assigned = await page.request.patch(api(`stay-homes/${home.product_id}`), { data: { assigned_member_id: memberId } })
    await expectStatus(assigned, 200)
    const made = await page.request.post(api('stays'), { data: { product_id: home.product_id, check_in_date: localDay(0), check_out_date: localDay(2), adults: 1,
      guest_name: 'Membership Guest', total_minor: 0, idempotency_key: crypto.randomUUID() } })
    await expectStatus(made, 201)
    const stay = (await made.json() as { stay: { id: string; version: number } }).stay

    const cleanerPage = await cleaner.newPage()
    const sockets: WebSocket[] = []
    const liveEvents: DashboardInvalidation[] = []
    cleanerPage.on('websocket', socket => {
      sockets.push(socket)
      socket.on('framereceived', frame => {
        if (frame.payload === 'pong') return
        const event: unknown = JSON.parse(String(frame.payload))
        expect(isDashboardInvalidation(event)).toBe(true)
        if (isDashboardInvalidation(event)) liveEvents.push(event)
      })
    })
    const openedRead = cleanerPage.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/dashboard/stays/${stay.id}`)
    expect((await cleanerPage.goto(`/dashboard/${slug}/bookings/stay/${stay.id}`))?.status()).toBe(200)
    await expect(cleanerPage.getByRole('heading', { name: 'Membership Guest', level: 2, exact: true })).toBeVisible()
    // The real first-open reconciliation read proves the app socket completed
    // its upgrade before the other device publishes the event under assertion.
    expect((await openedRead).status()).toBe(200)
    const renamed = await page.request.patch(api(`stays/${stay.id}`), { data: { expected_version: stay.version, guest_name: 'Membership Live' } })
    await expectStatus(renamed, 200)
    const version = (await renamed.json() as { stay: { version: number } }).stay.version
    await expect(cleanerPage.getByRole('heading', { name: 'Membership Live', level: 2, exact: true })).toBeVisible()
    await expect.poll(() => liveEvents.filter(event => event.type === 'stay.changed').length).toBe(1)
    const socket = sockets.find(socket => !socket.isClosed())
    expect(socket).toBeDefined()
    const closed = socket!.waitForEvent('close')
    const removed = await page.request.post('/api/auth/organization/remove-member', { headers, data: { organizationId, memberIdOrEmail: memberId } })
    await expectStatus(removed, 200)
    const beforeRemoval = liveEvents.length
    const changed = await page.request.patch(api(`stays/${stay.id}`), { data: { expected_version: version, notes: 'After membership removal' } })
    await expectStatus(changed, 200)
    await closed
    expect(liveEvents).toHaveLength(beforeRemoval)
    // A removed member looks after no home, read back through the manager's list.
    const homes = await page.request.get(api('stay-homes'))
    await expectStatus(homes, 200)
    expect((await homes.json() as { homes: Array<{ product_id: string; assigned_member_id: string | null }> }).homes)
      .toEqual([expect.objectContaining({ product_id: home.product_id, assigned_member_id: null })])
  } finally {
    await cleaner.close()
  }
})
