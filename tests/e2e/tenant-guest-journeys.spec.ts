import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  openTenantPage, potteryHouseBaseURL, potteryHouseExtraHeaders, waitForNuxtHydration,
} from './helpers'
import { E2E_KIKUZUKI_ORGANIZATION_ID, E2E_POTTERY_ORGANIZATION_ID, devLoginHeaders, kikuzukiTestBaseUrl, kikuzukiTestExtraHeaders, testBaseUrl } from './test-env'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import type { Product, PublicProduct } from '../../server/types/products'

type NotificationRow = { template: string }
type DeliveryRow = { channel: 'email' | 'whatsapp'; purpose: string; status: string }
type NotificationState = { notifications: NotificationRow[]; deliveries: DeliveryRow[] }
const executionHost = new URL(testBaseUrl()).hostname
const writableEnvironment = ['localhost', '127.0.0.1'].includes(executionHost)

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
  complete: (_state: NotificationState) => boolean,
) {
  let state: NotificationState = { notifications: [], deliveries: [] }
  await expect.poll(async () => {
    const response = await request.get(notificationUrl(baseURL, organizationId, since), { headers: devLoginHeaders() })
    state = response.ok() ? await response.json() as NotificationState : { notifications: [], deliveries: [] }
    return complete(state)
  }, { timeout: 8_000 }).toBe(true)
  return state
}

