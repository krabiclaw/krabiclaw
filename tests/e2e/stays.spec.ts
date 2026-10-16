import { expect, test, type APIRequestContext, type WebSocket } from '@playwright/test'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { mcpRequest } from './helpers/mcp'
import { isDashboardInvalidation, type DashboardInvalidation } from '../../shared/dashboard-invalidations'

// A host's place to stay, end to end through the surfaces that own it: the
// one Product editor creates the home, MCP adds a stay, Today and the stay's
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

test('a host creates a place to stay, sees its stay on Today, and records payment and cancellation', async ({ page, baseURL }) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates an organization; requires isolated local D1')
  const request = page.request
  await loginAs(request, baseURL!, 'user-e2e-lodging-host')
  const headers = authRequestHeaders(baseURL!)
  const slug = `e2e-stays-${crypto.randomUUID().slice(0, 8)}`
  const created = await request.post(`${baseURL}/api/auth/organization/create`, { headers, data: { name: `Stays ${slug}`, slug, default_currency: 'THB', timezone: TIME_ZONE } })
  expect(created.status(), await created.text()).toBe(200)
  const organizationId = (await created.json() as { id: string }).id
  const provisioned = await request.post(`${baseURL}/api/organizations`, { headers, data: { organizationId, name: `Stays ${slug}`, subdomain: slug, vertical: 'lodging', sourceLocale: 'en' } })
  expect(provisioned.status(), await provisioned.text()).toBe(200)
  expect((await request.post(`${baseURL}/api/auth/organization/set-active`, { headers, data: { organizationId } })).status()).toBe(200)
  const call = <T>(name: string, args: Record<string, unknown>) => tool<T>(request, baseURL!, organizationId, name, args)
  const locations = await call<{ locations: Array<{ id: string; title: string }> }>('list_locations', {})
  const location = locations.data!.locations[0]!
  expect(location).toBeTruthy()

  // The one Product editor walks a place to stay through its stay settings.
  await page.goto(`/dashboard/${slug}/products/new?kind=stay&location_id=${encodeURIComponent(location.id)}`)
  await page.getByRole('button', { name: 'Start with Name' }).click()
  await page.getByRole('textbox', { name: 'Name' }).fill('Cliff Cabin')
  await page.getByRole('button', { name: 'Next: Stay settings', exact: true }).click()
  await expect(page).toHaveURL(/\/products\/new\/stay/)
  await page.getByRole('textbox', { name: 'Sleeps' }).fill('4')
  await page.getByRole('textbox', { name: 'Minimum nights' }).fill('2')
  // The index offers the same create action; the leaf's own save commits what it shows.
  await page.locator('#dashboard-panel-product-stay').getByRole('button', { name: 'Create place to stay', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/${slug}/products/(?!new)[^/?]+`))
  const productId = new URL(page.url()).pathname.split('/')[4]!
  expect(productId).toMatch(/^[0-9a-f-]{36}$/)
  const home = await call<{ product: { kind: string; unit_label: string; stay: Record<string, unknown> } }>('get_product', { product_id: productId })
  expect(home.error).toBeNull()
  expect(home.data!.product).toMatchObject({ kind: 'stay', unit_label: 'night', stay: { location_id: location.id, check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 2 } })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/dashboard/${slug}/products`)
  const stayTile = page.getByTestId('catalog-section-stay').getByTestId(`selector-item-${productId}`)
  await expect(stayTile).toHaveAttribute('href', `/dashboard/${slug}/products/${productId}`)
  await expect(stayTile).toHaveAccessibleName('Cliff Cabin')
  await stayTile.click()
  await expect(page).toHaveURL(`/dashboard/${slug}/products/${productId}`)
  await expect(page.locator('#dashboard-panel-product').getByRole('heading', { name: 'Cliff Cabin', exact: true })).toBeVisible()

  // A stay arriving today holds its nights; another on them is refused.
  const checkIn = localDay(0)
  const checkOut = localDay(2)
  const stay = await call<{ stay: { id: string; version: number; status: string } }>('create_stay', {
    product_id: productId, check_in_date: checkIn, check_out_date: checkOut, adults: 2, guest_name: 'Ana', guest_surname: 'Silva', total_minor: 300_00, idempotency_key: `${slug}-a`,
  })
  expect(stay.error).toBeNull()
  const overlap = await call('create_stay', { product_id: productId, check_in_date: localDay(1), check_out_date: localDay(3), adults: 1, guest_name: 'Bo', total_minor: 100_00, idempotency_key: `${slug}-b` })
  expect(overlap.error).toContain('Another stay already holds one of these nights')

  // Today lists the arrival and opens the stay.
  await page.goto(`/dashboard/${slug}`)
  // Today's card names the guest by first name and the moment: arriving, at the home's check-in time.
  const arrival = page.getByRole('link', { name: /3:00\sPM Ana arrives today with 2 guests/ })
  await expect(arrival).toHaveAttribute('href', `/dashboard/${slug}/bookings/stay/${stay.data!.stay.id}`)
  await arrival.click()
  await expect(page.getByRole('heading', { name: 'Ana Silva', level: 1, exact: true })).toBeVisible()

  await page.getByRole('textbox', { name: 'Amount (THB)' }).fill('100')
  await page.getByRole('button', { name: 'Record payment' }).click()
  // The recorded row, not the method picker: it names the amount with its method.
  await expect(page.getByRole('listitem').filter({ hasText: /100\.00 · Cash/ })).toBeVisible()
  const paid = await call<{ stay: { paid_minor: number; payment_status: string; payments: Array<{ method: string; amount_minor: number }> } }>('get_stay', { stay_id: stay.data!.stay.id })
  expect(paid.data!.stay).toMatchObject({ paid_minor: 100_00, payment_status: 'partial', payments: [{ method: 'cash', amount_minor: 100_00 }] })

  await page.getByRole('button', { name: 'Cancel stay' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel stay' }).click()
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible()
  const calendar = await call<{ nights: Array<{ date: string; available: boolean }> }>('get_stay_calendar', { product_id: productId, from: checkIn, to: checkOut })
  expect(calendar.data!.nights.map(night => night.available)).toEqual([true, true])
  const cancelled = await call<{ stay: { status: string; cancelled_at: string | null } }>('get_stay', { stay_id: stay.data!.stay.id })
  expect(cancelled.data!.stay.status).toBe('cancelled')
  expect(cancelled.data!.stay.cancelled_at).toBeTruthy()

  // The native app's routes are the same domain: every write is read back through MCP.
  const api = (path: string) => `${baseURL}/api/dashboard/${path}${path.includes('?') ? '&' : '?'}org=${encodeURIComponent(slug)}`
  const homes = await request.get(api('stay-homes'))
  expect(homes.status(), await homes.text()).toBe(200)
  // The editor created the home without a nightly price, so it has no base price; its currency is the organization's.
  expect((await homes.json() as { homes: unknown[] }).homes).toEqual([{
    product_id: productId, name: 'Cliff Cabin', location_id: location.id, timezone: TIME_ZONE, currency: 'THB', base_price_minor: null, base_price_tax_behavior: null,
    check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 2, assigned_member_id: null, assigned_team_id: null, channel: null,
    check_in_instructions: null, photos: [],
  }])

  // A home's photos are its product's media; the photo routes refuse what is not a photo before storing anything.
  const photos = api(`stay-homes/${productId}/photos`)
  const ordered = await request.put(photos, { headers, data: { photo_ids: [] } })
  expect(ordered.status(), await ordered.text()).toBe(200)
  expect((await ordered.json() as { home: { photos: unknown[] } }).home.photos).toEqual([])
  const notAPhoto = await request.post(photos, { headers, multipart: { image: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') } } })
  expect(notAPhoto.status(), await notAPhoto.text()).toBe(415)
  expect(await notAPhoto.json()).toMatchObject({ data: { code: 'UNSUPPORTED_PHOTO_TYPE', field: 'image' } })
  const missing = await request.patch(api(`stay-homes/${productId}/photos/absent`), { headers, data: { alt_text: 'The deck at sunset' } })
  expect(missing.status(), await missing.text()).toBe(404)
  expect(await missing.json()).toMatchObject({ data: { code: 'PHOTO_NOT_FOUND', field: 'photo_id' } })

  const later = [localDay(10), localDay(13)] as const
  const made = await request.post(api('stays'), { headers, data: { product_id: productId, check_in_date: later[0], check_out_date: later[1], adults: 2, guest_name: 'Kai', total_minor: 450_00, idempotency_key: `${slug}-native` } })
  expect(made.status(), await made.text()).toBe(201)
  const native = (await made.json() as { stay: { id: string; version: number } }).stay
  const edited = await request.patch(api(`stays/${native.id}`), { headers, data: { expected_version: native.version, guest_name: 'Kai Mendes' } })
  expect(edited.status(), await edited.text()).toBe(200)
  const nativeRead = await call<{ stay: { guest_name: string; check_in_date: string; total_minor: number } }>('get_stay', { stay_id: native.id })
  expect(nativeRead.data!.stay).toMatchObject({ guest_name: 'Kai Mendes', check_in_date: later[0], check_out_date: later[1], total_minor: 450_00 })

  const listed = await request.get(api(`stays?from=${later[0]}&to=${later[1]}`))
  expect(listed.status(), await listed.text()).toBe(200)
  expect((await listed.json() as { stays: Array<{ id: string }> }).stays.map(stay => stay.id)).toEqual([native.id])

  const closedNight = localDay(20)
  const closed = await request.put(api(`stay-homes/${productId}/nights`), { headers, data: { from: closedNight, to: localDay(21), closed: true } })
  expect(closed.status(), await closed.text()).toBe(200)
  const nativeCalendar = await request.get(api(`stay-homes/${productId}/calendar?from=${later[0]}&to=${localDay(21)}`))
  expect(nativeCalendar.status(), await nativeCalendar.text()).toBe(200)
  const nights = (await nativeCalendar.json() as { nights: Array<{ date: string; available: boolean; stay_id: string | null; closed: boolean }> }).nights
  expect(nights.filter(night => night.stay_id === native.id).map(night => night.date)).toEqual([later[0], localDay(11), localDay(12)])
  expect(nights.find(night => night.date === closedNight)).toMatchObject({ available: false, closed: true })
  const mcpCalendar = await call<{ nights: Array<{ date: string; closed: boolean }> }>('get_stay_calendar', { product_id: productId, from: closedNight, to: localDay(21) })
  expect(mcpCalendar.data!.nights).toEqual([expect.objectContaining({ date: closedNight, closed: true })])
})

test('a cleaner sees only assigned-home arrivals and departures on Today and Upcoming', async ({ page, browser, baseURL }) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates local stays and uses disposable actors')
  await loginAs(page.request, baseURL!, 'user-e2e-lodging-host')
  const headers = authRequestHeaders(baseURL!)
  const slug = `e2e-stays-${crypto.randomUUID().slice(0, 8)}`
  const created = await page.request.post('/api/auth/organization/create', { headers, data: { name: `Cleaner ${slug}`, slug, default_currency: 'THB', timezone: TIME_ZONE } })
  expect(created.status(), await created.text()).toBe(200)
  const organizationId = (await created.json() as { id: string }).id
  const provisioned = await page.request.post('/api/organizations', { headers, data: { organizationId, name: `Cleaner ${slug}`, subdomain: slug, vertical: 'lodging', sourceLocale: 'en' } })
  expect(provisioned.status(), await provisioned.text()).toBe(200)
  const api = (path: string) => `/api/dashboard/${path}?org=${encodeURIComponent(slug)}`
  const call = <T>(name: string, args: Record<string, unknown>) => tool<T>(page.request, baseURL!, organizationId, name, args)
  const cleaner = await browser.newContext({ baseURL: baseURL! })
  try {
    await loginAs(cleaner.request, baseURL!, 'user-e2e-demo-role-owner')
    const offered = await page.request.post(`/api/organizations/${organizationId}/invite-links`, { data: { role: 'member' } })
    expect(offered.status(), await offered.text()).toBe(201)
    const token = (await offered.json() as { token: string }).token
    const accepted = await cleaner.request.post(`/api/invite-links/${encodeURIComponent(token)}/accept`, { data: {} })
    expect(accepted.status(), await accepted.text()).toBe(200)
    const memberId = (await accepted.json() as { memberId: string }).memberId
    const locations = await call<{ locations: Array<{ id: string }> }>('list_locations', {})
    expect(locations.error).toBeNull()
    expect(locations.data!.locations).toHaveLength(1)
    const madeHome = await page.request.post(api('stay-homes'), { data: { name: 'Assigned Cabin', timezone: TIME_ZONE, address: '1 Test Road', city: 'Krabi', country: 'TH',
      state: null, zip_code: null, phone: null, email: null, check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 1,
      base_price_minor: null, idempotency_key: crypto.randomUUID() } })
    expect(madeHome.status(), await madeHome.text()).toBe(201)
    const assignedHome = (await madeHome.json() as { home: { product_id: string; location_id: string } }).home
    const otherHome = await call<{ product: { id: string } }>('create_product', { kind: 'stay', name: 'Other Cabin', idempotency_key: crypto.randomUUID(), stay: {
      location_id: locations.data!.locations[0]!.id, check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 1,
      assigned_member_id: null, assigned_team_id: null,
    } })
    expect(otherHome.error).toBeNull()
    const homes = [assignedHome, { product_id: otherHome.data!.product.id, location_id: locations.data!.locations[0]!.id }]
    const assigned = await call('update_product', { product_id: homes[0]!.product_id, stay: { assigned_member_id: memberId } })
    expect(assigned.error).toBeNull()
    const stays: Array<{ id: string }> = []
    for (const [index, home] of homes.entries()) {
      const made = await page.request.post(api('stays'), { data: { product_id: home.product_id, check_in_date: localDay(0), check_out_date: localDay(2), adults: 2,
        guest_name: index === 0 ? 'Ana' : 'Private', guest_surname: 'Silva', total_minor: 30_000, idempotency_key: crypto.randomUUID() } })
      expect(made.status(), await made.text()).toBe(201)
      stays.push((await made.json() as { stay: { id: string } }).stay)
    }
    const todayResponse = await cleaner.request.get(api('today'))
    expect(todayResponse.status(), await todayResponse.text()).toBe(200)
    const today = await todayResponse.json() as import('../../shared/dashboard-today').TodayFeedPayload
    const arrivalPath = `/dashboard/${slug}/bookings/stay/${stays[0]!.id}`
    expect(today.cards).toEqual([expect.objectContaining({ id: `stay:${stays[0]!.id}:arrival`, to: arrivalPath, priority: 'schedule', bookingKind: 'stay',
      headline: 'Ana arrives today with 2 guests', description: 'Assigned Cabin', locationId: homes[0]!.location_id })])
    expect(today.locations.map(location => location.id)).toEqual([homes[0]!.location_id])
    const upcomingResponse = await cleaner.request.get(api('today'), { params: { range: 'upcoming', from: localDay(1), to: localDay(7) } })
    expect(upcomingResponse.status(), await upcomingResponse.text()).toBe(200)
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
    await expect(cleanerPage.getByRole('heading', { name: 'Ana Silva', level: 1, exact: true })).toBeVisible()
    await expect(cleanerPage.getByRole('button', { name: 'Cancel stay', exact: true })).toHaveCount(0)
    await expect(cleanerPage.getByRole('button', { name: 'Record payment', exact: true })).toHaveCount(0)
    await cleanerPage.goto(`/dashboard/${slug}?range=upcoming`)
    const departure = cleanerPage.getByTestId('today-card')
    await expect(departure).toHaveCount(1)
    await expect(departure).toContainText('Ana leaves in 2 days with 2 guests')
    await expect(departure).toHaveAttribute('href', `${arrivalPath}?range=upcoming`)
    await departure.click()
    await expect(cleanerPage.getByRole('heading', { name: 'Ana Silva', level: 1, exact: true })).toBeVisible()

    // Another device's edit updates the assigned stay without navigation. An
    // ordered later event proves that the intervening other-home event was filtered.
    const current = await call<{ stay: { version: number } }>('get_stay', { stay_id: stays[0]!.id })
    const renamed = await call<{ stay: { version: number } }>('update_stay', { stay_id: stays[0]!.id, expected_version: current.data!.stay.version, guest_name: 'Ana Live' })
    expect(renamed.error).toBeNull()
    await expect(cleanerPage.getByRole('heading', { name: 'Ana Live Silva', level: 1, exact: true })).toBeVisible()
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
    expect(signedOut.status(), await signedOut.text()).toBe(200)
    const revoked = await cleaner.request.get('/api/auth/get-session', { params: { disableCookieCache: 'true' } })
    expect(revoked.status(), await revoked.text()).toBe(200)
    expect(await revoked.json()).toBeNull()
    const beforeRevokedEvent = liveEvents.length
    const afterSignOut = await call<{ stay: { version: number } }>('update_stay', { stay_id: stays[0]!.id, expected_version: noted.data!.stay.version, notes: 'After session revocation' })
    expect(afterSignOut.error).toBeNull()
    await signedOutClosed
    expect(liveEvents).toHaveLength(beforeRevokedEvent)
    const unauthenticatedSocket = await cleaner.request.get(api('guest-inbox/socket'))
    expect(unauthenticatedSocket.status()).toBe(401)
    expect(await unauthenticatedSocket.json()).toMatchObject({ data: { code: 'UNAUTHORIZED', field: 'session' } })

  } finally {
    await cleaner.close()
  }
})

test('a stay socket in a service organization closes when Better Auth removes its membership', async ({ page, browser, baseURL }) => {
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Creates local homes and disposable memberships')
  await loginAs(page.request, baseURL!, 'user-e2e-lodging-host')
  const headers = authRequestHeaders(baseURL!)
  const slug = `e2e-stay-live-${crypto.randomUUID().slice(0, 8)}`
  const created = await page.request.post('/api/auth/organization/create', { headers, data: { name: `Live ${slug}`, slug, default_currency: 'THB', timezone: TIME_ZONE } })
  expect(created.status(), await created.text()).toBe(200)
  const organizationId = (await created.json() as { id: string }).id
  const provisioned = await page.request.post('/api/organizations', { headers, data: { organizationId, name: `Live ${slug}`, subdomain: slug, vertical: 'service', sourceLocale: 'en' } })
  expect(provisioned.status(), await provisioned.text()).toBe(200)
  const api = (path: string) => `/api/dashboard/${path}?org=${encodeURIComponent(slug)}`
  const cleaner = await browser.newContext({ baseURL: baseURL! })
  try {
    await loginAs(cleaner.request, baseURL!, 'user-e2e-demo-role-owner')
    const offered = await page.request.post(`/api/organizations/${organizationId}/invite-links`, { data: { role: 'member' } })
    expect(offered.status(), await offered.text()).toBe(201)
    const accepted = await cleaner.request.post(`/api/invite-links/${encodeURIComponent((await offered.json() as { token: string }).token)}/accept`, { data: {} })
    expect(accepted.status(), await accepted.text()).toBe(200)
    const memberId = (await accepted.json() as { memberId: string }).memberId

    // The actual canonical home API decides whether this vertical supports a
    // home; there is no SQL fixture or environment bypass supplying one.
    const madeHome = await page.request.post(api('stay-homes'), { data: { name: 'Retreat Cabin', timezone: TIME_ZONE, address: '1 Retreat Road', city: 'Krabi', country: 'TH',
      state: null, zip_code: null, phone: null, email: null, check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 1,
      base_price_minor: null, idempotency_key: crypto.randomUUID() } })
    expect(madeHome.status(), await madeHome.text()).toBe(201)
    const home = (await madeHome.json() as { home: { product_id: string } }).home
    const assigned = await page.request.patch(api(`stay-homes/${home.product_id}`), { data: { assigned_member_id: memberId } })
    expect(assigned.status(), await assigned.text()).toBe(200)
    const made = await page.request.post(api('stays'), { data: { product_id: home.product_id, check_in_date: localDay(0), check_out_date: localDay(2), adults: 1,
      guest_name: 'Membership Guest', total_minor: 0, idempotency_key: crypto.randomUUID() } })
    expect(made.status(), await made.text()).toBe(201)
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
    await expect(cleanerPage.getByRole('heading', { name: 'Membership Guest', level: 1, exact: true })).toBeVisible()
    // The real first-open reconciliation read proves the app socket completed
    // its upgrade before the other device publishes the event under assertion.
    expect((await openedRead).status()).toBe(200)
    const renamed = await page.request.patch(api(`stays/${stay.id}`), { data: { expected_version: stay.version, guest_name: 'Membership Live' } })
    expect(renamed.status(), await renamed.text()).toBe(200)
    const version = (await renamed.json() as { stay: { version: number } }).stay.version
    await expect(cleanerPage.getByRole('heading', { name: 'Membership Live', level: 1, exact: true })).toBeVisible()
    await expect.poll(() => liveEvents.filter(event => event.type === 'stay.changed').length).toBe(1)
    const socket = sockets.find(socket => !socket.isClosed())
    expect(socket).toBeDefined()
    const closed = socket!.waitForEvent('close')
    const removed = await page.request.post('/api/auth/organization/remove-member', { headers, data: { organizationId, memberIdOrEmail: memberId } })
    expect(removed.status(), await removed.text()).toBe(200)
    const beforeRemoval = liveEvents.length
    const changed = await page.request.patch(api(`stays/${stay.id}`), { data: { expected_version: version, notes: 'After membership removal' } })
    expect(changed.status(), await changed.text()).toBe(200)
    await closed
    expect(liveEvents).toHaveLength(beforeRemoval)
  } finally {
    await cleaner.close()
  }
})
