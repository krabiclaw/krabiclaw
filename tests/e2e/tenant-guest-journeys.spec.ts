import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { openTenantPage, waitForNuxtHydration } from './helpers'
import { seededTenant } from './seed/manifest'
import { devLoginHeaders, seededSiteHeaders, seededSiteURL, testBaseUrl } from './test-env'
import { loginAs } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTables } from './helpers/tables'

type DeliveryRow = { conversation_id: string; channel: 'email' | 'whatsapp'; purpose: string; status: string }
type NotificationState = { deliveries: DeliveryRow[] }
const executionHost = new URL(testBaseUrl()).hostname
const writableEnvironment = ['localhost', '127.0.0.1'].includes(executionHost)

// The seeded wheel class at Clayhouse Studio's Ao Nang studio, as a guest reaches it.
function wheelClass() {
  const studio = seededTenant('experience')
  const product = studio.products['wheel-class']!
  return { organizationId: studio.organizationId, slug: studio.slug, product, pagePath: `/locations/${studio.locations['ao-nang']!.slug}/products/${product.slug}` }
}

function notificationUrl(baseURL: string, organizationId: string, since: string) {
  const url = new URL(`${baseURL}/api/dev/notifications`)
  url.searchParams.set('organization_id', organizationId)
  url.searchParams.set('since', since)
  return url.toString()
}

async function waitForNotifications(
  request: APIRequestContext,
  baseURL: string,
  organizationId: string,
  since: string,
  conversationId: string,
  complete: (_state: NotificationState) => boolean,
) {
  let state: NotificationState = { deliveries: [] }
  await expect.poll(async () => {
    const response = await request.get(notificationUrl(baseURL, organizationId, since), { headers: devLoginHeaders() })
    expect(response.status(), await response.text()).toBe(200)
    const { deliveries } = await response.json() as NotificationState
    state = { deliveries: deliveries.filter(delivery => delivery.conversation_id === conversationId) }
    return complete(state)
  }, { timeout: 8_000 }).toBe(true)
  return state
}

function expectOwnerDispatch(state: NotificationState) {
  expect(state.deliveries.some(row => row.purpose === 'owner_alert' && row.status === 'sent')).toBe(true)
  expect(state.deliveries.some(row => row.purpose === 'guest_acknowledgement' && row.channel === 'email' && row.status === 'sent')).toBe(true)
  // Whatever channels this tenant does dispatch on, none of them may have failed.
  // Asserting only that one channel succeeded let a second channel sit in
  // 'failed' forever with the journey still green.
  const unsettled = state.deliveries.filter(row => row.status !== 'sent')
  expect(unsettled, `deliveries not settled as sent: ${JSON.stringify(unsettled)}`).toHaveLength(0)
}

// An owner with a verified phone who has not switched the category off is
// told on WhatsApp as well as by email, so that is what this asserts. It was
// briefly weakened to email-only because the local run could not satisfy it;
// the assertion was right and the environment was wrong. The number came from
// whatever a location had configured, which is how a tenant could set one no
// account held and hear nothing at all.
const ownerAlertSent = (state: NotificationState) =>
  state.deliveries.some(row => row.purpose === 'owner_alert' && row.channel === 'whatsapp' && row.status === 'sent')
  && state.deliveries.some(row => row.purpose === 'owner_alert' && row.channel === 'email' && row.status === 'sent')

async function chooseFirstAvailableTime(page: Page) {
  const slot = page.getByRole('button', { name: /\bAvailable$/ }).first()
  await expect(slot).toBeVisible()
  await slot.click()
  await page.getByRole('button', { name: /continue/i }).click()
}

test('Ember & Slice menu cards retain their links and prices with a compact route payload', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const tenant = seededTenant('restaurant')
  const product = tenant.products.margherita!
  const location = tenant.locations.brooklyn!
  const origin = seededSiteURL('restaurant')
  const headers = seededSiteHeaders('restaurant')
  const response = await openTenantPage(page, origin + '/menu', headers)
  expect(response?.status()).toBe(200)
  const link = page.locator(`main a[href="/locations/${location.slug}/menu/${product.slug}"]`).first()
  await expect(link).toBeVisible()
  await expect(page.locator('main').getByText(/^\$18(?:\.00)?$/).first()).toBeVisible()
  await expect(page.locator('script[type="module"][src^="/_nuxt/"], script#__NUXT_DATA__')).toHaveCount(0)
  const localized = await openTenantPage(page, origin + '/th/menu', headers)
  expect(localized?.status()).toBe(200)
  await expect(page.locator('html')).toHaveAttribute('lang', 'th')
  await expect(page.locator('main').getByText('มาร์เกอริต้า', { exact: true }).first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--tenant-header-height'))).toMatch(/^\d+(?:\.\d+)?px$/)
  expect(errors).toEqual([])
})