function expectOwnerDispatch(state: NotificationState) {
  expect(state.notifications.length).toBeGreaterThan(0)
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

test.describe('tenant guest journeys (disposable local/preview data only)', () => {
  test.skip(!writableEnvironment, 'guest writes are forbidden outside local and preview')

  test('Pottery House Product booking persists and creates log-only owner dispatch', async ({ page, request }) => {
    const since = new Date().toISOString()
    const email = `pottery-booking-${Date.now()}@playwright.example`
    // A guest books an occurrence, and occurrences are materialized from the
    // product's rules. Generation is idempotent, so the journey makes sure
    // there is something on the calendar to book before it tries.
    await loginAs(request, testBaseUrl(), 'user-e2e-pottery-owner')
    const generated = await request.post(`${testBaseUrl()}/api/editor/organizations/${E2E_POTTERY_ORGANIZATION_ID}/products/exp-ph-wheel/sessions/generate`, {
      headers: { 'x-preview-tenant': 'pottery-house' },
      data: { through: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) },
    })
    expect(generated.status(), await generated.text()).toBe(200)
    await openTenantPage(page, `${potteryHouseBaseURL}/locations/krabi/products/pottery-wheel-class`, potteryHouseExtraHeaders)
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
    const submission = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/products/pottery-wheel-class/book'))
    await page.getByRole('button', { name: 'Confirm booking' }).click()
    const response = await submission
    expect(response.status()).toBe(201)
    expect(response.request().postDataJSON()).toMatchObject({ guest_phone: '+66812345678' })
    const booked = await response.json() as { booking_id: string }
    expect(booked.booking_id).toEqual(expect.any(String))
    const persisted = await request.get(`${testBaseUrl()}/api/dashboard/bookings/booking/${booked.booking_id}`, {
      params: { org: E2E_POTTERY_ORGANIZATION_ID },
    })
    expect(persisted.status(), await persisted.text()).toBe(200)
    expect((await persisted.json()).booking).toMatchObject({
      guestName: 'Pottery Journey Test', guestEmail: email, guestPhone: '+66812345678', requests: 'Please keep the two seats together.',
    })
    await expect(page).toHaveURL(/\/bookings\/confirmed/)
    await expect(page.locator('main')).toContainText(/booking|received|confirmed/i)
    const state = await waitForNotifications(request, potteryHouseBaseURL, E2E_POTTERY_ORGANIZATION_ID, since, state =>
      state.notifications.some(row => row.template === 'new_booking')
      && ownerAlertSent(state)
      && state.deliveries.some(row => row.purpose === 'guest_acknowledgement' && row.channel === 'email' && row.status === 'sent'),
    )
    expectOwnerDispatch(state)
  })

  test('Kikuzuki restaurant reservation persists and creates log-only owner dispatch', async ({ page, request }, testInfo) => {
    const baseURL = kikuzukiTestBaseUrl()
    const since = new Date().toISOString()
    const email = `kikuzuki-reservation-${Date.now()}@playwright.example`
    const unlock = await acquireTenantMutationLock(testInfo, E2E_KIKUZUKI_ORGANIZATION_ID)
    const policyUrl = `${testBaseUrl()}/api/editor/organizations/${E2E_KIKUZUKI_ORGANIZATION_ID}/locations/loc-kikuzuki/reservation-config`
    let original: { duration_minutes: number | null; updated_at: string | null } | null | undefined
    try {
      await loginAs(request, testBaseUrl(), 'user-e2e-kikuzuki-owner')
      const read = await request.get(policyUrl)
      expect(read.status(), await read.text()).toBe(200)
      original = (await read.json()).config
      const configured = await request.put(policyUrl, { data: { duration_minutes: 60, expected_updated_at: original?.updated_at ?? null } })
      expect(configured.status(), await configured.text()).toBe(200)
      await openTenantPage(page, `${baseURL}/reservations`, kikuzukiTestExtraHeaders())
      await waitForNuxtHydration(page)
      await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Kikuzuki Japanese Robatayaki & Izakaya', exact: true }) }).getByRole('button', { name: 'Request Reservation', exact: true }).click()
      await chooseFirstAvailableTime(page)
      await page.getByLabel('Full name').fill('Kikuzuki Journey Test')
      await page.getByLabel('Email address').fill(email)
      await page.getByLabel(/Phone number/i).fill('+66812345679')
      const submission = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/public/reservations'))
      await page.getByLabel('Your details').getByRole('button', { name: /request reservation|ขอจองโต๊ะ/i }).click()
      const response = await submission
      expect(response.status()).toBe(201)
      const reservation: { id?: unknown; cancellationToken?: unknown; message?: unknown } = await response.json()
      expect(reservation.message).toBe('Your reservation is confirmed.')
      expect(reservation.id).toEqual(expect.any(String))
      expect(reservation.cancellationToken).toEqual(expect.any(String))
      if (typeof reservation.id !== 'string' || typeof reservation.cancellationToken !== 'string') {
        throw new Error('Reservation response omitted its lookup credentials')
      }
      // A booking and a reservation are read back through one route: what holds
      // the seats differs, what the guest is shown does not.
      const persisted = await request.get(`${baseURL}/api/public/booking-requests/${reservation.id}`, {
        headers: { ...kikuzukiTestExtraHeaders(), Authorization: `Bearer ${reservation.cancellationToken}` },
      })
      expect(persisted.status(), await persisted.text()).toBe(200)
      const persistedBody: { booking?: { kind?: unknown; status?: unknown } } = await persisted.json()
      expect(persistedBody.booking?.kind).toBe('reservation')
      expect(persistedBody.booking?.status).toBe('confirmed')
      await expect(page).toHaveURL(/\/reservations\/confirmed/)
      await expect(page.locator('main')).toContainText('Reservation confirmed')
      await expect(page.locator('main')).not.toContainText(/confirm your .* shortly/i)
      const state = await waitForNotifications(request, baseURL, E2E_KIKUZUKI_ORGANIZATION_ID, since, state =>
        state.notifications.some(row => row.template === 'new_reservation')
        && state.deliveries.some(row => row.purpose === 'owner_alert' && row.channel === 'whatsapp' && row.status === 'sent')
        && state.deliveries.some(row => row.purpose === 'guest_acknowledgement' && row.channel === 'email' && row.status === 'sent'),
      )
      expectOwnerDispatch(state)
    } finally {
      try {
        if (original !== undefined) {
          const current = await request.get(policyUrl)
          expect(current.status(), await current.text()).toBe(200)
          // A location that had no usable reservation policy is returned to
          // disabled reservations, rather than writing an incomplete policy.
          const restored = !original || original.duration_minutes === null
            ? await request.delete(policyUrl)
            : await request.put(policyUrl, { data: { duration_minutes: original.duration_minutes, expected_updated_at: (await current.json()).config.updated_at } })
          expect(restored.status(), await restored.text()).toBe(200)
        }
      } finally {
        await unlock()
      }
    }
  })

  test('Pottery House contact persists and creates an owner notification', async ({ page, request }) => {
    const since = new Date().toISOString()
    const email = `pottery-contact-${Date.now()}@playwright.example`
    await openTenantPage(page, `${potteryHouseBaseURL}/contact`, potteryHouseExtraHeaders)
    await expect(page.locator('[data-hydrated]')).toHaveAttribute('data-hydrated', 'true')
    await page.getByLabel(/your name/i).fill('Pottery Contact Journey')
    await page.getByLabel(/email/i).fill(email)
    await page.getByLabel(/your message/i).fill('Please tell me more about private pottery classes.')
    const submission = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/public/contact'))
    await page.getByRole('button', { name: /send a message/i }).click()
    expect((await submission).status()).toBe(201)
    await expect(page).toHaveURL(/\/contact\/confirmed/)
    const state = await waitForNotifications(request, potteryHouseBaseURL, E2E_POTTERY_ORGANIZATION_ID, since, state =>
      state.notifications.some(row => row.template === 'new_contact_msg')
      && ownerAlertSent(state)
      && state.deliveries.some(row => row.purpose === 'guest_acknowledgement' && row.channel === 'email' && row.status === 'sent'),
    )
    expectOwnerDispatch(state)
  })

  test('guest validation rejects invalid input and cancellation retries preserve the existing outcome', async ({ page, request }) => {
    const baseURL = testBaseUrl()
    const headers = { ...devLoginHeaders(), 'x-preview-tenant': 'pottery-house' }
    // A guest names a SESSION, not a date and a time: the occurrence is a real
    // row, so there is nothing to re-derive and no slot to invent.
    const book = (name: string, email: string, sessionId: string) => request.post(`${baseURL}/api/public/products/pottery-wheel-class/book`, {
      headers, data: { guest_name: name, guest_email: email, party_size: 1, session_id: sessionId, idempotency_key: crypto.randomUUID() },
    })
    expect((await book('Missing Session', 'past@playwright.example', '')).status()).toBe(400)
    expect((await book('Unknown Session', 'slot@playwright.example', 'session-that-does-not-exist')).status()).toBe(404)
    expect((await request.post(`${baseURL}/api/public/contact`, { headers, data: {} })).status()).toBe(400)
    expect((await request.post(`${baseURL}/api/public/reservations`, { headers, data: {} })).status()).toBe(400)
    await openTenantPage(page, `${potteryHouseBaseURL}/locations/krabi/products/pottery-wheel-class`, potteryHouseExtraHeaders)
    await waitForNuxtHydration(page)
    await page.getByRole('button', { name: 'Book now' }).first().click()
    await chooseFirstAvailableTime(page)
    const phone = page.getByLabel(/Phone number/i)
    const country = page.getByLabel(/^Phone country(?:$|:)/)
    await country.click()
    await page.getByLabel('Search countries', { exact: true }).fill('Australia')
    await page.getByRole('option', { name: /Australia.*\+61/ }).click()
    // The list closes and hands focus back to the country button, as a combobox does.
    await expect(page.getByRole('listbox')).toBeHidden()
    await expect(country).toBeFocused()
    await expect(country).toContainText('+61')
    await expect(phone).toHaveValue('')
    await phone.pressSequentially('0491570150')
    await expect(phone).toHaveValue('0491 570 150')
    // The chosen country and the entered number survive remounting.
    await page.getByRole('button', { name: 'Change', exact: true }).click()
    await chooseFirstAvailableTime(page)
    await expect(country).toContainText('+61')
    await expect(phone).toHaveValue('0491 570 150')
    // Clearing the optional phone leaves no number, not a calling code alone.
    await phone.fill('')
    await expect(phone).toHaveValue('')
    await expect(country).toContainText('+61')
    await page.getByLabel('Full name').fill('Cancel Once')
    await page.getByLabel('Email address').fill('cancel-once@playwright.example')
    await phone.focus()
    await page.getByLabel(/Special requests/i).focus()
    const submission = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/products/pottery-wheel-class/book'))
    await page.getByRole('button', { name: 'Confirm booking' }).click()
    const created = await submission
    expect(created.status()).toBe(201)
    expect(created.request().postDataJSON()).toMatchObject({ guest_phone: null })
    const body = await created.json() as { booking_id: string; cancellation_token: string }
    expect(JSON.stringify(body)).not.toContain('cancel-once@playwright.example')
    await loginAs(request, baseURL, 'user-e2e-pottery-owner')
    const persisted = await request.get(`${baseURL}/api/dashboard/bookings/booking/${body.booking_id}`, {
      params: { org: E2E_POTTERY_ORGANIZATION_ID },
    })
    expect(persisted.status(), await persisted.text()).toBe(200)
    expect((await persisted.json()).booking).toMatchObject({ guestName: 'Cancel Once', guestPhone: null })
    const cancelURL = `${baseURL}/api/public/booking-requests/${body.booking_id}/cancel`
    const authHeaders = { ...headers, Authorization: `Bearer ${body.cancellation_token}` }
    const receiptURL = cancelURL.replace(/\/cancel$/, '')
    const before = await request.get(receiptURL, { headers: authHeaders })
    expect(before.status()).toBe(200)
    const receipt = await before.json() as { success: true; booking: Record<string, unknown> }
    const cancelled = await request.post(cancelURL, { headers: authHeaders })
    expect(cancelled.status()).toBe(200)
    expect(await cancelled.json()).toEqual({ success: true, kind: 'booking' })
    // The capability is spent once; an authorized retry returns the existing
    // outcome and can recover deduplicated notification delivery.
    const replay = await request.post(cancelURL, { headers: authHeaders })
    expect(replay.status()).toBe(200)
    expect(await replay.json()).toEqual({ success: true, kind: 'booking' })
    expect((await request.post(cancelURL, {
      headers: { ...headers, Authorization: 'Bearer invalid-cancellation-token' },
    })).status()).toBe(404)
    // The guest can still read the receipt after cancellation.
    const after = await request.get(receiptURL, { headers: authHeaders })
    expect(after.status()).toBe(200)
    expect(await after.json()).toEqual({ ...receipt, booking: { ...receipt.booking, status: 'cancelled' } })
    for (const deniedHeaders of [
      { ...headers, Authorization: 'Bearer invalid-cancellation-token' },
      { ...authHeaders, 'x-preview-tenant': 'demo' },
    ]) {
      const denied = await request.get(receiptURL, { headers: deniedHeaders })
      expect(denied.status()).toBe(404)
      expect(await denied.json()).toEqual({ error: 'Booking not found' })
    }
  })
})

