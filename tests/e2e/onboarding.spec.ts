import { expect, test, type APIRequestContext } from '@playwright/test'
import { dismissPreviewToolbar } from './helpers'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { mcpData, mcpRequest, publishOwnHostProfile } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'
import { readLocalTenant } from './test-env'
import { formatMinorAmount } from '../../shared/prices'
import { starterPalette } from '../../shared/site-palette'
import type { Product } from '../../server/types/products'

// The manual-name path of the new-site flow, driven the way an owner drives it:
// the welcome screen, then one question per route, each advanced by the shell's
// own footer; the preview pane framing the owner's pending site on its own
// subdomain; and activation committing a private site in a new organization.
// The owner then publishes from Today.
//
// Another tenant already holds an organization-wide collection with the slug
// this owner's menu section takes. A collection slug is unique within its
// organization, so the new site gets the same slug for its own section rather
// than failing to save it.
// The new-site journeys share one fixture owner and active draft. Keep this
// file in order, and share its actor lock with the account organization journey.
test.describe.configure({ mode: 'default' })

// Ember & Slice holds the organization-wide collection the new site's section shares a slug with.
const otherTenantId = () => seededTenant('restaurant').organizationId
let otherTenant: { owner: APIRequestContext; collectionId: string } | null = null
let releaseWizardMutationLock: (() => Promise<void>) | undefined

test.beforeEach(async ({ request: _request }, testInfo) => {
  releaseWizardMutationLock = await acquireTenantMutationLock(testInfo, 'user-e2e-onboarding-wizard')
})

test.afterEach(async () => {
  try {
    if (!otherTenant) return
    const { owner, collectionId } = otherTenant
    otherTenant = null
    const removed = await owner.delete(`/api/editor/organizations/${otherTenantId()}/collections/${collectionId}`)
    expect(removed.status(), await removed.text()).toBe(200)
    await owner.dispose()
  } finally {
    const release = releaseWizardMutationLock
    releaseWizardMutationLock = undefined
    await release?.()
  }
})

