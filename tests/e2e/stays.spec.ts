import { expect, test, type APIRequestContext } from '@playwright/test'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { mcpRequest } from './helpers/mcp'

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
  const productId = new URL(page.url()).pathname.split('/').at(-1)!
  const home = await call<{ product: { kind: string; unit_label: string; stay: Record<string, unknown> } }>('get_product', { product_id: productId })
  expect(home.error).toBeNull()
  expect(home.data!.product).toMatchObject({ kind: 'stay', unit_label: 'night', stay: { location_id: location.id, check_in_time: '15:00', check_out_time: '11:00', max_guests: 4, min_nights: 2 } })

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
})
