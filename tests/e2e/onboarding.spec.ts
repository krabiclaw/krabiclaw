import { expect, test, type APIRequestContext } from '@playwright/test'
import { dismissPreviewToolbar } from './helpers'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { tenantHostIsAddressable, testBaseUrl } from './test-env'
import { environmentTenantAliasSlug } from '../../server/utils/tenant-hosts'
import { formatMinorAmount } from '../../shared/prices'
import { starterPalette } from '../../shared/site-palette'

/**
 * The subdomain the site is stored under, from the host this environment frames
 * it at.
 *
 * Staging addresses a tenant as `<subdomain>-staging.krabiclaw.com`,
 * so the first label of that hostname carries the environment suffix and is not
 * the stored value. Everywhere else the first label IS the subdomain.
 */
function organizationSubdomain(origin: string): string {
  const hostname = new URL(origin).hostname
  const alias = environmentTenantAliasSlug(hostname, { NUXT_PUBLIC_PLATFORM_DOMAIN: testBaseUrl() })
  return alias ? alias : hostname.split('.')[0]!
}

// The manual-name path of the new-site flow, driven the way an owner drives it:
// the welcome screen, then one question per route, each advanced by the shell's
// own footer; the preview pane framing the owner's pending site on its own
// subdomain; and activation making that site public inside a NEW organization
// that becomes the session's active one. The fixture user owns one more
// organization per run; reset-e2e-artifacts sweeps non-fixture organizations
// older than two hours.
//
// Another tenant already holds an organization-wide collection with the slug
// this owner's menu section takes. A collection slug is unique within its
// organization, so the new site gets the same slug for its own section rather
// than failing to save it.
// The two new-site journeys sign in as the same fixture owner, and each one
// discards that owner's active draft before it starts. Run in parallel, one
// discarded the draft the other was reading back, so this file runs in order.
test.describe.configure({ mode: 'default' })

const otherTenantId = 'org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX'
let otherTenant: { owner: APIRequestContext; collectionId: string } | null = null

test.afterEach(async () => {
  if (!otherTenant) return
  const { owner, collectionId } = otherTenant
  otherTenant = null
  const removed = await owner.delete(`/api/editor/organizations/${otherTenantId}/collections/${collectionId}`)
  expect(removed.status(), await removed.text()).toBe(200)
  await owner.dispose()
})

