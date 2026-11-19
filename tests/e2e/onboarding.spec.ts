import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { dismissPreviewToolbar } from './helpers'
import { loginAs } from './helpers/auth'
import { seededTenant } from './seed/manifest'
import { readLocalTenant } from './test-env'
import { formatMinorAmount } from '../../shared/prices'
import { LEGACY_PLATFORM_THEME_STORAGE_KEY, PLATFORM_THEME_STORAGE_KEY } from '../../shared/platform-theme'
import { starterPalette } from '../../shared/site-palette'
import { WEBSITE_ONBOARDING_EXIT_PATH } from '../../shared/onboarding-flow'
import type { Product } from '../../server/types/products'

// The manual-name path of the new-site flow, driven the way an owner drives it:
// the welcome screen, then one question per route, each advanced by the shell's
// own footer; activation committing a private site in a new organization;
// and a real tenant preview on Today.
// The owner then publishes from Today.
//
// Another tenant already holds an organization-wide collection with the slug
// this owner's menu section takes. A collection slug is unique within its
// organization, so the new site gets the same slug for its own section rather
// than failing to save it.
// Ember & Slice holds the organization-wide collection the new site's section shares a slug with.
const otherTenantId = () => seededTenant('restaurant').organizationId
let otherTenant: { owner: APIRequestContext; collectionId: string } | null = null

test.afterEach(async () => {
  if (!otherTenant) return
  const { owner, collectionId } = otherTenant
  otherTenant = null
  const removed = await owner.delete(`/api/editor/organizations/${otherTenantId()}/collections/${collectionId}`)
  expect(removed.status(), await removed.text()).toBe(200)
  await owner.dispose()
})

