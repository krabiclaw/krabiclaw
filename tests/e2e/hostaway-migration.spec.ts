import { expect, test, type APIResponse, type Page } from '@playwright/test'
import { authRequestHeaders, loginAs } from './helpers/auth'
import type { MigrationInput, MigrationReceipt } from '../../shared/stay-migration'

async function status(response: APIResponse, expected: number) {
  expect(response.status(), response.status() === expected ? undefined : await response.text()).toBe(expected)
}
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
async function select(page: Page, name: string, option: string, multiple = false) {
  await page.getByRole('combobox', { name, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
  if (!multiple) await expect(page.getByRole('listbox')).toBeHidden()
}

test('a host moves unpaid occupancy in batches, reviews manual-only homes and resumes without duplication', async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  test.skip(!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname), 'Migration writes use disposable local data only')
  await loginAs(page.request, baseURL!, 'user-e2e-lodging-host')
  const headers = authRequestHeaders(baseURL!)
  const slug = `migration-${crypto.randomUUID().slice(0, 8)}`
  const created = await page.request.post('/api/auth/organization/create', { headers, data: { name: `Migration ${slug}`, slug, default_currency: 'USD', timezone: 'Etc/UTC' } })
  await status(created, 200)
  const organizationId = (await created.json() as { id: string }).id
  const provisioned = await page.request.post('/api/organizations', { headers, data: { organization_id: organizationId, name: `Migration ${slug}`, subdomain: slug, vertical: 'lodging', source_locale: 'en' } })
  await status(provisioned, 200)
  const active = await page.request.post('/api/auth/organization/set-active', { headers, data: { organizationId } })
  await status(active, 200)
  const listedMembers = await page.request.get('/api/auth/organization/list-members', { params: { organizationId } })
  await status(listedMembers, 200)
  const ownerMemberId = (await listedMembers.json() as { members: Array<{ id: string; role: string }> }).members.find(member => member.role === 'owner')!.id
  const home = await page.request.post(`/api/dashboard/stay-homes?org=${slug}`, { headers, data: {
    idempotency_key: `migration-home-${slug}`, name: 'Migration 0C', timezone: 'Etc/UTC', address: '12 Example Street', city: 'Denver', state: 'Colorado', country: 'US', zip_code: '80201',
    check_in_time: '16:00', check_out_time: '11:00', max_guests: 4, min_nights: 1, base_price_minor: 10000, assigned_member_id: ownerMemberId,
  } })
  await status(home, 201)
  const productId = (await home.json() as { home: { product_id: string } }).home.product_id
  const manualHome = await page.request.post(`/api/dashboard/stay-homes?org=${slug}`, { headers, data: {
    idempotency_key: `migration-manual-home-${slug}`, name: 'Manual closures only', timezone: 'Etc/UTC', address: '14 Example Street', city: 'Denver', state: 'Colorado', country: 'US', zip_code: '80201',
    check_in_time: '16:00', check_out_time: '11:00', max_guests: 4, min_nights: 1, base_price_minor: 10000, assigned_member_id: ownerMemberId,
  } })
  await status(manualHome, 201)
  const manualProductId = (await manualHome.json() as { home: { product_id: string } }).home.product_id
  const checkIn = day(-5)
  const checkOut = day(25)
  const csv = `Reservation ID,Listing name,Guest name,Check-in,Check-out,Adults,Total price,Currency,Status,Channel,Payment status,Confirmation code,Guest email\n700001,Hostaway 0C,Morgan from 1A,${checkIn},${checkOut},1,3700.00,USD,New,Hostaway Direct,Unpaid,,\n${Array.from({ length: 5 }, (_, index) => `${700002 + index},Hostaway 0C,${index === 4 ? 'Taylor from Airbnb' : `Future guest ${index + 1}`},${day(35 + index * 4)},${day(38 + index * 4)},1,300.00,USD,New,${index === 4 ? 'Airbnb' : 'Hostaway Direct'},Unpaid,${index === 4 ? `HMTEST${slug.slice(-5).toUpperCase()}` : ''},${index === 4 ? 'taylor@migration.example.test' : ''}`).join('\n')}\n`
  const path = `/dashboard/${slug}/integrations/hostaway-migration`
  await page.goto(`/dashboard/${slug}/integrations`)
  await page.getByRole('link', { name: /Migrate from Hostaway/ }).click()
  await expect(page).toHaveURL(`${path}/upload`)
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  async function reviewFile() {
    await page.getByLabel('Reservation export', { exact: true }).setInputFiles({ name: 'hostaway-reservations.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await expect(page.getByText('hostaway-reservations.csv · 6 reservation rows', { exact: true })).toBeVisible()
    await page.getByTestId('editor-row-verify').click()
    await expect(page.getByText('Import your reviewed stays before checking the handover. Upload the same export to resume a previous import.', { exact: true })).toBeVisible()
    await page.getByTestId('editor-row-upload').click()
    await page.getByRole('checkbox', { name: "I've paused the affected Airbnb listings for this handover.", exact: true }).check()
    await page.getByRole('button', { name: 'Next: Match the columns', exact: true }).click()
    await expect(page).toHaveURL(`${path}/columns`)
    await select(page, 'Date format', 'Year-month-day · 2026-11-04')
    await select(page, 'Decimal format', 'Decimal point · 3700.00')
    await page.screenshot({ path: test.info().outputPath('migration-columns-desktop.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Next: Homes and blocked dates', exact: true }).click()
    await expect(page).toHaveURL(`${path}/homes`)
    await select(page, 'KrabiClaw home for Hostaway 0C', 'Migration 0C')
    await select(page, 'Other homes with manual blocked dates', 'Manual closures only', true)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox')).toBeHidden()
    const manualSection = page.locator('div.rounded-xl').filter({ has: page.getByRole('heading', { name: 'Manual closures only: manual blocked dates', exact: true }) })
    await manualSection.getByRole('button', { name: 'Add blocked dates', exact: true }).click()
    await manualSection.getByLabel('Blocked from', { exact: true }).fill(day(2))
    await manualSection.getByLabel('First available date', { exact: true }).fill(day(4))
    await manualSection.getByRole('checkbox', { name: "I checked Manual closures only's manual blocks and included every missing closure.", exact: true }).check()
    await page.getByRole('checkbox', { name: "I checked Migration 0C's manual blocks and included every missing closure.", exact: true }).check()
    await page.getByRole('button', { name: 'Next: Review your move', exact: true }).click()
    await expect(page).toHaveURL(`${path}/review`)
  }
  await reviewFile()
  // Reinterpreting a source identity must discard the former property's targets and closures.
  await page.getByTestId('editor-row-columns').click()
  await select(page, 'Hostaway property', 'Guest name')
  await select(page, 'Hostaway property', 'Listing name')
  await page.getByRole('button', { name: 'Next: Homes and blocked dates', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'KrabiClaw home for Hostaway 0C', exact: true })).toHaveText('Choose the matching KrabiClaw home')
  await expect(page.getByRole('heading', { name: 'Manual closures only: manual blocked dates', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Next: Review your move', exact: true })).toBeDisabled()
  await page.getByTestId('editor-row-upload').click()
  await reviewFile()
  await expect(page.getByText('Morgan from 1A', { exact: true })).toBeVisible()
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(6)
  await expect(page.getByTestId('editor-row-review')).toHaveAttribute('aria-current', 'page')
  await page.screenshot({ path: test.info().outputPath('migration-review-desktop.png'), animations: 'disabled' })
  const sourceRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/dashboard/stays/migration/import' && request.method() === 'POST')
  const finalBatch = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/dashboard/stays/migration/import' && response.request().method() === 'POST' && (await response.json() as MigrationReceipt).has_more === false)
  const imports: Array<Promise<MigrationReceipt>> = []
  page.on('response', response => { if (new URL(response.url()).pathname === '/api/dashboard/stays/migration/import' && response.request().method() === 'POST') imports.push((async () => { expect(response.status(), await response.text()).toBe(200); return await response.json() as MigrationReceipt })()) })
  await page.getByRole('button', { name: 'Import stays', exact: true }).click()
  const requestBody = (await sourceRequest).postDataJSON() as MigrationInput & { fingerprint: string }
  await finalBatch
  await expect(page).toHaveURL(`${path}/verify`)
  const receipts = await Promise.all(imports)
  expect(receipts).toHaveLength(2)
  expect(receipts[0]).toMatchObject({ imported: 5, failed: 0, remaining: 1, has_more: true })
  const receipt = receipts[1]!
  expect(receipt).toMatchObject({ imported: 1, failed: 0, remaining: 0, has_more: false })
  const stayId = receipt.outcomes.find(outcome => outcome.source_id === '700001')!.booking_id!
  expect(stayId).toBeTruthy()
  await expect(page.getByText('The handover needs attention', { exact: true })).toBeVisible()
  await expect(page.getByText('Checks complete for these homes and records', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('editor-row-verify')).toHaveAttribute('aria-current', 'page')
  await page.screenshot({ path: test.info().outputPath('migration-verify-desktop.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByText('The handover needs attention', { exact: true })).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath('migration-verify-mobile.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 1280, height: 720 })

  // Read independently of the import writer: the stay is confirmed and unpaid, and its real calendar nights are taken.
  const stay = await page.request.get(`/api/dashboard/stays/${stayId}?org=${slug}`)
  await status(stay, 200)
  expect(await stay.json()).toMatchObject({ stay: { product_id: productId, status: 'confirmed', guest_name: 'Morgan from 1A', check_in_date: checkIn, check_out_date: checkOut, payment_status: 'unpaid', paid_minor: 0 } })
  const calendar = await page.request.get(`/api/dashboard/stay-homes/${productId}/calendar?org=${slug}&from=${day(0)}&to=${day(3)}`)
  await status(calendar, 200)
  const nights = (await calendar.json() as { nights: Array<{ available: boolean; booking_id: string | null }> }).nights
  expect(nights).toHaveLength(3)
  expect(nights.map(night => ({ available: night.available, booking_id: night.booking_id }))).toEqual(Array.from({ length: 3 }, () => ({ available: false, booking_id: stayId })))
  const manualCalendar = await page.request.get(`/api/dashboard/stay-homes/${manualProductId}/calendar?org=${slug}&from=${day(2)}&to=${day(4)}`)
  await status(manualCalendar, 200)
  expect((await manualCalendar.json() as { nights: Array<{ available: boolean; closed: boolean }> }).nights.map(night => ({ available: night.available, closed: night.closed }))).toEqual([{ available: false, closed: true }, { available: false, closed: true }])
  const otaStayId = receipt.outcomes.find(outcome => outcome.source_id === '700006')!.booking_id!
  await page.goto(`/dashboard/${slug}/bookings/stay/${otaStayId}`)
  await expect(page.getByText('Payments, changes and cancellations for this stay are managed on', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record payment', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Cancel stay', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Message guest', exact: true })).toHaveCount(0)
  await page.goto(`/dashboard/${slug}/bookings/stay/${stayId}`)
  await expect(page.getByRole('button', { name: 'Record payment', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel stay', exact: true })).toBeVisible()

  // A repeated source file is reconciled against the same canonical reservation identity.
  const replay = await page.request.post(`/api/dashboard/stays/migration/import?org=${slug}`, { headers, data: requestBody })
  await status(replay, 200)
  const repeated = await replay.json() as MigrationReceipt
  expect(repeated).toMatchObject({ imported: 0, existing: 6, failed: 0, remaining: 0 })
  expect(repeated.outcomes.find(outcome => outcome.source_id === '700001')!.booking_id).toBe(stayId)
  await page.goto(path)
  await expect(page).toHaveURL(`${path}/upload`)
  await expect(page.getByText('Previous import', { exact: true })).toBeVisible()
  await reviewFile()
  await expect(page.getByText('Already here', { exact: true })).toHaveCount(6)
  expect(pageErrors).toEqual([])
})