test('a new owner builds a draft and creates a site through the routed flow', async ({ page, request, baseURL, browser, playwright }) => {
  const owner = await playwright.request.newContext({ baseURL })
  await loginAs(owner, baseURL!, 'user-e2e-kikuzuki-owner')
  const held = await owner.post(`/api/editor/organizations/${otherTenantId}/collections`, { data: { name: 'Small plates' } })
  expect(held.status(), await held.text()).toBe(201)
  const heldCollection = (await held.json() as { collection: { id: string; slug: string; location_id: string | null } }).collection
  otherTenant = { owner, collectionId: heldCollection.id }
  expect(heldCollection).toMatchObject({ slug: 'small-plates', location_id: null })

  await dismissPreviewToolbar(page)
  await loginAs(page.request, baseURL!, 'user-e2e-onboarding-wizard')

  // A run that stopped part-way leaves this user an active draft, and the
  // welcome screen resumes a draft rather than asking the first question again.
  // Discard it through the product's own discard, which also deletes the pending
  // site holding that address.
  const discarded = await page.request.delete('/api/dashboard/onboarding/drafts/active')
  expect(discarded.status(), await discarded.text()).toBe(200)

  const name = `E2E Wizard ${Date.now().toString(36)}`

  // Every step screen names itself, so waiting on it means "that step is
  // rendered", which the URL alone does not say.
  const step = (id: string) => page.locator(`[data-onboarding-step="${id}"]`)
  const advance = async (label: string, next: string) => {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(step(next)).toBeVisible()
  }

  await page.goto('/dashboard/onboarding')
  // The shell reads the saved draft back before it renders a screen at all, and
  // a click that lands on pre-hydration markup has no handler, so wait for the
  // screen to say it is hydrated rather than merely present.
  await expect(page.locator('[data-onboarding-hydrated="true"]')).toBeVisible()
  await page.getByRole('button', { name: 'Get started', exact: true }).click()

  // A single-choice step is answered by the press itself: no Next to confirm it.
  await expect(step('type')).toBeVisible()
  await page.getByRole('button', { name: 'Restaurant, café or bar' }).click()
  await expect(step('language')).toBeVisible()
  await page.getByRole('button', { name: 'English', exact: true }).click()

  // Manual business entry completes without any Google Places request.
  const placesRequests: string[] = []
  page.on('request', (sent) => {
    if (sent.url().includes('/api/dashboard/google-places/')) placesRequests.push(sent.url())
  })
  await expect(step('business')).toBeVisible()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await advance('Next', 'location')

  // Location: the country is asked once, and nothing proposes one — it is what
  // the timezone and the currency are both derived from, so the owner names it.
  await page.getByPlaceholder('123 Main Street').fill('88 Moo 2, Ao Nang Beach Road')
  await page.getByPlaceholder('City', { exact: true }).fill('Ao Nang')
  await step('location').getByText('Select country').click()
  await page.getByPlaceholder('Search country...').fill('Thailand')
  await page.getByRole('option', { name: /Thailand/ }).click()

  await advance('Next', 'hours')

  // Hours: the timezone follows the single-zone country the owner named. Zones
  // read as the city and its current offset, not the IANA identifier.
  await expect(step('hours')).toContainText('Bangkok · GMT+7')
  await advance('Save hours', 'currency')

  // Currency: proposed from the country the owner named, and confirmed here
  // before anything is priced. Thailand prices in baht.
  await expect(step('currency')).toContainText('Thai Baht (THB)')

  // The first save needs both answers and creates the organization through
  // Better Auth and its pending site before the pane has anything to frame.
  await step('currency').getByRole('button', { name: 'Show popup', exact: true }).click()
  await page.getByRole('option', { name: 'Thai Baht (THB)', exact: true }).click()
  await expect(step('contact')).toBeVisible()

  // The draft holds the typed name as a manual business, with no Google place.
  const saved = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(saved.status(), await saved.text()).toBe(200)
  expect((await saved.json() as { draft: unknown }).draft).toMatchObject({ sourceType: 'manual', placeId: null, details: { name, currency: 'THB', timezone: 'Asia/Bangkok' } })

  const previewFrame = page.locator('iframe[title="Site preview"]')
  await expect(previewFrame).toHaveAttribute('src', /preview_token=/)
  const organizationOrigin = new URL((await previewFrame.getAttribute('src'))!).origin
  if (tenantHostIsAddressable()) {
    const preview = page.frameLocator('iframe[title="Site preview"]')
    await expect(preview.locator('body')).toContainText(name)
    await expect(preview.locator('body')).not.toContainText('did not match its contract')

    // The token authorized the first load and became a cookie, so navigating
    // inside the preview keeps working without it. This is the whole point of
    // the mechanism: the pending site is the real site, and its own links
    // resolve.
    const frame = page.frame({ url: /preview_token=/ })
    expect(frame).not.toBeNull()
    await frame!.evaluate(() => { window.location.href = window.location.pathname })
    await expect(preview.locator('body')).toContainText(name)
  }

  // Nobody else can see it yet. `request` has its own cookie jar, so this asks
  // for the site carrying neither a preview token nor the preview cookie the
  // framed load leaves behind, and gets something that is not the site. Off an
  // addressable tenant host the run carries tenant identity in a header, the way
  // every other tenant spec here does.
  const asAnyone = tenantHostIsAddressable()
    ? { url: `${organizationOrigin}/`, headers: {} }
    : { url: `${baseURL}/`, headers: { 'x-preview-tenant': organizationSubdomain(organizationOrigin) } }
  expect(await (await request.get(asAnyone.url, { headers: asAnyone.headers })).text()).not.toContain(name)

  // Contact: the phone picker arrives seeded with that country, and the number
  // is accepted the way a Thai owner writes it, trunk zero included.
  const phone = page.getByPlaceholder('Phone number')
  await expect(phone).toBeEnabled()
  await phone.fill('0812345678')
  await expect(phone).toHaveValue('081 234 5678')
  await advance('Next', 'products')

  // The menu is optional, but a dish the owner names lands in the section they
  // name, and this save writes that section's collection.
  await page.getByPlaceholder('Grilled squid').fill('Grilled squid')
  await page.getByPlaceholder('THB').fill('180')
  await page.getByPlaceholder('Small plates, Skewers, Drinks…').fill('Small plates')
  await page.getByRole('button', { name: 'Add dish' }).click()
  await expect(step('products')).toContainText(formatMinorAmount(18000, 'THB'))
  // The business name supplies the headline; the owner can customize it.
  await advance('Next', 'look')
  const next = page.getByRole('button', { name: 'Next', exact: true })
  const headline = page.getByPlaceholder('A clear promise guests remember')
  await expect(headline).toHaveValue(name)
  await expect(next).toBeEnabled()
  // The look: a starter palette and a font, both written to the site.
  await page.getByRole('button', { name: 'Use the Forest colors' }).click()
  await expect(page.getByRole('button', { name: 'Use the Forest colors' })).toHaveAttribute('aria-pressed', 'true')
  await step('look').getByRole('combobox').click({ timeout: 30_000 })
  await page.getByRole('option', { name: 'Lora', exact: true }).click({ timeout: 30_000 })
  await headline.fill('Fresh from the Andaman, every morning')
  await expect(next).toBeEnabled()
  await advance('Next', 'review')

  // Review: the answers, and the address the next press claims.
  await expect(step('review')).toContainText(name)
  const liveHost = (await step('review').getByText('Your site goes live at').locator('strong').textContent())!.trim()
  expect(liveHost).toBe(new URL(organizationOrigin).host)

  // There is no done screen. Activation lands the owner in their new
  // organization's dashboard, so leaving the flow is how the press reports it
  // finished.
  await page.getByRole('button', { name: 'Create my site', exact: true }).click()
  await expect(page).not.toHaveURL(/\/dashboard\/onboarding/)

  // Activation created a new organization named after the business and made it
  // the session's active one, so post-login lands there too.
  const session = await (await page.request.get('/api/auth/get-session')).json() as { session: { activeOrganizationId: string | null } }
  const organizationId = session.session.activeOrganizationId
  expect(typeof organizationId).toBe('string')
  const organizations = await (await page.request.get('/api/auth/organization/list')).json() as Array<{ id: string; name: string; slug: string }>
  const created = organizations.find(organization => organization.id === organizationId)
  expect(created?.name).toBe(name)
  await expect(page).toHaveURL(new RegExp(`/dashboard/${created!.slug}$`))
  const postLogin = await page.request.get('/api/post-login', { maxRedirects: 0 })
  expect(postLogin.status()).toBe(302)
  expect(postLogin.headers().location).toBe(`/dashboard/${created!.slug}`)

  // The site subdomain and the organization slug are derived separately, so the
  // host the pane framed names the subdomain, not the slug. The organization is
  // the site, so the subdomain is the organization's own.
  const context = await (await page.request.get('/api/dashboard/context', { params: { org: created!.slug } })).json() as { organization: { subdomain: string | null } }
  expect(context.organization.subdomain).toBe(organizationSubdomain(organizationOrigin))

  // And the request that a moment ago did not get the site now does, with no
  // preview token anywhere: that is what activation means.
  const live = await request.get(asAnyone.url, { headers: asAnyone.headers })
  expect(live.status()).toBe(200)
  const liveHtml = await live.text()
  expect(liveHtml).toContain(name)
  // The look the owner chose is the site's: the Forest palette and Lora.
  const settings = await (await page.request.get(`/api/organizations/${organizationId}/settings`)).json() as { settings: { palette: { light: { action: string } }; palette_source: string; font_preset: string } }
  expect(settings.settings.palette_source).toBe('custom')
  expect(settings.settings.palette.light.action).toBe(starterPalette('forest').light.action)
  expect(settings.settings.font_preset).toBe('lora')
  expect(liveHtml).toContain('data-font-preset="lora"')
  expect(liveHtml).toContain(`--site-action-light:${starterPalette('forest').light.action}`)

  // The new site's section holds the slug the other tenant's collection holds.
  const own = await page.request.get(`/api/editor/organizations/${organizationId}/collections`)
  expect(own.status(), await own.text()).toBe(200)
  const ownCollections = (await own.json() as { collections: Array<{ name: string; slug: string; location_id: string | null }> }).collections
  expect(ownCollections).toEqual([expect.objectContaining({ name: 'Small plates', slug: heldCollection.slug, location_id: null })])

  // An anonymous visitor's menu shows the dish, priced, under that section.
  const visitor = await browser.newContext({ extraHTTPHeaders: asAnyone.headers })
  const menu = await visitor.newPage()
  const menuResponse = await menu.goto(new URL('menu', asAnyone.url).href)
  expect(menuResponse?.status()).toBe(200)
  const section = menu.locator('section').filter({ has: menu.getByRole('heading', { level: 2, name: 'Small plates', exact: true }) })
  await expect(section).toHaveCount(1)
  await expect(section).toContainText('Grilled squid')
  await expect(section).toContainText(formatMinorAmount(18000, 'THB'))
  await visitor.close()
  expect(placesRequests).toEqual([])
})