test('a new owner builds a draft and creates a site through the routed flow', async ({ page, request, baseURL, browser, playwright }) => {
  test.setTimeout(60_000)
  const owner = await playwright.request.newContext({ baseURL })
  await loginAs(owner, baseURL!, 'user-e2e-kikuzuki-owner')
  const held = await owner.post(`/api/editor/organizations/${otherTenantId()}/collections`, { data: { name: 'Small plates' } })
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

  // The welcome picker requires a business type before Continue.
  await expect(step('type')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Exit', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Save & exit', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await expect(step('type').locator('[aria-pressed="true"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Restaurant, café or bar' }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
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
  await step('currency').getByRole('button', { name: 'Currency*', exact: true }).click()
  await page.getByRole('option', { name: 'Thai Baht (THB)', exact: true }).click()
  await expect(step('contact')).toBeVisible()

  // The draft holds the typed name as a manual business, with no Google place.
  const saved = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(saved.status(), await saved.text()).toBe(200)
  const initialDraft = (await saved.json() as { draft: { draft_id: string; organization_id: string; updated_at: string } }).draft
  expect(initialDraft).toMatchObject({ source_type: 'manual', google_place_id: null, details: { name, currency: 'THB', timezone: 'Asia/Bangkok' } })
  const nativeWorkspaces = await page.request.get('/api/account/organizations?onboarding_status=active')
  expect(nativeWorkspaces.status()).toBe(200)
  expect((await nativeWorkspaces.json()).organizations).not.toContainEqual(expect.objectContaining({ id: initialDraft.organization_id }))

  await expect(page.getByText('Your answers have not been saved yet.', { exact: true })).toHaveCount(0)

  const previewFrame = page.locator('iframe[title="Site preview"]')
  await expect(previewFrame).toHaveAttribute('src', /preview_token=/)
  const organizationURL = new URL((await previewFrame.getAttribute('src'))!)
  expect(organizationURL.hostname).toMatch(/^[a-z0-9-]+\.localhost$/)
  const subdomain = organizationURL.hostname.slice(0, -'.localhost'.length)
  const preview = page.frameLocator('iframe[title="Site preview"]')
  await expect(preview.locator('body')).toContainText(name)
  await expect(preview.locator('body')).not.toContainText('did not match its contract')

  // The preview cookie keeps the pending site accessible as its own links open.
  const frame = page.frame({ url: /preview_token=/ })
  expect(frame).not.toBeNull()
  await frame!.evaluate(() => { window.location.href = window.location.pathname })
  await frame!.waitForURL(`${organizationURL.origin}/`)
  await expect(preview.locator('body')).toContainText(name)
  const config = await frame!.evaluate(async () => {
    const response = await fetch('/api/public/config')
    return { status: response.status, body: await response.json() }
  })
  expect(config.status).toBe(200)
  expect(config.body).toMatchObject({ success: true, config: { default_currency: 'THB' } })

  // Nobody else can see it yet. `request` has its own cookie jar, so this asks
  // for the site carrying neither a preview token nor the preview cookie the
  // framed load leaves behind.
  const anonymousPreview = await readLocalTenant(request, subdomain, '/')
  expect(anonymousPreview.status()).toBe(404)
  expect(await anonymousPreview.text()).not.toContain(name)

  // Contact: the phone picker arrives seeded with that country, and the number
  // is accepted the way a Thai owner writes it, trunk zero included.
  const phone = page.getByLabel('Phone', { exact: true })
  await expect(page.getByLabel(/^Phone country: /)).toContainText('+66')
  await expect(phone).toHaveAttribute('placeholder', '081 234 5678')
  await phone.fill('0812345678')
  await expect(phone).toHaveValue('081 234 5678')

  // Another editor saves the same draft. Exit must report the stale revision,
  // keep the owner's edit on screen and leave the newer persisted answer intact.
  const competingSave = await page.request.post('/api/dashboard/onboarding/drafts/active', {
    data: { draft_id: initialDraft.draft_id, updated_at: initialDraft.updated_at, details: { phone: '+66821234567' } },
  })
  expect(competingSave.status(), await competingSave.text()).toBe(200)
  const competingRevision = (await competingSave.json() as { updated_at: string }).updated_at
  const failedExitResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/dashboard/onboarding/drafts/active')
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click()
  const failedExit = await failedExitResponse
  expect(failedExit.status(), await failedExit.text()).toBe(409)
  await expect(page.getByText('Website draft changed; read it before saving', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard\/onboarding\/contact$/)
  await expect(phone).toHaveValue('081 234 5678')
  const newerDraft = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(newerDraft.status(), await newerDraft.text()).toBe(200)
  expect((await newerDraft.json() as { draft: unknown }).draft).toMatchObject({
    draft_id: initialDraft.draft_id, organization_id: initialDraft.organization_id, updated_at: competingRevision,
    details: { name, phone: '+66821234567', currency: 'THB', timezone: 'Asia/Bangkok' },
  })

  await page.reload()
  await expect(step('contact')).toBeVisible()
  await expect(phone).toHaveValue('082 123 4567')
  await phone.fill('0812345678')
  // Exit goes through post-login, which lands on the draft's organization.
  // Wait for that landing so the next navigation doesn't race the redirect.
  const draftOrganization = (await (await page.request.get('/api/auth/organization/list')).json() as Array<{ id: string; slug: string }>)
    .find(organization => organization.id === initialDraft.organization_id)
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/${draftOrganization!.slug}$`))
  const exitedDraft = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(exitedDraft.status(), await exitedDraft.text()).toBe(200)
  expect((await exitedDraft.json() as { draft: unknown }).draft).toMatchObject({
    draft_id: initialDraft.draft_id, organization_id: initialDraft.organization_id,
    details: { name, phone: '+66812345678', currency: 'THB', timezone: 'Asia/Bangkok' },
  })

  // A cold entry restores the saved draft. Required answers are complete, so
  // resume opens review; Back still reaches the saved optional contact answer.
  await page.goto('/dashboard/onboarding')
  await expect(page.locator('[data-onboarding-hydrated="true"]')).toBeVisible()
  await expect(step('review')).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(step('look')).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(step('products')).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(step('contact')).toBeVisible()
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

  // Hold the actual upload in flight so navigation cannot race its revision.
  // Releasing it reaches the local endpoint and its real Images refusal.
  const uploadPath = `/api/dashboard/onboarding/drafts/${initialDraft.draft_id}/media/upload`
  const uploadRoute = `**${uploadPath}`
  const uploadStarted = Promise.withResolvers<undefined>()
  const uploadRelease = Promise.withResolvers<undefined>()
  await page.route(uploadRoute, async route => {
    uploadStarted.resolve(undefined)
    await uploadRelease.promise
    await route.continue()
  })
  const uploadResponse = page.waitForResponse(response => new URL(response.url()).pathname === uploadPath
    && response.request().method() === 'POST')
  try {
    await step('look').locator('input[type="file"]').first().setInputFiles({
      name: 'onboarding-logo.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'),
    })
    await uploadStarted.promise
    await expect(page.getByRole('button', { name: 'Save & exit', exact: true })).toBeDisabled()
    await expect(next).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeDisabled()
  } finally {
    uploadRelease.resolve(undefined)
    await uploadResponse
    await page.unroute(uploadRoute)
  }
  const refusedUpload = await uploadResponse
  expect(refusedUpload.status(), await refusedUpload.text()).toBe(503)
  await expect(step('look').getByText(/Cloudflare Images is not configured in this environment, by design/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save & exit', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeEnabled()
  await expect(next).toBeEnabled()
  await advance('Next', 'review')

  // Review: the answers, and the address the next press claims.
  await expect(step('review')).toContainText(name)
  const liveHost = (await step('review').getByText('Your site stays private until you publish it.').locator('strong').textContent())!.trim()
  expect(liveHost).toBe(organizationURL.host)

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
  const activatedWorkspaces = await page.request.get('/api/account/organizations?onboarding_status=active')
  expect(activatedWorkspaces.status()).toBe(200)
  expect((await activatedWorkspaces.json()).organizations).toContainEqual(expect.objectContaining({ id: organizationId, name }))

  await expect(page).toHaveURL(new RegExp(`/dashboard/${created!.slug}$`))
  const postLogin = await page.request.get('/api/post-login', { maxRedirects: 0 })
  expect(postLogin.status()).toBe(302)
  expect(postLogin.headers().location).toBe(`/dashboard/${created!.slug}`)

  // The site subdomain and the organization slug are derived separately, so the
  // host the pane framed names the subdomain, not the slug. The organization is
  // the site, so the subdomain is the organization's own.
  const context = await (await page.request.get('/api/dashboard/context', { params: { org: created!.slug } })).json() as { organization: { subdomain: string | null } }
  expect(context.organization.subdomain).toBe(subdomain)

  const website = page.getByTestId('today-website')
  await expect(website).toContainText('Private')
  const stillPrivate = await readLocalTenant(request, subdomain, '/')
  expect(stillPrivate.status()).toBe(404)
  expect(await stillPrivate.text()).not.toContain(name)
  await expect(website.frameLocator('iframe').locator('body')).toContainText(name)
  const suggestions = page.getByTestId('today-opportunities')
  await expect(suggestions.getByRole('link', { name: /Set up payments/ })).toHaveAttribute('href', /\/payments\/payout-method$/)
  await suggestions.getByRole('link', { name: /Connect a custom domain/ }).click()
  await expect(page.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', /\/billing\/upgrade\?plan=growth$/)
  await expect(page.getByRole('button', { name: 'Connect domain' })).toHaveCount(0)
  await expect(page.getByText('Private', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'View plans' }).click()
  await expect(page.getByRole('radio', { name: /^Growth/ })).toBeChecked()
  await page.goto(`/dashboard/${created!.slug}`)
  await website.getByRole('link', { name: 'Publish website' }).click()
  await page.getByRole('button', { name: 'Make public' }).click()
  await expect(website).toContainText('Live')
  // Publishing makes the same site public, without a preview token.
  const live = await readLocalTenant(request, subdomain, '/')
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
  const visitor = await browser.newContext()
  const menu = await visitor.newPage()
  const menuResponse = await menu.goto(new URL('/menu', organizationURL).href)
  expect(menuResponse?.status()).toBe(200)
  const section = menu.locator('section').filter({ has: menu.getByRole('heading', { level: 2, name: 'Small plates', exact: true }) })
  await expect(section).toHaveCount(1)
  await expect(section).toContainText('Grilled squid')
  await expect(section).toContainText(formatMinorAmount(18000, 'THB'))
  await visitor.close()
  expect(placesRequests).toEqual([])
})

test('a new experience site saves its first experience privately until booking setup is complete', async ({ page, baseURL }) => {
  await dismissPreviewToolbar(page)
  await loginAs(page.request, baseURL!, 'user-e2e-onboarding-wizard')
  const discarded = await page.request.delete('/api/dashboard/onboarding/drafts/active')
  expect(discarded.status(), await discarded.text()).toBe(200)
  const empty = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(empty.status(), await empty.text()).toBe(200)
  expect(await empty.json()).toEqual({ success: true, draft: null })
  try {
    const created = await page.request.post('/api/dashboard/onboarding/drafts/active', {
      data: { source_type: 'manual', vertical: 'experience', name: `E2E experience ${Date.now().toString(36)}`, details: { source_locale: 'en', currency: 'THB', timezone: 'Asia/Bangkok', country: 'TH', city: 'Ao Nang', street_address: '88 Moo 2', phone: '+66812345678' } },
    })
    expect(created.status(), await created.text()).toBe(200)
    const { organization_id: organizationId } = await created.json() as { organization_id: string }
    await page.goto('/dashboard/onboarding/products')
    await expect(page.locator('[data-onboarding-hydrated="true"]')).toBeVisible()
    const products = page.locator('[data-onboarding-step="products"]')
    await expect(products).toContainText('Booking details are required before an experience can be published.')
    await page.getByPlaceholder('Sunset kayak tour').fill('Mangrove kayak trip')
    await products.getByLabel('Price', { exact: true }).fill('850')
    await page.getByRole('button', { name: 'Add experience', exact: true }).click()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.locator('[data-onboarding-step="look"]')).toBeVisible()

    // Read the actual catalog independently of the onboarding draft writer.
    const catalog = await page.request.get(`/api/editor/organizations/${organizationId}/products`)
    expect(catalog.status(), await catalog.text()).toBe(200)
    const saved = (await catalog.json() as { products: Product[] }).products
    expect(saved).toHaveLength(1)
    const experience = saved[0]!
    expect(experience).toMatchObject({ kind: 'experience', name: 'Mangrove kayak trip', booking: null, stay: null, order_url: null })
    expect(experience.variants).toHaveLength(1)
    expect(experience.variants[0]!.prices).toEqual([expect.objectContaining({ unit_amount: 85000, currency: 'THB' })])
    expect(experience.publications).toEqual([expect.objectContaining({ organization_id: organizationId, published: false })])
    expect(experience.locations).toEqual([expect.objectContaining({ active: true, published: false })])
    const publication = await page.request.put(`/api/editor/organizations/${organizationId}/products/${experience.id}/publication`, { data: { published: true } })
    expect(publication.status(), await publication.text()).toBe(409)
    const readBack = await page.request.get(`/api/editor/organizations/${organizationId}/products/${experience.id}`)
    expect(readBack.status(), await readBack.text()).toBe(200)
    expect((await readBack.json() as { product: Product }).product.publications).toEqual([expect.objectContaining({ published: false })])
    await page.goto('/dashboard/onboarding/products')
    await expect(page.locator('[data-onboarding-step="products"]')).toContainText('Mangrove kayak trip')
  } finally {
    const removed = await page.request.delete('/api/dashboard/onboarding/drafts/active')
    expect(removed.status(), await removed.text()).toBe(200)
    const discardedDraft = await page.request.get('/api/dashboard/onboarding/drafts/active')
    expect(discardedDraft.status(), await discardedDraft.text()).toBe(200)
    expect(await discardedDraft.json()).toEqual({ success: true, draft: null })
  }
})

test('an owner changes their restaurant draft to lodging and saves their first home as a draft', async ({ page, baseURL, request }, testInfo) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await dismissPreviewToolbar(page)
  await loginAs(page.request, baseURL!, 'user-e2e-onboarding-wizard')
  const previous = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(previous.status(), await previous.text()).toBe(200)
  const previousDraft = (await previous.json() as { draft: { organization_id: string | null } | null }).draft
  const discarded = await page.request.delete('/api/dashboard/onboarding/drafts/active')
  expect(discarded.status(), await discarded.text()).toBe(200)
  expect(await discarded.json()).toEqual({ success: true, deleted: previousDraft?.organization_id != null })
  const cleared = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(cleared.status(), await cleared.text()).toBe(200)
  expect(await cleared.json()).toEqual({ success: true, draft: null })
  const name = `E2E Lodging ${Date.now().toString(36)}`
  const step = (id: string) => page.locator(`[data-onboarding-step="${id}"]`)
  const advance = async (label: string, next: string) => {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(step(next)).toBeVisible()
  }

  await page.goto('/dashboard/onboarding/type')
  await expect(step('type')).toBeVisible()
  await expect(step('type').getByRole('button')).toHaveCount(4)
  await page.getByRole('button', { name: 'Restaurant, café or bar', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(step('language')).toBeVisible()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(step('business')).toBeVisible()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await advance('Next', 'location')
  await page.getByRole('textbox', { name: 'Street address' }).fill('88 Moo 2')
  await page.getByPlaceholder('City', { exact: true }).fill('Ao Nang')
  await step('location').getByText('Select country').click()
  await page.getByPlaceholder('Search country...').fill('Thailand')
  await page.getByRole('option', { name: /Thailand/ }).click()
  await advance('Next', 'hours')
  await expect(step('hours')).toContainText('Bangkok · GMT+7')
  await advance('Save hours', 'currency')
  await expect(step('currency')).toContainText('Thai Baht (THB)')
  await advance('Next', 'contact')
  await advance('Skip for now', 'products')
  await page.getByPlaceholder('Grilled squid').fill('Grilled squid')
  await page.getByRole('button', { name: 'Add dish', exact: true }).click()
  await advance('Next', 'look')
  const restaurant = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(restaurant.status(), await restaurant.text()).toBe(200)
  expect((await restaurant.json() as { draft: unknown }).draft).toMatchObject({
    vertical: 'restaurant', products: [{ name: 'Grilled squid', category: 'Menu', unit_amount: null }],
  })

  // The saved restaurant offering is restored before the owner changes type.
  // Selecting lodging removes it from the answers, and the next save must send
  // the new type with no generic offerings rather than fail on a hidden field.
  await page.goto('/dashboard/onboarding/type')
  await expect(step('type').getByRole('button', { name: 'Restaurant, café or bar', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Lodging or vacation rentals', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(step('language')).toBeVisible()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(step('business')).toBeVisible()
  await advance('Next', 'location')
  await advance('Next', 'hours')
  await advance('Save hours', 'currency')
  const convertedSave = page.waitForRequest(sent => sent.method() === 'POST' && new URL(sent.url()).pathname === '/api/dashboard/onboarding/drafts/active')
  await advance('Next', 'contact')
  expect((await convertedSave).postDataJSON()).toMatchObject({ vertical: 'lodging', products: [] })
  await advance('Skip for now', 'look')
  await expect(step('products')).toHaveCount(0)
  await advance('Next', 'review')
  await expect(step('review').getByText('Products', { exact: true })).toHaveCount(0)
  await expect(step('review').getByText('Menu', { exact: true })).toHaveCount(0)

  const saved = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(saved.status(), await saved.text()).toBe(200)
  const draft = (await saved.json() as { draft: { draft_id: string; updated_at: string; vertical: string; products: unknown[]; details: { name: string } } }).draft
  expect(draft).toMatchObject({ vertical: 'lodging', products: [], details: { name } })
  // The server refuses a generic onboarding item for a home, before changing
  // the draft. Homes are created with their own required stay settings later.
  const invalidProduct = await page.request.post('/api/dashboard/onboarding/drafts/active', {
    data: { draft_id: draft.draft_id, updated_at: draft.updated_at, products: [{ name: 'A home is not an experience', category: 'Homes', unit_amount: null }] },
  })
  expect(invalidProduct.status(), await invalidProduct.text()).toBe(400)
  const unchanged = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(unchanged.status(), await unchanged.text()).toBe(200)
  expect((await unchanged.json() as { draft: unknown }).draft).toMatchObject({ draft_id: draft.draft_id, updated_at: draft.updated_at, vertical: 'lodging', products: [] })

  // A cold load reads the selected vertical from the persisted draft.
  await page.goto('/dashboard/onboarding/type')
  await expect(step('type').getByRole('button', { name: 'Lodging or vacation rentals', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.goto('/dashboard/onboarding')
  await expect(page.locator('[data-onboarding-hydrated="true"]')).toBeVisible()
  await expect(step('review')).toBeVisible()
  await page.getByRole('button', { name: 'Create my site', exact: true }).click()
  await expect(page).not.toHaveURL(/\/dashboard\/onboarding/)

  const session = await (await page.request.get('/api/auth/get-session')).json() as { session: { activeOrganizationId: string } }
  const organizations = await (await page.request.get('/api/auth/organization/list')).json() as Array<{ id: string; name: string; slug: string }>
  const created = organizations.find(organization => organization.id === session.session.activeOrganizationId)
  expect(created?.name).toBe(name)
  await expect(page).toHaveURL(`/dashboard/${created!.slug}/products?kind=stay`)
  const context = await page.request.get('/api/dashboard/context', { params: { org: created!.slug } })
  expect(context.status(), await context.text()).toBe(200)
  expect((await context.json() as { organization: { id: string; vertical: string } }).organization).toMatchObject({ id: created!.id, vertical: 'lodging' })
  const products = await page.request.get(`/api/editor/organizations/${created!.id}/products`)
  expect(products.status(), await products.text()).toBe(200)
  expect((await products.json() as { products: unknown[] }).products).toEqual([])

  const choices = page.getByTestId('first-home-setup')
  await expect(choices).toBeVisible()
  await page.goto(`/dashboard/${created!.slug}/products`)
  await expect(choices).toBeVisible()
  await choices.getByRole('link', { name: /Import from Airbnb/ }).click()
  await expect(page.getByText('Your Airbnb homes, one calendar', { exact: true })).toBeVisible()
  await page.goBack()
  await choices.getByRole('link', { name: /Add your first home/ }).click()
  await expect(page).toHaveURL(`/dashboard/${created!.slug}/products/new?kind=stay&setup=guided`)
  await expect(page.getByRole('heading', { name: 'Where is your place?' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Street address' })).toHaveValue('88 Moo 2')
  await expect(page.getByRole('textbox', { name: 'City or town' })).toHaveValue('Ao Nang')
  await page.screenshot({ path: testInfo.outputPath('01-home-address.png') })
  await page.getByRole('button', { name: 'Next', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Which of these best describes your place?' })).toBeVisible()
  const house = page.getByRole('button', { name: 'House', exact: true })
  await house.click()
  await page.screenshot({ path: testInfo.outputPath('02-home-property-type.png') })
  await page.getByRole('button', { name: 'Next', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'What space will guests have?' })).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(house).toHaveAttribute('aria-pressed', 'true')
  const next = page.getByRole('button', { name: 'Next', exact: true })
  await next.click()
  await page.getByRole('button', { name: /^Private room/ }).click()
  await page.getByRole('button', { name: 'Save & exit' }).click()
  await page.getByRole('link', { name: /Continue your listing/ }).click()
  await expect(page.getByRole('button', { name: /^Private room/ })).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: testInfo.outputPath('03-home-access.png') })
  const lookup = page.waitForResponse(response => response.url().startsWith('https://photon.komoot.io/api/'))
  await page.route('https://photon.komoot.io/api/**', route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' },
    json: { features: [{ geometry: { coordinates: [98.823, 8.045] } }] },
  }))
  await next.click()
  await expect(page.getByRole('heading', { name: 'Is the pin in the right spot?' })).toBeVisible()
  await lookup
  const map = page.getByTestId('stay-setup-map')
  await expect(map).toHaveAttribute('aria-busy', 'false')
  await expect(map).toHaveAttribute('data-map-zoom', '13')
  const bounds = await map.boundingBox()
  expect(bounds).not.toBeNull()
  const { x, y, width, height } = bounds!
  await page.mouse.move(x + width / 2, y + height / 2)
  await page.mouse.down()
  await page.mouse.move(x + width / 2 + 70, y + height / 2 + 32, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByTestId('stay-setup-map')).toHaveAttribute('data-pin-placed', 'true')
  await page.screenshot({ path: testInfo.outputPath('04-home-pin.png') })
  await next.click()
  await expect(page.getByRole('heading', { name: 'Choose how guests see your location' })).toBeVisible()
  await page.getByRole('switch', { name: /specific location/ }).click()
  await expect(page.getByText('Guests see the precise pin.')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('05-home-visibility.png') })
  await next.click()
  await expect(page.getByRole('heading', { name: 'Share some basics about your place' })).toBeVisible()
  await page.getByLabel('Guests', { exact: true }).fill('4')
  await page.getByLabel('Bedrooms', { exact: true }).fill('2')
  await page.getByLabel('Beds', { exact: true }).fill('3')
  await page.getByLabel('Bathrooms', { exact: true }).fill('1.5')
  await expect(page.getByRole('textbox', { name: 'Listing title' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('06-home-rooms-capacity.png') })
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Tell guests what your place offers' })).toBeVisible()
  await page.getByRole('button', { name: 'Wifi', exact: true }).first().click()
  await page.screenshot({ path: testInfo.outputPath('07-home-amenities.png') })
  await next.click()
  await expect(page.getByRole('heading', { name: 'Add photos of your place' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('08-home-photos-empty.png') })
  await page.getByLabel('Add photos', { exact: true }).setInputFiles([
    'tests/e2e/seed/media/venue.avif', 'tests/e2e/seed/media/room.avif', 'tests/e2e/seed/media/social.avif',
    'tests/e2e/seed/media/class.avif', 'tests/e2e/seed/media/office.avif',
  ])
  await expect(page.getByAltText('Listing photo 5')).toBeVisible()
  const secondPhoto = page.getByAltText('Listing photo 2')
  await expect(secondPhoto).toBeVisible()
  const newCover = await secondPhoto.getAttribute('src')
  await page.getByRole('button', { name: 'Move photo 2 forward' }).click()
  await expect(page.getByAltText('Listing photo 1')).toHaveAttribute('src', newCover!)
  await page.screenshot({ path: testInfo.outputPath('08-home-photos.png') })
  await next.click()
  await expect(page.getByRole('heading', { name: 'Give your listing a title' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Listing title' })).toHaveAttribute('maxlength', '50')
  await page.getByRole('textbox', { name: 'Listing title' }).fill('My first home')
  await page.screenshot({ path: testInfo.outputPath('09-home-title.png') })
  await next.click()
  await expect(page.getByRole('heading', { name: 'What stands out about your place?' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('10-home-highlights-empty.png') })
  await page.getByRole('button', { name: 'Peaceful', exact: true }).click()
  await page.getByRole('button', { name: 'Spacious', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Unique', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('10-home-highlights.png') })
  await next.click()
  await expect(page.getByRole('heading', { name: 'Write your listing description' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Listing description' })).toHaveValue('Slow down and unwind in a peaceful setting. Settle in with plenty of room to spread out.')
  await expect(page.getByRole('textbox', { name: 'Listing description' })).toHaveAttribute('maxlength', '500')
  await page.getByRole('textbox', { name: 'Listing description' }).fill('A quiet place to stay near the beach.')
  await page.screenshot({ path: testInfo.outputPath('10-home-description.png') })
  await next.click()
  await expect(page.getByRole('heading', { name: 'Set a minimum stay' })).toBeVisible()
  await page.getByLabel('Minimum nights', { exact: true }).fill('2')
  await page.screenshot({ path: testInfo.outputPath('11-home-booking.png') })
  await next.click()
  await expect(page.getByRole('heading', { name: 'Now, set your prices' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Base price', exact: true }).fill('1500')
  const weekendAdjustment = page.getByRole('spinbutton', { name: 'Weekend adjustment', exact: true })
  await weekendAdjustment.fill('-10')
  await weekendAdjustment.blur()
  await expect(page.getByText('฿1,350', { exact: true })).toBeVisible()
  await weekendAdjustment.fill('20')
  await weekendAdjustment.blur()
  await expect(weekendAdjustment).toHaveValue('+20')
  await expect(page.getByText('฿1,800', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('12-home-pricing.png') })
  await next.click()
  await expect(page.getByRole('heading', { name: 'Add discounts' })).toBeVisible()
  for (const name of ['Last-minute discount', 'Weekly discount', 'Monthly discount']) {
    await page.getByRole('checkbox', { name, exact: true }).check()
  }
  await page.screenshot({ path: testInfo.outputPath('13-home-discounts.png') })
  await next.click()
  await expect(page.getByRole('heading', { name: 'Share safety details' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('14-home-disclosures-empty.png') })
  await page.getByRole('checkbox', { name: 'Exterior security cameras' }).check()
  const finishHome = page.getByRole('button', { name: 'Finish', exact: true })
  await expect(finishHome).toBeDisabled()
  await page.getByRole('textbox', { name: 'Exterior security cameras: details' }).fill('The front door camera records the entry path.')
  await page.screenshot({ path: testInfo.outputPath('14-home-disclosures.png') })
  const beforeSave = await page.request.get(`/api/editor/organizations/${created!.id}/products`)
  expect(await beforeSave.json()).toMatchObject({ products: [] })
  const submitted = page.waitForRequest(request => new URL(request.url()).pathname === '/api/dashboard/stay-homes/setup')
  await finishHome.click()
  const saveRequest = await submitted
  const locationId = saveRequest.postDataJSON().answers.location_id
  expect(locationId).toEqual(expect.any(String))
  const photoIds = saveRequest.postDataJSON().answers.photo_ids as string[]
  expect(photoIds).toHaveLength(5)
  const { latitude, longitude } = saveRequest.postDataJSON().answers
  expect(latitude).toEqual(expect.any(Number))
  expect(longitude).toEqual(expect.any(Number))
  expect([latitude, longitude]).not.toEqual([8.045, 98.823])
  await expect(page).toHaveURL(new RegExp(`/dashboard/${created!.slug}/products/(?!new)[^/?]+$`))

  const replay = await page.request.post(saveRequest.url(), { data: saveRequest.postDataJSON() })
  expect(replay.status(), await replay.text()).toBe(201)
  expect(await replay.json()).toMatchObject({ to: new URL(page.url()).pathname })
  const homes = await page.request.get('/api/dashboard/stay-homes', { params: { org: created!.slug } })
  expect(homes.status(), await homes.text()).toBe(200)
  expect(await homes.json()).toMatchObject({
    first_home_setup: null,
    homes: [{ name: 'My first home', location_id: locationId, max_guests: 4, property_type_group: 'houses', property_type: 'house',
      listing_type: 'private_room', amenities: ['wireless_internet'], description: 'A quiet place to stay near the beach.',
      latitude, longitude, stay_map_sharing: 'specific', photos: photoIds.map(id => ({ id })),
      bedrooms: 2, beds: 3, bathrooms: 1.5, min_nights: 2, base_price_minor: 150000,
      calendar_rules: { weekend_price_minor: 180000, direct_discounts: { last_minute_percent: 7, weekly_percent: 10, monthly_percent: 20 } }, live: false, address: { address: '88 Moo 2', city: 'Ao Nang', country: 'TH' } }],
  })
  const afterSave = await page.request.get(`/api/editor/organizations/${created!.id}/products`)
  const { products: savedProducts } = await afterSave.json() as { products: Product[] }
  expect(savedProducts).toHaveLength(1)
  expect(savedProducts[0]!.publications).toEqual([{ organization_id: created!.id, published: false }])
  expect(savedProducts[0]!.details).toMatchObject({
    exterior_security_cameras: true,
    exterior_security_cameras_details: 'The front door camera records the entry path.',
    noise_decibel_monitors: false, weapons_on_property: false,
  })
  const finishListing = page.getByRole('link', { name: /Complete steps to publish/ })
  await expect(finishListing).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('11-home-saved-draft.png') })
  await finishListing.click()
  await expect(page.getByRole('heading', { name: 'Complete steps to publish' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Nightly price.*Nightly price set/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Host profile.*Required to publish/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Publish listing/ })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('16-home-publish-steps.png') })
  const listing = savedProducts[0]!
  const productUrl = `/api/editor/organizations/${created!.id}/products/${listing.id}`
  {
    await page.goto(`/dashboard/${created!.slug}/products/${listing.id}`)
    await page.locator('#dashboard-panel-product').getByRole('link', { name: 'View', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'Listing preview', exact: true })
    await expect(preview.frameLocator('iframe').getByRole('heading', { name: 'My first home', exact: true })).toBeVisible()
    const safety = preview.frameLocator('iframe').locator('#things-to-know')
    await expect(safety).toContainText('Exterior security cameras')
    await expect(safety).toContainText('The front door camera records the entry path.')
    await expect(preview.getByText('Private preview', { exact: true })).toHaveCount(0)
    await preview.getByRole('tab', { name: 'Desktop view', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(preview.getByRole('tab', { name: 'Mobile view', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(preview.locator('iframe')).toHaveCSS('max-width', '390px')
    await page.screenshot({ path: testInfo.outputPath('18-home-mobile-preview.png') })
    await preview.getByRole('tab', { name: 'Desktop view', exact: true }).click()
    await expect(preview.getByRole('tab', { name: 'Desktop view', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.screenshot({ path: testInfo.outputPath('17-home-guest-preview.png') })
    await safety.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('19-home-guest-safety.png') })
  }

  // Publish only this disposable workspace to verify the same quote a real guest pays.
  if (!['localhost', '127.0.0.1'].includes(new URL(baseURL!).hostname)) return
  const hostless = await page.request.put(`${productUrl}/publication`, { data: { published: true } })
  expect(hostless.status(), await hostless.text()).toBe(409)
  await publishOwnHostProfile(page.request, baseURL!, created!.id, 'My first home host')
  await page.goto(`/dashboard/${created!.slug}/products/${listing.id}/publication`)
  await expect(page.getByRole('link', { name: /Host profile.*Profile published/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Publish listing/ })).toBeVisible()
  const published = await page.request.put(`${productUrl}/publication`, { data: { published: true } })
  expect(published.status(), await published.text()).toBe(200)
  await page.goto(`/dashboard/${created!.slug}`)
  const website = page.getByTestId('today-website')
  await website.getByRole('link', { name: 'Publish website' }).click()
  await page.getByRole('button', { name: 'Make public' }).click()
  await expect(website).toContainText('Live')
  const subdomain = (await context.json() as { organization: { subdomain: string } }).organization.subdomain
  const guestPage = await readLocalTenant(request, subdomain, `/stays/${listing.slug}`)
  expect(guestPage.status(), await guestPage.text()).toBe(200)
  expect(await guestPage.text()).toContain('The front door camera records the entry path.')
  const quote = `/api/public/products/${listing.slug}/quote`
  const dateInThailand = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }) + 'T00:00:00Z')
  const day = (offset: number) => new Date(dateInThailand.getTime() + offset * 86400000).toISOString().slice(0, 10)
  const lastMinute = [day(2), day(3)].reduce((total, date) => {
    const weekday = new Date(date + 'T00:00:00Z').getUTCDay()
    return total + (weekday === 5 || weekday === 6 ? 167400 : 139500)
  }, 0)
  for (const [nights, total] of [[2, lastMinute], [7, 999000], [28, 3552000]] as const) {
    const response = await readLocalTenant(request, subdomain, quote, { check_in_date: day(2), check_out_date: day(2 + nights), adults: 1 })
    expect(response.status(), await response.text()).toBe(200)
    expect(await response.json()).toMatchObject({ quote: { nights, total_minor: total } })
  }
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
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(step('language')).toBeVisible()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(step('business')).toBeVisible()
  await page.getByRole('button', { name: 'Import from Google Maps', exact: true }).click()

  // Predictions appear as the owner types; each names the place and its area.
  const autocomplete = page.waitForRequest(sent => sent.url().includes('/api/dashboard/google-places/autocomplete'))
  await page.getByPlaceholder('Search for your business on Google Maps').pressSequentially('Kikuzuki Krabi')
  const sessionToken = ((await autocomplete).postDataJSON() as { session_token: string }).session_token
  const suggestion = page.getByRole('option', { name: new RegExp(KIKUZUKI.name.replace(/[&]/g, '\\$&')) })
  await expect(suggestion).toContainText('Ao Nang')
  await expect(page.locator('[data-google-maps-attribution]')).toHaveText('Google Maps')

  // Selecting it closes the Google session with the same token.
  const details = page.waitForRequest(sent => sent.url().includes('/api/dashboard/google-places/details'))
  await suggestion.click()
  expect((await details).postDataJSON()).toEqual({ google_place_id: KIKUZUKI.placeId, session_token: sessionToken })

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
  await expect(page.getByLabel('Phone', { exact: true })).toHaveValue('095 293 2112')

  // The saved draft names the Google place, which the server fetched itself.
  const saved = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(saved.status(), await saved.text()).toBe(200)
  const draft = (await saved.json() as { draft: { source_type: string; google_place_id: string; details: { name: string; phone: string; timezone: string; currency: string; opening_hours: { periods: unknown[] } } } }).draft
  expect(draft).toMatchObject({ source_type: 'google_places', google_place_id: KIKUZUKI.placeId, details: { name: KIKUZUKI.name, phone: '+66952932112', timezone: 'Asia/Bangkok', currency: 'THB' } })
  expect(draft.details.opening_hours.periods.length).toBeGreaterThan(0)

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
    data: { source_type: 'manual', vertical: 'restaurant', name, details: { source_locale: 'en', currency: 'THB', timezone: 'Asia/Bangkok', country: 'TH', city: 'Ao Nang', street_address: '88 Moo 2' } },
  })
  expect(firstSave.status(), await firstSave.text()).toBe(200)
  const { organization_id: organizationId } = await firstSave.json() as { organization_id: string }

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
  const anonymous = await request.post('/api/dashboard/google-places/autocomplete', { data: { input: 'Kikuzuki', session_token: sessionToken } })
  expect(anonymous.status()).toBe(401)

  await loginAs(request, baseURL!, 'user-e2e-demo-owner')
  const short = await request.post('/api/dashboard/google-places/autocomplete', { data: { input: 'ki ', session_token: sessionToken } })
  expect(short.status(), await short.text()).toBe(400)
  const malformed = await request.post('/api/dashboard/google-places/autocomplete', { data: { input: 'Kikuzuki', session_token: 'not-a-uuid' } })
  expect(malformed.status(), await malformed.text()).toBe(400)
  const detailsMalformed = await request.post('/api/dashboard/google-places/details', { data: { google_place_id: KIKUZUKI.placeId, session_token: 'not-a-uuid' } })
  expect(detailsMalformed.status(), await detailsMalformed.text()).toBe(400)
})

// Ember & Slice is on Business with two locations. Locations are not billed:
// a third is made by the createLocation every surface shares, and the plan's
// usage reports homes only.
test('a paid plan adds a third location without counting it', async ({ page, baseURL }, testInfo) => {
  test.skip(Boolean(process.env.PLAYWRIGHT_PREVIEW_URL), 'This local fixture journey creates and deletes a location.')
  const restaurant = seededTenant('restaurant')
  const release = await acquireTenantMutationLock(testInfo, restaurant.organizationId)
  const failures: unknown[] = []
  let createdLocationId: string | undefined
  const status = async () => {
    const response = await page.request.get('/api/billing/status', { params: { organization_id: restaurant.organizationId } })
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as { billing: { plan: string; usage: Record<string, number> } }).billing
  }
  try {
    await loginAs(page.request, baseURL!, 'user-e2e-demo-owner')
    const before = await status()
    expect(before.plan).toBe('business')
    expect(before.usage).toEqual({ plan: 'business', homes: 0 })

    // The new location's own level walks its sections.
    await page.goto(`/dashboard/${restaurant.slug}/locations/new`)
    await expect(page).toHaveURL(new RegExp(`/dashboard/${restaurant.slug}/locations/new/name$`))

    const args = { organization_id: restaurant.organizationId, title: 'Third branch', timezone: 'America/New_York', idempotency_key: crypto.randomUUID() }
    const created = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'create_location', args })
    expect(created.status(), await created.text()).toBe(200)
    const receipt = mcpData<{ organization_id: string; location: { id: string; title: string; status: string } }>(await created.json())
    createdLocationId = receipt.location.id
    expect(Object.keys(receipt).sort()).toEqual(['location', 'organization_id'])
    expect(Object.keys(receipt.location).sort()).toEqual(['id', 'status', 'title'])
    expect(receipt.location).toEqual({ id: createdLocationId, title: args.title, status: 'active' })
    expect(receipt.organization_id).toBe(args.organization_id)
    const nativeRead = await page.request.get(`/api/dashboard/locations/${createdLocationId}?org=${restaurant.slug}`)
    expect(nativeRead.status(), await nativeRead.text()).toBe(200)
    const saved = await nativeRead.json()
    expect(saved.location).toMatchObject(receipt.location)
    expect(saved.location.timezone).toBe(args.timezone)
    expect((await status()).usage).toEqual(before.usage)

    const replay = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'create_location', args })
    expect(replay.status(), await replay.text()).toBe(200)
    expect(mcpData(await replay.json())).toEqual(receipt)
    const nativeReplayRead = await page.request.get(`/api/dashboard/locations/${createdLocationId}?org=${restaurant.slug}`)
    expect(nativeReplayRead.status(), await nativeReplayRead.text()).toBe(200)
    expect(await nativeReplayRead.json()).toEqual(saved)
    expect((await status()).usage).toEqual(before.usage)
  } catch (error) { failures.push(error) }
  finally {
    if (createdLocationId) {
      try {
        const deleted = await page.request.delete(`/api/organizations/${restaurant.organizationId}/locations/${createdLocationId}`)
        expect(deleted.status(), await deleted.text()).toBe(200)
        const absent = await page.request.get(`/api/dashboard/locations/${createdLocationId}?org=${restaurant.slug}`)
        expect(absent.status(), await absent.text()).toBe(404)
        expect((await status()).usage).toEqual({ plan: 'business', homes: 0 })
      } catch (error) { failures.push(error) }
    }
    try { await release() }
    catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Location creation or cleanup failed')
})

// Harbor Legal Aid has one office. Adding one walks the
// location record's own create level: Name, then Hours, then Create location,
// which opens the new location's first Photos section on a desktop.
test('a location is created by walking its own record', async ({ page, baseURL, playwright }) => {
  await dismissPreviewToolbar(page)
  await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
  const legal = seededTenant('legal')
  const org = legal.slug
  const cleanupRequest = await playwright.request.newContext({ baseURL, storageState: await page.request.storageState() })
  let createdLocationId: string | undefined
  try {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/dashboard/${org}/locations/new`)
    await expect(page).toHaveURL(new RegExp(`/dashboard/${org}/locations/new/name$`))
    await expect(page.getByRole('heading', { name: 'New location' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Name' }).fill('Raleigh Annex')
    await page.getByRole('button', { name: 'Next: Hours', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/dashboard/${org}/locations/new/hours/timezone$`))
    await page.getByRole('button', { name: 'Time zone', exact: true }).click()
    await page.getByPlaceholder('Search by city, e.g. Bangkok').fill('America/New_York')
    await page.getByRole('option').first().click()
    const creation = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/dashboard/locations')
    await page.getByRole('button', { name: 'Create location', exact: true }).click()
    const response = await creation
    expect(response.status(), await response.text()).toBe(201)
    const location = (await response.json() as { location: { id: string; slug: string } }).location
    createdLocationId = location.id
    expect(location.slug).toBe('raleigh-annex')
    await expect(page).toHaveURL(`/dashboard/${org}/locations/raleigh-annex/photos`)
    await expect(page.locator('#dashboard-panel-location-photos').getByRole('heading', { name: 'Media', exact: true, level: 1 })).toBeVisible()

    const created = await page.request.get(`/api/dashboard/locations?org=${org}`)
    expect(created.status(), await created.text()).toBe(200)
    const listed = ((await created.json()) as { locations: Array<{ id: string; slug: string }> }).locations
      .find(candidate => candidate.slug === 'raleigh-annex')
    expect(listed).toMatchObject({ id: createdLocationId, slug: 'raleigh-annex' })
    const read = await page.request.get(`/api/dashboard/locations/${listed!.id}`)
    expect(read.status(), await read.text()).toBe(200)
    expect(((await read.json()) as { location: { title: string; timezone: string } }).location)
      .toMatchObject({ title: 'Raleigh Annex', timezone: 'America/New_York' })
  } finally {
    try {
      if (createdLocationId) {
        const deleted = await cleanupRequest.delete(`/api/organizations/${legal.organizationId}/locations/${createdLocationId}`)
        expect(deleted.status(), await deleted.text()).toBe(200)
        const removed = await cleanupRequest.get(`/api/dashboard/locations/${createdLocationId}`)
        expect(removed.status(), await removed.text()).toBe(404)
      }
    } finally {
      await cleanupRequest.dispose()
    }
  }
})

// A location made by its own record has no place yet; Settings → Google Maps
// connects it through the business picker, and connects another the same way.
// Runs against the seeded Harbor Legal Aid tenant; the location is deactivated at the end.
test('Settings connects a new location to Google Maps through the business picker', async ({ page, baseURL }) => {
  test.skip(process.env.E2E_GOOGLE_PLACES !== 'true', 'Live Google Places qualification requires E2E_GOOGLE_PLACES=true')
  await dismissPreviewToolbar(page)
  await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
  const org = seededTenant('legal').slug
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
  const placeId = ((await picked).postDataJSON() as { google_place_id: string }).google_place_id
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
  const otherPlaceId = ((await repicked).postDataJSON() as { google_place_id: string }).google_place_id
  expect(otherPlaceId).not.toBe(placeId)
  expect((await synced).status()).toBe(200)
  await expect(page.getByText('Connected to Google Maps')).toBeVisible()
  expect((await connected()).find(location => location.id === added!.id)?.google_place_id).toBe(otherPlaceId)

  const deactivated = await page.request.patch(`/api/dashboard/locations/${added!.id}?org=${org}`, { data: { status: 'inactive' } })
  expect(deactivated.status(), await deactivated.text()).toBe(200)
})