test.describe('tenant guest journeys (disposable local/preview data only)', () => {
  test.skip(!writableEnvironment, 'guest writes are forbidden outside local and preview')

  test('Clayhouse Studio Product booking persists and creates log-only owner dispatch', async ({ page, request }) => {
    // Guest submission, persisted readback and dispatch share this whole-journey budget.
    test.slow()
    const since = new Date().toISOString()
    const email = `pottery-booking-${Date.now()}@playwright.example`
    const wheel = wheelClass()
    await openTenantPage(page, `${seededSiteURL('experience')}${wheel.pagePath}`, seededSiteHeaders('experience'))
    await waitForNuxtHydration(page)
    // What a guest presses is the labelled control; the checkbox behind it is
    // screen-reader-only and has no clickable box of its own.
    await page.getByRole('button', { name: 'Book now' }).first().click()
    await chooseFirstAvailableTime(page)
    await page.getByLabel('Full name').fill('Pottery Journey Test')
    await page.getByLabel('Email address').fill(email)
    const phone = page.getByLabel(/Phone number/i)
    const country = page.getByLabel(/^Phone country(?:$|:)/)
    const countrySearch = page.getByLabel('Search countries', { exact: true })
    const notes = page.getByLabel(/Special requests/i)
    await expect(country).toContainText('+66')
    await expect(phone).toHaveValue('')
    await expect(phone).toHaveAttribute('placeholder', '081 234 5678')
    await phone.pressSequentially('0812345678')
    await expect(phone).toHaveValue('081 234 5678')

    // Editing a digit in the middle keeps the caret there. Backspace across
    // a formatting space removes a digit instead of restoring the same space.
    await phone.evaluate(input => (input as HTMLInputElement).setSelectionRange(5, 6))
    await phone.press('9')
    await expect(phone).toHaveValue('081 294 5678')
    expect(await phone.evaluate(input => (input as HTMLInputElement).selectionStart)).toBe(6)
    await phone.evaluate(input => (input as HTMLInputElement).setSelectionRange(4, 4))
    await phone.press('Backspace')
    expect((await phone.inputValue()).replace(/\D/g, '')).toBe('082945678')

    // A number typed with its calling code brings its own country and reads
    // nationally there. ACMA's fictitious mobile range is never assigned.
    await phone.fill('+61491570150')
    await expect(country).toContainText('+61')
    await expect(phone).toHaveValue('0491 570 150')
    await notes.fill('Please keep the two seats together.')

    await page.getByRole('button', { name: 'Change', exact: true }).click()
    await chooseFirstAvailableTime(page)
    await expect(page.getByLabel('Full name')).toHaveValue('Pottery Journey Test')
    await expect(page.getByLabel('Email address')).toHaveValue(email)
    await expect(notes).toHaveValue('Please keep the two seats together.')
    await expect(country).toContainText('+61')
    await expect(phone).toHaveValue('0491 570 150')

    await phone.fill('123')
    await notes.focus()
    await expect(phone).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByText('Enter a valid number and choose its country, or include the international calling code.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Confirm booking' }).click()
    await expect(phone).toBeFocused()

    await country.click()
    await countrySearch.fill('66')
    await expect(page.getByRole('option', { name: /Thailand.*\+66/ })).toBeVisible()
    await countrySearch.fill('Thailand')
    await page.getByRole('option', { name: /Thailand.*\+66/ }).click()
    // The list closes and hands focus back to the country button, as a combobox does.
    await expect(page.getByRole('listbox')).toBeHidden()
    await expect(country).toBeFocused()
    await phone.fill('+66812345678')
    await expect(country).toContainText('+66')
    await expect(phone).toHaveValue('081 234 5678')
    const submission = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/products/${wheel.product.slug}/book`))
    await page.getByRole('button', { name: 'Confirm booking' }).click()
    const response = await submission
    expect(response.status()).toBe(201)
    expect(response.request().postDataJSON()).toMatchObject({ guest_phone: '+66812345678' })
    const booked = await response.json() as { conversation_id: string; booking_id: string; cancellation_token: string }
    expect(booked.conversation_id).toEqual(expect.any(String))
    await loginAs(request, testBaseUrl(), 'user-e2e-pottery-owner')
    const persisted = await request.get(`${testBaseUrl()}/api/dashboard/bookings/${booked.booking_id}`, {
      params: { org: wheel.slug },
    })
    expect(persisted.status(), await persisted.text()).toBe(200)
    const persistedBooking = (await persisted.json()).booking as { status: string }
    expect(persistedBooking).toMatchObject({
      guest_name: 'Pottery Journey Test', guest_email: email, guest_phone: '+66812345678', notes: 'Please keep the two seats together.',
    })
    // The guest's receipt belongs to this business: its token opens it here and nowhere else.
    const receiptURL = `${seededSiteURL('experience')}/api/public/booking-requests/${booked.conversation_id}`
    const receipt = await request.get(receiptURL, { headers: { ...seededSiteHeaders('experience'), Authorization: `Bearer ${booked.cancellation_token}` } })
    expect(receipt.status(), await receipt.text()).toBe(200)
    expect((await receipt.json()).booking).toMatchObject({ kind: 'booking', status: persistedBooking.status })
    const otherTenant = await request.get(receiptURL, { headers: { ...seededSiteHeaders('restaurant'), Authorization: `Bearer ${booked.cancellation_token}` } })
    expect(otherTenant.status()).toBe(404)
    expect(await otherTenant.json()).toEqual({ error: 'Booking not found' })
    await expect(page).toHaveURL(/\/bookings\/confirmed/)
    await expect(page.locator('main')).toContainText(/booking|received|confirmed/i)
    const state = await waitForNotifications(request, seededSiteURL('experience'), wheel.organizationId, since, booked.conversation_id, state =>
      ownerAlertSent(state)
      && state.deliveries.some(row => row.purpose === 'guest_acknowledgement' && row.channel === 'email' && row.status === 'sent'),
    )
    expectOwnerDispatch(state)
  })

  test('Ember & Slice table booking persists and creates log-only owner dispatch', async ({ page, request }, testInfo) => {
    const restaurant = seededTenant('restaurant')
    const brooklyn = restaurant.locations.brooklyn!
    const baseURL = seededSiteURL('restaurant')
    const since = new Date().toISOString()
    const email = `restaurant-reservation-${Date.now()}@playwright.example`
    const unlock = await acquireTenantMutationLock(testInfo, restaurant.organizationId)
    try {
      await openTenantPage(page, `${baseURL}/reservations`, seededSiteHeaders('restaurant'))
      await page.locator('article').filter({ has: page.getByRole('heading', { name: brooklyn.title, exact: true }) }).getByRole('button', { name: 'Request Reservation', exact: true }).click()
      await expect(page.getByRole('dialog', { name: brooklyn.title })).toBeVisible()
      await chooseFirstAvailableTime(page)
      await page.getByLabel('Full name').fill('Restaurant Journey Test')
      await page.getByLabel('Email address').fill(email)
      await page.getByLabel(/Phone number/i).fill('+12025550123')
      // The dining room's tables are booked as their product: the same booking every offering takes.
      const submission = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/public/products/${seededTables('brooklyn').slug}/book`))
      await page.getByRole('button', { name: 'Confirm booking', exact: true }).click()
      const response = await submission
      expect(response.status(), await response.text()).toBe(201)
      const reservation: { conversation_id?: unknown; cancellation_token?: unknown; message?: unknown } = await response.json()
      expect(reservation.message).toEqual(expect.stringMatching(/^Your reservation for .+ is confirmed\.$/u))
      expect(reservation.conversation_id).toEqual(expect.any(String))
      expect(reservation.cancellation_token).toEqual(expect.any(String))
      if (typeof reservation.conversation_id !== 'string' || typeof reservation.cancellation_token !== 'string') {
        throw new Error('The table booking response omitted its lookup credentials')
      }
      // Read back through the guest's receipt: a table, booked and confirmed.
      const persisted = await request.get(`${baseURL}/api/public/booking-requests/${reservation.conversation_id}`, {
        headers: { ...seededSiteHeaders('restaurant'), Authorization: `Bearer ${reservation.cancellation_token}` },
      })
      expect(persisted.status(), await persisted.text()).toBe(200)
      const persistedBody: { booking?: { kind?: unknown; product_kind?: unknown; status?: unknown; location_id?: unknown } } = await persisted.json()
      expect(persistedBody.booking).toMatchObject({ kind: 'booking', product_kind: 'table', status: 'confirmed', location_id: brooklyn.id })
      await expect(page).toHaveURL(/\/bookings\/confirmed/)
      await expect(page.locator('main')).toContainText('Reservation confirmed')
      await expect(page.locator('main')).not.toContainText(/confirm your .* shortly/i)
      const state = await waitForNotifications(request, baseURL, restaurant.organizationId, since, reservation.conversation_id, state =>
        ownerAlertSent(state)
        && state.deliveries.some(row => row.purpose === 'guest_acknowledgement' && row.channel === 'email' && row.status === 'sent'),
      )
      expectOwnerDispatch(state)

      const cancellation = new URL('/bookings/cancel', baseURL)
      cancellation.searchParams.set('id', reservation.conversation_id)
      cancellation.hash = reservation.cancellation_token
      await openTenantPage(page, cancellation.href, seededSiteHeaders('restaurant'))
      await expect(page.getByRole('heading', { name: 'Cancel reservation', exact: true })).toBeVisible()
      await expect(page.locator('main')).toContainText('Reservation for:')
      await expect(page.locator('main')).toContainText('Restaurant Journey Test')
    } finally {
      await unlock()
    }
  })

  test('Messages preserves a saved suggested replies preference when the storage key changes', async ({ page }) => {
    const user = 'user-e2e-pottery-owner'
    const organization = seededTenant('experience')
    const legacyKey = `krabiclaw.suggested-replies.${user}.${organization.organizationId}`
    const key = `blawby.suggested-replies.${user}.${organization.organizationId}`
    await loginAs(page.request, testBaseUrl(), user)
    await page.addInitScript(previousKey => localStorage.setItem(previousKey, 'false'), legacyKey)
    await openTenantPage(page, `${testBaseUrl()}/dashboard/${organization.slug}/messages`, {})
    await page.getByRole('button', { name: 'Messaging settings' }).click()
    const setting = page.getByRole('switch', { name: 'Suggested replies' })
    await expect(setting).toHaveAttribute('aria-checked', 'false')
    expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), legacyKey)).toBeNull()
    expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBe('false')
    await setting.click()
    await expect.poll(() => page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBe('true')
  })

  test('Clayhouse Studio contact persists and creates an owner notification', async ({ page, request, browser }) => {
    const since = new Date().toISOString()
    const email = `pottery-contact-${Date.now()}@playwright.example`
    await openTenantPage(page, `${seededSiteURL('experience')}/contact`, seededSiteHeaders('experience'))
    await expect(page.locator('[data-hydrated]')).toHaveAttribute('data-hydrated', 'true')
    await page.getByLabel(/your name/i).fill('Pottery Contact Journey')
    await page.getByLabel(/email/i).fill(email)
    await page.getByLabel(/your message/i).fill('Please tell me more about private pottery classes.')
    const submission = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/public/contact'))
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const response = await submission
    expect(response.status()).toBe(201)
    const { conversation_id } = await response.json() as { conversation_id: string; booking_id: string }
    await expect(page).toHaveURL(/\/contact\/confirmed/)
    const state = await waitForNotifications(request, seededSiteURL('experience'), seededTenant('experience').organizationId, since, conversation_id, state =>
      ownerAlertSent(state)
      && state.deliveries.some(row => row.purpose === 'guest_acknowledgement' && row.channel === 'email' && row.status === 'sent'),
    )
    expectOwnerDispatch(state)
    // The owner reads the visitor's message, as they wrote it, in Messages.
    const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    try {
      await loginAs(owner.request, testBaseUrl(), 'user-e2e-pottery-owner')
      const messages = await owner.newPage()
      await openTenantPage(messages, `${testBaseUrl()}/dashboard/${seededTenant('experience').slug}/messages/${conversation_id}`, {})
      const opening = messages.locator('[data-message]').first()
      await expect(opening).toBeVisible({ timeout: 30_000 })
      await expect(opening).toContainText('Please tell me more about private pottery classes.')
    } finally {
      await owner.close()
    }
  })

})