// Kikuzuki's own listing, answered by the real Places API (New) through the
// server. Picking Google's prediction is the confirmation: its Place Details
// seed the screens after it, and the draft carries only its placeId.
const KIKUZUKI = { placeId: 'ChIJi-IgEJ2VUTAR1R3W1qDnhQ8', name: 'Kikuzuki Japanese Robatayaki & Izakaya' }

test('a new owner picks their Google listing and it seeds location, contact and hours', async ({ page, baseURL }) => {
  test.skip(process.env.E2E_GOOGLE_PLACES !== 'true', 'Live Google Places qualification requires E2E_GOOGLE_PLACES=true')
  await dismissPreviewToolbar(page)
  await loginAs(page.request, baseURL!, 'user-e2e-onboarding-wizard')
  const discarded = await page.request.delete('/api/dashboard/onboarding/drafts/active')
  expect(discarded.status(), await discarded.text()).toBe(200)

  const step = (id: string) => page.locator(`[data-onboarding-step="${id}"]`)

  // The step table has one business step. The steps it replaced are not routes.
  for (const retired of ['name', 'source', 'maps', 'confirm']) {
    await page.goto(`/dashboard/onboarding/${retired}`)
    await expect(page).toHaveURL(/\/dashboard\/onboarding$/)
  }

  await page.goto('/dashboard/onboarding/type')
  await expect(page.locator('[data-onboarding-hydrated="true"]')).toBeVisible()
  await page.getByRole('button', { name: 'Restaurant, café or bar' }).click()
  await expect(step('language')).toBeVisible()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(step('business')).toBeVisible()
  await page.getByRole('button', { name: 'Import from Google Maps', exact: true }).click()

  // Predictions appear as the owner types; each names the place and its area.
  const autocomplete = page.waitForRequest(sent => sent.url().includes('/api/dashboard/google-places/autocomplete'))
  await page.getByPlaceholder('Search for your business on Google Maps').pressSequentially('Kikuzuki Krabi')
  const sessionToken = ((await autocomplete).postDataJSON() as { sessionToken: string }).sessionToken
  const suggestion = page.getByRole('option', { name: new RegExp(KIKUZUKI.name.replace(/[&]/g, '\\$&')) })
  await expect(suggestion).toContainText('Ao Nang')
  await expect(page.locator('[data-google-maps-attribution]')).toHaveText('Google Maps')

  // Selecting it closes the Google session with the same token.
  const details = page.waitForRequest(sent => sent.url().includes('/api/dashboard/google-places/details'))
  await suggestion.click()
  expect((await details).postDataJSON()).toEqual({ placeId: KIKUZUKI.placeId, sessionToken })

  // Location is seeded from the place and stays editable.
  await expect(step('location')).toBeVisible()
  await expect(page.getByPlaceholder('123 Main Street')).toHaveValue('325')
  await expect(page.getByPlaceholder('City', { exact: true })).toHaveValue('KRABI')
  await expect(step('location')).toContainText('Thailand')
  await page.getByRole('button', { name: 'Next', exact: true }).click()

  // Hours: the place's timezone and its opening hours.
  await expect(step('hours')).toBeVisible()
  await expect(step('hours')).toContainText('Bangkok · GMT+7')
  await page.getByRole('button', { name: 'Save hours', exact: true }).click()

  // Currency is confirmed before the first save creates the pending site.
  await expect(step('currency')).toBeVisible()
  await expect(step('currency')).toContainText('Thai Baht (THB)')
  await page.getByRole('button', { name: 'Next', exact: true }).click()

  // Contact: Google's national number, read in the place's own country.
  await expect(step('contact')).toBeVisible()
  await expect(page.getByPlaceholder('Phone number')).toHaveValue('095 293 2112')

  // The saved draft names the Google place, which the server fetched itself.
  const saved = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(saved.status(), await saved.text()).toBe(200)
  const draft = (await saved.json() as { draft: { sourceType: string; placeId: string; details: { name: string; phone: string; timezone: string; currency: string; openingHours: { periods: unknown[] } } } }).draft
  expect(draft).toMatchObject({ sourceType: 'google_places', placeId: KIKUZUKI.placeId, details: { name: KIKUZUKI.name, phone: '+66952932112', timezone: 'Asia/Bangkok', currency: 'THB' } })
  expect(draft.details.openingHours.periods.length).toBeGreaterThan(0)

  const cleared = await page.request.delete('/api/dashboard/onboarding/drafts/active')
  expect(cleared.status(), await cleared.text()).toBe(200)
})