/** Publishes the website from its status card, as an owner does, and reads the status back. */
async function publishWebsite(page: Page, slug: string) {
  await page.goto(`/dashboard/${slug}/website`)
  await page.getByTestId('website-status-banner').click()
  await page.getByTestId('confirm-status-toggle').click()
  await expect(page.getByTestId('website-status-banner')).toContainText('Published')
}

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

  await expect(step('type')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Exit', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await expect(step('type').locator('[aria-pressed="true"]')).toHaveCount(0)
  await expect(step('type')).toContainText('Your business website')
  await page.getByRole('button', { name: 'Restaurant, café or bar' }).click()
  await expect(step('type')).toContainText('Kikuzuki')

  const exitSetup = async () => {
    await page.getByRole('button', { name: 'Save & exit', exact: true }).click()
    await expect(page).toHaveURL(`${baseURL}${WEBSITE_ONBOARDING_EXIT_PATH}`)
  }
  const continueSetup = async (next: string) => {
    const action = page.getByRole('link', { name: 'Continue website setup', exact: true })
    await expect(action).toHaveAttribute('href', /^\/dashboard\/onboarding(?:\?|$)/)
    await action.click()
    await expect(step(next)).toBeVisible()
  }
  await exitSetup()
  const typeDraft = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(typeDraft.status(), await typeDraft.text()).toBe(200)
  expect(await typeDraft.json()).toMatchObject({
    draft: { vertical: 'restaurant', organization_id: null, paused_step: 'type' },
    resume_action: { label: 'Continue website setup', to: '/dashboard/onboarding' },
  })
  const personal = await page.context().newPage()
  await personal.goto('/dashboard/account')
  await expect(personal.locator('#account-today').getByRole('link', { name: 'Continue website setup' })).toHaveCount(0)
  await personal.close()
  const signedInAgain = await page.request.get('/api/post-login', { maxRedirects: 0 })
  expect(signedInAgain.status()).toBe(302)
  expect(signedInAgain.headers().location).toBe(WEBSITE_ONBOARDING_EXIT_PATH)
  const personalMenu = '/dashboard/account/menu'
  await page.goto(personalMenu)
  await continueSetup('type')
  await expect(step('type').getByRole('button', { name: 'Restaurant, café or bar' })).toHaveAttribute('aria-pressed', 'true')
  await advance('Continue', 'business')
  await page.reload()
  await expect(step('type')).toBeVisible()
  await advance('Continue', 'business')
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click()
  await expect(page).toHaveURL(`${baseURL}${personalMenu}`)
  await page.goto(WEBSITE_ONBOARDING_EXIT_PATH)
  await continueSetup('business')

  const placesRequests: string[] = []
  page.on('request', (sent) => {
    if (sent.url().includes('/api/dashboard/google-places/')) placesRequests.push(sent.url())
  })
  await page.getByRole('textbox', { name: 'Business name' }).fill(name)
  await page.getByRole('button', { name: 'Import from Google Maps', exact: true }).click()
  await expect(page.getByPlaceholder('Search for your business', { exact: true })).toHaveValue(name)
  await page.getByRole('button', { name: 'Enter details manually', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Business name' })).toHaveValue(name)
  await exitSetup()
  await continueSetup('business')
  await expect(page.getByRole('textbox', { name: 'Business name' })).toHaveValue(name)
  await advance('Next', 'location')

  // A country is required, while the street and city can stay empty.
  const next = page.getByRole('button', { name: 'Next', exact: true })
  await expect(next).toBeDisabled()
  await step('location').getByRole('button', { name: 'Country', exact: true }).click()
  await page.getByPlaceholder('Search country...').fill('Thailand')
  await page.getByRole('option', { name: /Thailand/ }).click()
  await expect(step('location')).toContainText('🇹🇭')
  await expect(step('location')).toContainText('Bangkok · GMT+7')
  await step('location').getByRole('textbox', { name: 'City or town' }).fill('Ao Nang')
  await exitSetup()
  await continueSetup('location')
  await expect(step('location').getByRole('textbox', { name: 'City or town' })).toHaveValue('Ao Nang')
  await step('location').getByRole('textbox', { name: 'City or town' }).clear()
  await step('location').getByRole('button', { name: 'Country', exact: true }).click()
  await page.getByPlaceholder('Search country...').fill('United States')
  await page.getByRole('option', { name: 'United States', exact: true }).click()
  await advance('Next', 'timezone')
  await expect(next).toBeDisabled()
  await page.getByRole('button', { name: 'Time zone', exact: true }).click()
  await page.getByPlaceholder('Search by city, e.g. Bangkok').fill('Los Angeles')
  await page.getByRole('option', { name: /Los Angeles/ }).click()
  await advance('Next', 'language')
  await advance('Back', 'timezone')
  await expect(step('timezone')).toContainText('Los Angeles')
  await advance('Next', 'language')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await advance('Next', 'currency')
  await expect(step('currency')).toContainText('US Dollar (USD)')
  await step('currency').getByRole('button', { name: /Pricing currency/ }).click()
  await page.getByRole('option', { name: 'Thai Baht (THB)', exact: true }).click()
  await expect(step('currency')).toContainText('Thai Baht (THB)')
  await expect(page.locator('iframe[title="Site preview"]')).toHaveCount(0)

  await exitSetup()
  const saved = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(saved.status(), await saved.text()).toBe(200)
  const initialDraft = (await saved.json() as { draft: { draft_id: string; organization_id: string; updated_at: string; subdomain_candidate: string } }).draft
  const subdomain = initialDraft.subdomain_candidate
  expect(initialDraft).toMatchObject({
    source_type: 'manual', google_place_id: null,
    details: { name, currency: 'THB', timezone: 'America/Los_Angeles', country: 'US', street_address: null },
  })
  const nativeWorkspaces = await page.request.get('/api/account/organizations?onboarding_status=active')
  expect(nativeWorkspaces.status()).toBe(200)
  expect((await nativeWorkspaces.json()).organizations).not.toContainEqual(expect.objectContaining({ id: initialDraft.organization_id }))
  const draftDestination = await page.request.get('/api/post-login?format=json')
  expect(draftDestination.status()).toBe(200)
  expect(await draftDestination.json()).toEqual({ destination: WEBSITE_ONBOARDING_EXIT_PATH })
  const webDraftDestination = await page.request.get('/api/post-login', { maxRedirects: 0 })
  expect(webDraftDestination.status()).toBe(302)
  expect(webDraftDestination.headers().location).toBe(WEBSITE_ONBOARDING_EXIT_PATH)
  const anonymousPreview = await readLocalTenant(request, subdomain, '/')
  expect(anonymousPreview.status()).toBe(404)

  await page.goto('/dashboard/onboarding')
  await expect(step('currency')).toBeVisible()
  const competingSave = await page.request.post('/api/dashboard/onboarding/drafts/active', {
    data: {
      draft_id: initialDraft.draft_id, updated_at: initialDraft.updated_at, details: { phone: '+66821234567' },
      brand_draft: { palette_starter: 'forest', font_preset: 'lora', hero_headline: 'Fresh from the Andaman, every morning' },
      products: [{ name: 'Grilled squid', category: 'Small plates', unit_amount: 18000 }],
    },
  })
  expect(competingSave.status(), await competingSave.text()).toBe(200)
  const competingRevision = (await competingSave.json() as { updated_at: string }).updated_at
  const failedExitResponse = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/dashboard/onboarding/drafts/active')
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click()
  const failedExit = await failedExitResponse
  expect(failedExit.status(), await failedExit.text()).toBe(409)
  await expect(page.getByText('Website draft changed; read it before saving', { exact: true })).toBeVisible()
  await expect(step('currency')).toBeVisible()
  const newerDraft = await page.request.get('/api/dashboard/onboarding/drafts/active')
  expect(newerDraft.status(), await newerDraft.text()).toBe(200)
  expect((await newerDraft.json() as { draft: unknown }).draft).toMatchObject({
    draft_id: initialDraft.draft_id, organization_id: initialDraft.organization_id, updated_at: competingRevision,
    details: { name, phone: '+66821234567', currency: 'THB', timezone: 'America/Los_Angeles' },
  })

  await page.reload()
  await expect(step('currency')).toBeVisible()
  await page.getByRole('button', { name: 'Finish', exact: true }).click()
  await expect(page).not.toHaveURL(/\/dashboard\/onboarding/)

  const session = await (await page.request.get('/api/auth/get-session')).json() as { session: { activeOrganizationId: string | null } }
  const organizationId = session.session.activeOrganizationId
  expect(organizationId).toBe(initialDraft.organization_id)
  const organizations = await (await page.request.get('/api/auth/organization/list')).json() as Array<{ id: string; name: string; slug: string; metadata: unknown }>
  const created = organizations.find(organization => organization.id === organizationId)
  expect(created?.name).toBe(name)
  const metadata = typeof created?.metadata === 'string' ? JSON.parse(created.metadata) : created?.metadata
  expect(metadata).toMatchObject({ __blawby_organization_creation_marker: initialDraft.draft_id })
  const activatedWorkspaces = await page.request.get('/api/account/organizations?onboarding_status=active')
  expect(activatedWorkspaces.status()).toBe(200)
  expect((await activatedWorkspaces.json()).organizations).toContainEqual(expect.objectContaining({ id: organizationId, name }))

  await expect(page).toHaveURL(new RegExp(`/dashboard/${created!.slug}$`))
  const postLogin = await page.request.get('/api/post-login', { maxRedirects: 0 })
  expect(postLogin.status()).toBe(302)
  expect(postLogin.headers().location).toBe(`/dashboard/${created!.slug}`)

  const context = await (await page.request.get('/api/dashboard/context', { params: { org: created!.slug } })).json() as { organization: { subdomain: string | null } }
  expect(context.organization.subdomain).toBe(subdomain)

  // A new business has nothing booked and cannot take payment yet: Today is its setup, and the site stays private until it is published.
  await expect(page.getByTestId('today-title')).toHaveText('Finish setting up to take bookings')
  const payments = page.locator(`[data-item-id="payments.connect:${organizationId}"]`)
  await expect(payments).toContainText('Set up payments')
  await expect(payments.getByRole('link').first()).toHaveAttribute('href', /\/payments\/payout-method$/)
  const stillPrivate = await readLocalTenant(request, subdomain, '/')
  expect(stillPrivate.status()).toBe(404)
  expect(await stillPrivate.text()).not.toContain(name)
  // The domain page offers the plan that includes a custom domain.
  await page.goto(`/dashboard/${created!.slug}/website/preferences/domains`)
  await expect(page.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', /\/billing\/upgrade\?plan=growth$/)
  await expect(page.getByRole('button', { name: 'Connect domain' })).toHaveCount(0)
  await expect(page.getByText('Private', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'View plans' }).click()
  await expect(page.getByRole('radio', { name: /^Growth/ })).toBeChecked()
  await publishWebsite(page, created!.slug)
  const publicAddress = new URL(baseURL!)
  publicAddress.hostname = subdomain + '.' + publicAddress.hostname
  const draftDishName = 'Preview-only tamarind prawns'
  const catalogUrl = `/api/editor/organizations/${organizationId}`
  const locations = await page.request.get(`/api/dashboard/locations?org=${created!.slug}`)
  expect(locations.status(), await locations.text()).toBe(200)
  const { locations: [{ id: locationId }] } = await locations.json() as { locations: [{ id: string }] }
  const draftDish = await page.request.post(`${catalogUrl}/products`, { data: {
    kind: 'dish', name: draftDishName, variants: [{ name: 'Standard', prices: [{ unit_amount: 20000, currency: 'THB' }] }],
  } })
  expect(draftDish.status(), await draftDish.text()).toBe(201)
  const { product: { id: dishId } } = await draftDish.json() as { product: Product }
  const placement = await page.request.put(`${catalogUrl}/products/${dishId}/locations/${locationId}`, { data: { active: true, published: false } })
  expect(placement.status(), await placement.text()).toBe(200)
  // The public menu shows what is published and not the unpublished dish.
  const publicPage = await browser.newPage({ colorScheme: 'light' })
  await publicPage.addInitScript(key => localStorage.setItem(key, 'dark'), LEGACY_PLATFORM_THEME_STORAGE_KEY)
  await publicPage.goto(new URL('/menu', publicAddress).href)
  await expect(publicPage.locator('html')).toHaveClass(/(?:^|\s)dark(?:\s|$)/u)
  await expect.poll(() => publicPage.evaluate(key => localStorage.getItem(key), PLATFORM_THEME_STORAGE_KEY)).toBe('dark')
  expect(await publicPage.evaluate(key => localStorage.getItem(key), LEGACY_PLATFORM_THEME_STORAGE_KEY)).toBeNull()
  await expect(publicPage.getByText('Grilled squid', { exact: true })).toBeVisible()
  await expect(publicPage.getByText(draftDishName, { exact: true })).toHaveCount(0)
  await publicPage.close()
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
  const menuResponse = await menu.goto(new URL('/menu', baseURL!.replace('localhost', `${subdomain}.localhost`)).href)
  expect(menuResponse?.status()).toBe(200)
  const section = menu.locator('section').filter({ has: menu.getByRole('heading', { level: 2, name: 'Small plates', exact: true }) })
  await expect(section).toHaveCount(1)
  await expect(section).toContainText('Grilled squid')
  await expect(section).toContainText(formatMinorAmount(18000, 'THB'))
  await visitor.close()
  expect(placesRequests).toEqual([])
})