for (const target of [
  { name: 'Kikuzuki', owner: 'user-e2e-kikuzuki-owner', org: E2E_KIKUZUKI_ORGANIZATION_ID, slug: E2E_KIKUZUKI_ORGANIZATION_ID, location: 'loc-kikuzuki', locationSlug: 'kikuzuki-japanese-robatayaki-izakaya', base: kikuzukiTestBaseUrl(), headers: kikuzukiTestExtraHeaders(), experience: false, kind: 'dish' },
  { name: 'Kikuzuki merchandise', org: E2E_KIKUZUKI_ORGANIZATION_ID, slug: E2E_KIKUZUKI_ORGANIZATION_ID, location: 'loc-kikuzuki', locationSlug: 'kikuzuki-japanese-robatayaki-izakaya', base: kikuzukiTestBaseUrl(), headers: kikuzukiTestExtraHeaders(), experience: false, kind: 'item' },
  { name: 'Pottery House', owner: 'user-e2e-pottery-owner', org: E2E_POTTERY_ORGANIZATION_ID, slug: E2E_POTTERY_ORGANIZATION_ID, location: 'loc-pottery-house', locationSlug: 'krabi', base: potteryHouseBaseURL, headers: potteryHouseExtraHeaders, experience: true, kind: 'experience' },
]) {
  test(`${target.name} external checkout uses the shared CMS and public template`, async ({ page, request, baseURL }, testInfo) => {
    test.skip(!writableEnvironment, 'External checkout verification writes only local disposable products')
    await loginAs(page.request, baseURL!)
    const editor = `/api/editor/organizations/${target.org}/products`
    const inheritedPriceTerms = { tax_behavior: 'inclusive', compare_at_unit_amount: 200000, valid_from_at: '2020-01-01T00:00:00.000Z', valid_until_at: '2099-01-01T00:00:00.000Z' }
    const created = await page.request.post(editor, { data: { kind: target.kind, name: target.kind === 'dish' ? `Sesame mushroom udon ${Date.now().toString(36)}` : `External checkout ${Date.now()}`, variants: [{ name: 'Standard', prices: [{ unit_amount: 120000, currency: 'THB', ...(target.kind === 'dish' ? inheritedPriceTerms : {}) }] }] } })
    expect(created.status(), await created.text()).toBe(201)
    const product = (await created.json() as { product: Product }).product
    try {
      const externalUrl = `https://example.com/?checkout=${target.slug}`
      await page.goto(`/dashboard/${target.slug}/products/${product.id}/order-url`)
      await page.getByLabel('Website address', { exact: true }).fill(externalUrl)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/products/${product.id}/photo$`))
      const field = target.kind === 'dish' ? 'dietary_notes' : target.kind === 'experience' ? 'preparation' : 'care_instructions'
      const label = target.kind === 'dish' ? 'Dietary information' : target.kind === 'experience' ? 'Before you arrive' : 'Care instructions'
      const detail = target.kind === 'dish' ? 'Vegetarian' : target.kind === 'experience' ? 'Arrive ten minutes before your class' : 'Hand wash in cold water'
      await page.goto(`/dashboard/${target.slug}/products/${product.id}/attributes/${field}`)
      await page.getByRole('textbox', { name: label, exact: true }).fill(detail)
      const description = 'Finished with roasted sesame and seasonal greens.'
      if (target.kind === 'dish') {
        await page.getByRole('textbox', { name: label, exact: true }).press('Enter')
        const loaded = await page.request.get(`${editor}/${product.id}`)
        expect(loaded.status(), await loaded.text()).toBe(200)
        const savedProduct = (await loaded.json() as { product: Product }).product
        const concurrent = await page.request.patch(`${editor}/${product.id}`, { data: { description, expected_updated_at: savedProduct.updated_at } })
        expect(concurrent.status(), await concurrent.text()).toBe(200)
        const concurrentProduct = (await concurrent.json() as { product: Product }).product
        const refusedSave = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `${editor}/${product.id}`)
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        const refusedResponse = await refusedSave
        expect(refusedResponse.status(), await refusedResponse.text()).toBe(409)
        expect(await refusedResponse.json()).toMatchObject({ data: { code: 'PRODUCT_UPDATE_CONFLICT', field: 'expected_updated_at', product_id: product.id } })
        expect(refusedResponse.request().postDataJSON()).toEqual({ details_mode: 'merge', details: { dietary_notes: [detail] }, expected_updated_at: savedProduct.updated_at })
        const retained = page.locator('#dashboard-panel-product-attribute')
        await expect(retained.getByText(detail, { exact: true })).toBeVisible()
        const unchanged = await page.request.get(`${editor}/${product.id}`)
        expect(unchanged.status(), await unchanged.text()).toBe(200)
        const unchangedProduct = (await unchanged.json() as { product: Product }).product
        expect(unchangedProduct.description).toBe(description)
        expect(unchangedProduct.details).not.toHaveProperty(field)
        expect(unchangedProduct.updated_at).toBe(concurrentProduct.updated_at)
        await retained.getByRole('button', { name: 'Use saved details', exact: true }).click()
        await expect(retained.getByText(detail, { exact: true })).toHaveCount(0)
        await page.getByRole('textbox', { name: label, exact: true }).fill(detail)
        await page.getByRole('textbox', { name: label, exact: true }).press('Enter')
      }
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/products/${product.id}/attributes$`))
      const locations = await page.request.put(`${editor}/${product.id}/locations/${target.location}`, { data: { active: true, published: true } })
      expect(locations.status(), await locations.text()).toBe(200)
      if (target.kind === 'dish') {
        await page.goto(`/dashboard/${target.slug}/products/${product.id}/price?location_id=${target.location}`)
        await expect(page.getByTestId('product-price')).toHaveValue('1200.00')
        await page.getByTestId('product-price').fill('1350')
        const scopedPrice = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `${editor}/${product.id}`)
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        const scopedPriceResponse = await scopedPrice
        expect(scopedPriceResponse.status(), await scopedPriceResponse.text()).toBe(200)
        await expect(page).toHaveURL(`/dashboard/${target.slug}/products/${product.id}/photo?location_id=${target.location}`)
        const cards = page.getByTestId('dish-editor-cards')
        await expect(cards.getByTestId('editor-card-dietary_notes')).toContainText(detail)
        await expect(cards.getByTestId('editor-card-description')).toContainText(description)
        await expect(cards.getByTestId('editor-card-price')).toContainText('1,350')
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.screenshot({ path: testInfo.outputPath('restaurant-dish-desktop.png'), fullPage: true, animations: 'disabled' })
      }
      const publication = await page.request.put(`${editor}/${product.id}/publication`, { data: { published: true } })
      expect(publication.status(), await publication.text()).toBe(200)
      const viaMcp = mcpData<{ product: Product }>(await (await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_product', args: { organization_id: target.org, product_id: product.id } })).json()).product
      expect(viaMcp.kind).toBe(target.kind)
      expect(viaMcp.details[field]).toEqual(target.kind === 'dish' ? [detail] : detail)
      if (target.kind === 'dish') {
        expect(viaMcp.description).toBe(description)
        expect(viaMcp.variants).toHaveLength(1)
        expect(viaMcp.variants[0]!.id).toBe(product.variants[0]!.id)
        expect(viaMcp.variants[0]!.prices).toHaveLength(2)
        expect(viaMcp.variants[0]!.prices).toContainEqual(expect.objectContaining({ ...inheritedPriceTerms, id: product.variants[0]!.prices[0]!.id, unit_amount: 120000, currency: 'THB', location_id: null }))
        expect(viaMcp.variants[0]!.prices).toContainEqual(expect.objectContaining({ ...inheritedPriceTerms, unit_amount: 135000, currency: 'THB', location_id: target.location }))
        expect(viaMcp.variants[0]!.prices.find(price => price.location_id === target.location)!.id).not.toBe(product.variants[0]!.prices[0]!.id)
      }
      const publicPath = target.experience ? `/experiences/${product.slug}` : `/locations/${target.locationSlug}/${target.kind === 'dish' ? 'menu' : 'products'}/${product.slug}`
      await openTenantPage(page, `${target.base}${publicPath}`, target.headers)
      await expect(page.getByRole('heading', { name: product.name, level: 1, exact: true })).toBeVisible()
      await expect(page.getByText(detail, { exact: true })).toBeVisible()
      if (target.kind === 'dish') {
        await expect(page.getByText(description, { exact: true })).toBeVisible()
        await expect(page.locator('article').getByText('THB\u00a01,350.00', { exact: true }).first()).toBeVisible()
      }
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 })
        const handoff = page.locator(`a[href="${externalUrl}"]:visible`)
        await expect(handoff).toHaveCount(1)
        await expect(handoff).toHaveText(target.experience ? 'Book now' : 'Order Now')
        await expect(page.getByRole('button', { name: 'Book now', exact: true })).toHaveCount(0)
      }
      if (target.kind === 'dish') await page.screenshot({ path: testInfo.outputPath('restaurant-dish-public-mobile.png'), fullPage: true, animations: 'disabled' })
      await waitForNuxtHydration(page)
      const recorded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/public/conversion-events' && response.request().postDataJSON()?.event_name === 'product_order_external_click')
      const popup = page.waitForEvent('popup')
      await page.locator(`a[href="${externalUrl}"]:visible`).click()
      expect((await recorded).status()).toBe(201)
      const destination = await popup
      await expect(destination).toHaveURL(externalUrl)
      await destination.close()
      const saved = await request.get(`${target.base}${target.experience ? `/api/public/experiences/${product.slug}` : `/api/public/locations/${target.locationSlug}/products/${product.slug}`}`, { headers: target.headers })
      expect(saved.status(), await saved.text()).toBe(200)
      const savedProduct = (await saved.json() as { product: PublicProduct }).product
      expect(savedProduct.order_url).toBe(externalUrl)
      if (target.kind === 'dish') {
        expect(savedProduct.variants[0]!.id).toBe(product.variants[0]!.id)
        expect(savedProduct.variants[0]!.prices).toHaveLength(2)
        expect(savedProduct.variants[0]!.prices).toContainEqual(expect.objectContaining({ ...inheritedPriceTerms, id: viaMcp.variants[0]!.prices.find(price => price.location_id === target.location)!.id, unit_amount: 135000, currency: 'THB', location_id: target.location }))
        expect(savedProduct.variants[0]!.prices).toContainEqual(expect.objectContaining({ ...inheritedPriceTerms, id: product.variants[0]!.prices[0]!.id, unit_amount: 120000, currency: 'THB', location_id: null }))
      }
      await page.goto(`/dashboard/${target.slug}/products/${product.id}/publication/availability`)
      const availability = page.getByRole('switch', { name: target.experience ? 'Accept bookings' : 'Accept orders', exact: true })
      await expect(availability).toHaveAttribute('aria-checked', 'true')
      await availability.click()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/products/${product.id}/publication$`))
      const paused = mcpData<{ product: { active: boolean; publications: Array<{ organization_id: string; published: boolean }> } }>(await (await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_product', args: { organization_id: target.org, product_id: product.id } })).json()).product
      expect(paused.active).toBe(false)
      expect(paused.publications).toContainEqual(expect.objectContaining({ organization_id: target.org, published: true }))
      const pausedView = page.waitForResponse(response => new URL(response.url()).pathname === '/api/public/conversion-events'
        && response.request().postDataJSON()?.event_name === 'product_view' && response.request().postDataJSON()?.product_id === product.id)
      await openTenantPage(page, `${target.base}${publicPath}`, target.headers)
      await expect(page.getByRole('heading', { name: product.name, level: 1, exact: true })).toBeVisible()
      await expect(page.getByText(detail, { exact: true })).toBeVisible()
      await expect(page.locator(`a[href="${externalUrl}"]:visible`)).toHaveCount(0)
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${target.base}${publicPath}`)
      const pausedViewResponse = await pausedView
      expect(pausedViewResponse.status()).toBe(201)
      const pausedViewId = (await pausedViewResponse.json()).id
      const events = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'query_organization_analytics', args: {
        organization_id: target.org, mode: 'events', filters: { event_name: 'product_view', entity_id: product.id },
      } })
      expect(mcpData<{ rows: Array<Record<string, unknown>> }>(await events.json()).rows).toContainEqual(expect.objectContaining({
        event_id: pausedViewId, subject: { type: 'product', id: product.id },
      }))
    } finally {
      expect((await page.request.delete(`${editor}/${product.id}`)).status()).toBe(200)
    }
  })
}