// Deleting the site from Site settings is Better Auth's organization delete, and
// the draft that created the site goes with it. It used to survive detached, so
// the owner signing up again was offered the deleted site to resume (#1113).
test('deleting a site through Better Auth also deletes the draft that created it', async ({ page, baseURL }) => {
  await loginAs(page.request, baseURL!, 'user-e2e-onboarding-wizard')
  const discarded = await page.request.delete('/api/dashboard/onboarding/drafts/active')
  expect(discarded.status(), await discarded.text()).toBe(200)

  const name = `E2E Deleted ${Date.now().toString(36)}`
  const firstSave = await page.request.post('/api/dashboard/onboarding/drafts/active', {
    data: { sourceType: 'manual', vertical: 'restaurant', name, details: { sourceLocale: 'en', currency: 'THB', timezone: 'Asia/Bangkok', country: 'TH', city: 'Ao Nang', streetAddress: '88 Moo 2' } },
  })
  expect(firstSave.status(), await firstSave.text()).toBe(200)
  const { organizationId } = await firstSave.json() as { organizationId: string }

  const deleted = await page.request.post('/api/auth/organization/delete', { headers: authRequestHeaders(baseURL!), data: { organizationId } })
  expect(deleted.status(), await deleted.text()).toBe(200)

  const organizations = await (await page.request.get('/api/auth/organization/list')).json() as Array<{ id: string }>
  expect(organizations.map(organization => organization.id)).not.toContain(organizationId)
  const resumed = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(resumed.status(), await resumed.text()).toBe(200)
  expect(await resumed.json()).toEqual({ success: true, draft: null })
})

test('the business search API refuses what the picker would never send', async ({ request, baseURL }) => {
  const sessionToken = crypto.randomUUID()
  const anonymous = await request.post('/api/dashboard/google-places/autocomplete', { data: { input: 'Kikuzuki', sessionToken } })
  expect(anonymous.status()).toBe(401)

  await loginAs(request, baseURL!, 'user-e2e-demo-owner')
  const short = await request.post('/api/dashboard/google-places/autocomplete', { data: { input: 'ki ', sessionToken } })
  expect(short.status(), await short.text()).toBe(400)
  const malformed = await request.post('/api/dashboard/google-places/autocomplete', { data: { input: 'Kikuzuki', sessionToken: 'not-a-uuid' } })
  expect(malformed.status(), await malformed.text()).toBe(400)
  const detailsMalformed = await request.post('/api/dashboard/google-places/details', { data: { placeId: KIKUZUKI.placeId, sessionToken: 'not-a-uuid' } })
  expect(detailsMalformed.status(), await detailsMalformed.text()).toBe(400)
})

// Ember & Slice is on Commerce, billed for the 2 included locations, and has
// both. A third is refused by the createLocation every surface shares, and the
// new location's own level offers to add a location to the plan instead of its sections.
test('a location beyond the ones the plan pays for is refused until the plan covers it', async ({ page, baseURL }) => {
  await loginAs(page.request, baseURL!, 'user-e2e-demo-owner')
  const status = async () => {
    const response = await page.request.get('/api/billing/status?organizationId=org-demo')
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as { billing: { plan: string; locations: { used: number; covered: number } } }).billing
  }
  const before = await status()
  expect(before.plan).toBe('commerce')
  expect(before.locations).toEqual({ used: 2, covered: 2 })

  const refused = await page.request.post('/api/dashboard/locations?org=ember-slice-demo', { data: { title: 'Third branch', timezone: 'America/New_York' } })
  expect(refused.status(), await refused.text()).toBe(402)
  expect(await refused.json()).toEqual({
    error: 'Your plan covers 2 locations. Add a location to your plan in Billing (2 included, then $49 per additional location per month), then create it.',
    code: 'LOCATION_LIMIT',
    locations: { used: 2, covered: 2 },
  })
  expect((await status()).locations).toEqual({ used: 2, covered: 2 })

  await page.goto('/dashboard/ember-slice-demo/locations/new')
  const limit = page.locator('[data-location-limit]')
  await expect(limit).toContainText('Your site has 2 locations, and your plan covers 2. Plans include 2, then $49 per additional location per month.')
  await expect(limit.getByRole('button', { name: 'Add a location to your plan', exact: true })).toBeVisible()
  // Nothing opens beside it: there is no section to walk until the plan covers one more.
  await expect(page.getByRole('button', { name: 'Start with Name', exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(/\/dashboard\/ember-slice-demo\/locations\/new$/)
})

// NCLS has one of the two locations its plan includes. Adding one walks the
// location record's own create level: Name, then Hours, then Create location,
// which opens the location it made.
test('a location is created by walking its own record', async ({ page, baseURL }) => {
  await dismissPreviewToolbar(page)
  await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
  const org = 'north-carolina-legal-services'
  await page.goto(`/dashboard/${org}/locations/new`)
  await expect(page).toHaveURL(new RegExp(`/dashboard/${org}/locations/new/name$`))
  await expect(page.getByRole('heading', { name: 'New location' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Name' }).fill('Raleigh Annex')
  await page.getByRole('button', { name: 'Next: Hours', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/${org}/locations/new/hours/timezone$`))
  await page.getByRole('button', { name: 'Time zone', exact: true }).click()
  await page.getByPlaceholder('Search by city, e.g. Bangkok').fill('America/New_York')
  await page.getByRole('option').first().click()
  await page.getByRole('button', { name: 'Create location', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/${org}/locations/raleigh-annex$`))

  const created = await page.request.get(`/api/dashboard/locations?org=${org}`)
  expect(created.status(), await created.text()).toBe(200)
  const location = ((await created.json()) as { locations: Array<{ id: string; slug: string; title: string; timezone: string }> }).locations
    .find(candidate => candidate.slug === 'raleigh-annex')
  expect(location).toMatchObject({ title: 'Raleigh Annex', timezone: 'America/New_York' })
  const deleted = await page.request.delete(`/api/organizations/org-ncls-blawby/locations/${location!.id}`)
  expect(deleted.status(), await deleted.text()).toBe(200)
})

// A location made by its own record has no place yet; Settings → Google Maps
// connects it through the business picker, and connects another the same way.
// Runs against the NCLS tenant's local copy; the location is deactivated at the end.
test('Settings connects a new location to Google Maps through the business picker', async ({ page, baseURL }) => {
  test.skip(process.env.E2E_GOOGLE_PLACES !== 'true', 'Live Google Places qualification requires E2E_GOOGLE_PLACES=true')
  await dismissPreviewToolbar(page)
  await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
  const org = 'north-carolina-legal-services'
  const connected = async () => {
    const settings = await page.request.get(`/api/dashboard/settings?org=${org}`)
    expect(settings.status(), await settings.text()).toBe(200)
    return (await settings.json() as { settings: { integrations: { google_maps: Array<{ id: string; slug: string; google_place_id: string | null }> } } }).settings.integrations.google_maps
  }

  const made = await page.request.post(`/api/dashboard/locations?org=${org}`, { data: { title: "Joe's Pizza", timezone: 'America/New_York' } })
  expect(made.status(), await made.text()).toBe(201)
  const { location } = await made.json() as { location: { id: string; slug: string } }
  await page.goto(`/dashboard/${org}/integrations/google-maps/${location.slug}`)
  const picked = page.waitForRequest(sent => sent.url().includes('/api/dashboard/google-places/details'))
  await page.getByPlaceholder('Search for your business on Google Maps').pressSequentially(' Carmine Street')
  await page.getByRole('option', { name: /Carmine St/ }).first().click()
  const placeId = ((await picked).postDataJSON() as { placeId: string }).placeId
  await expect(page.getByText('Connected to Google Maps')).toBeVisible()

  const added = (await connected()).find(candidate => candidate.google_place_id === placeId)
  expect(added, `no location connected to ${placeId}`).toBeTruthy()

  // Choosing another prediction is the confirmation, and connects it.
  await page.getByRole('button', { name: 'Connect a different place' }).click()
  const search = page.getByPlaceholder('Search for your business on Google Maps')
  await expect(search).toHaveValue("Joe's Pizza")
  await search.pressSequentially(' Broadway')
  const repicked = page.waitForRequest(sent => sent.url().includes('/api/dashboard/google-places/details'))
  const synced = page.waitForResponse(response => response.url().includes('/api/integrations/google-places/sync'))
  await page.getByRole('option', { name: /Joe's Pizza Broadway/ }).first().click()
  const otherPlaceId = ((await repicked).postDataJSON() as { placeId: string }).placeId
  expect(otherPlaceId).not.toBe(placeId)
  expect((await synced).status()).toBe(200)
  await expect(page.getByText('Connected to Google Maps')).toBeVisible()
  expect((await connected()).find(location => location.id === added!.id)?.google_place_id).toBe(otherPlaceId)

  const deactivated = await page.request.patch(`/api/dashboard/locations/${added!.id}?org=${org}`, { data: { status: 'inactive' } })
  expect(deactivated.status(), await deactivated.text()).toBe(200)
})
