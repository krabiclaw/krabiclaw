import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test'
import { openTenantPage, waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'
import { mcpRequest } from './helpers/mcp'
import { E2E_KIKUZUKI_ORGANIZATION_ID, kikuzukiTestBaseUrl, kikuzukiTestExtraHeaders, testBaseUrl } from './test-env'

const organizationId = E2E_KIKUZUKI_ORGANIZATION_ID
const locale = 'th'

async function expectStatus(response: APIResponse, expected: number) {
  const body = response.status() === expected ? '' : await response.text()
  expect(response.status(), body).toBe(expected)
}

async function putLocalization(
  request: APIRequestContext,
  resourceType: string,
  resourceId: string,
  body: Record<string, unknown>,
) {
  await expectStatus(await request.put(
    `/api/editor/organizations/${organizationId}/localization/${resourceType}/${resourceId}/${locale}`,
    { data: body },
  ), 200)
}

async function expectLocalizedMenu(page: Page) {
  await expect(page.locator('[data-hydrated]')).toHaveAttribute('data-hydrated', 'true')
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await expect(page.getByRole('navigation', { name: 'การนำทางหลัก' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'การนำทางหลัก' }).getByRole('link', { name: 'เมนู', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'จองโต๊ะ' }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Kikuzuki กระบี่ ประเทศไทย' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Kikuzuki โรบาตายากิและอิซากายะญี่ปุ่น · ซูชิ', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'ซูชิทูน่า' }).first()).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'ภาษา', exact: true })).toHaveValue('th')
  await expect(page.locator('body')).not.toContainText('Tuna Sushi')
}

test.beforeAll(async ({ playwright }, testInfo) => {
  testInfo.setTimeout(120_000)
  const baseURL = testBaseUrl()
  const owner = await playwright.request.newContext({ baseURL })
  await loginAs(owner, baseURL)

  try {
    await expectStatus(await owner.post(`/api/editor/organizations/${organizationId}/locales/${locale}/add`), 200)

    await putLocalization(owner, 'organization', organizationId, {
      values: {
        name: 'Kikuzuki กระบี่ ประเทศไทย',
        brand_description: 'อาหารญี่ปุ่นต้นตำรับในกระบี่',
      },
    })
    const locationResponse = await owner.get(`/api/organizations/${organizationId}/locations/loc-kikuzuki`)
    await expectStatus(locationResponse, 200)
    expect(await locationResponse.json()).toMatchObject({
      location: {
        opening_hours: {
          periods: expect.arrayContaining([2, 3].map(day => ({
            open: { day, hour: 14, minute: 0 }, close: { day, hour: 23, minute: 0 },
          }))),
        },
      },
    })
    await putLocalization(owner, 'business_location', 'loc-kikuzuki', {
      route_path: '/th/locations/kikuzuki-japanese-robatayaki-izakaya',
      values: {
        title: 'Kikuzuki โรบาตายากิและอิซากายะญี่ปุ่น',
        address: { addressLines: ['325'], sublocality: 'ตำบลอ่าวนาง', locality: 'กระบี่' },
        description: 'ร้านอาหารญี่ปุ่นใจกลางกระบี่',
        short_description: 'โรบาตายากิและซูชิในอ่าวนาง',
      },
    })
    // Menu sections are collections now; their names localize on the
    // collection. The id is read from the site rather than written here — a
    // tenant's own ids are its business, not a constant in a test.
    const collectionsResponse = await owner.get(`/api/editor/organizations/${organizationId}/collections?location_id=loc-kikuzuki`)
    await expectStatus(collectionsResponse, 200)
    const { collections } = await collectionsResponse.json() as { collections: Array<{ id: string; slug: string }> }
    const sushi = collections.find(collection => collection.slug === 'sushi')
    expect(sushi, 'Kikuzuki has a sushi collection to translate').toBeTruthy()
    await putLocalization(owner, 'collection', sushi!.id, {
      values: { name: 'ซูชิ' },
    })
    await putLocalization(owner, 'product', 'item-kiku-tuna-sushi', {
      values: {
        name: 'ซูชิทูน่า',
        description: 'ทูน่า',
      },
    })
  } finally {
    await owner.dispose()
  }
})

test('a localization batch with a missing product leaves existing translations unchanged', async ({ request, baseURL }) => {
  await loginAs(request, baseURL!)
  const path = `/api/editor/organizations/${organizationId}/localization/product/item-kiku-tuna-sushi/${locale}`
  const before = await request.get(path)
  expect(before.status()).toBe(200)
  const existing = await before.json()
  const replace = await mcpRequest(request, baseURL!, {
    method: 'tools/call', toolName: 'replace_resource_localizations',
    args: {
      organization_id: organizationId, resource_type: 'product', locale,
      items: [
        { resource_id: 'item-kiku-tuna-sushi', values: { name: 'Must not be written' } },
        { resource_id: 'missing-localization-product', values: { name: 'Missing' } },
      ],
    },
  })
  expect(replace.status()).toBe(200)
  const rejected = await replace.json()
  expect(rejected.result.isError).toBe(true)
  expect(rejected.result.content[0].text).toContain('One or more canonical resources were not found')
  const after = await request.get(path)
  expect(after.status()).toBe(200)
  expect(await after.json()).toEqual(existing)
})

test('Kikuzuki keeps its Thai shell and collection translations on a hard load', async ({ page }) => {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const response = await openTenantPage(page, `${kikuzukiTestBaseUrl()}/th/menu`, kikuzukiTestExtraHeaders())
  expect(response?.status()).toBe(200)
  await expectLocalizedMenu(page)
  await page.reload()
  await expectLocalizedMenu(page)

  await page.getByRole('combobox', { name: 'ภาษา', exact: true }).selectOption('en')
  await expect(page).toHaveURL(`${kikuzukiTestBaseUrl()}/menu`)
  await expect(page.locator('[data-hydrated]')).toHaveAttribute('data-hydrated', 'true')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Tuna Sushi' }).first()).toBeVisible()

  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('th')
  await expect(page).toHaveURL(`${kikuzukiTestBaseUrl()}/th/menu`)
  await expectLocalizedMenu(page)

  const contactResponse = await openTenantPage(page, `${kikuzukiTestBaseUrl()}/th/contact`, kikuzukiTestExtraHeaders())
  expect(contactResponse?.status()).toBe(200)
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await expect(page.getByText('ติดต่อเรา', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'ภาษา', exact: true })).toHaveValue('th')
  expect(errors.filter(message => message.includes('Localized route representation was not found'))).toEqual([])

  const locationPageResponse = await openTenantPage(
    page,
    `${kikuzukiTestBaseUrl()}/th/locations/kikuzuki-japanese-robatayaki-izakaya`,
    kikuzukiTestExtraHeaders(),
  )
  expect(locationPageResponse?.status()).toBe(200)
  for (const day of ['วันอังคาร', 'วันพุธ']) {
    const hoursRow = page.getByText(day, { exact: true }).locator('..')
    await expect(hoursRow).toContainText('14:00')
    await expect(hoursRow).toContainText('23:00')
  }

  for (const path of ['/th/reservations', '/th/menu']) {
    const builtInResponse = await openTenantPage(page, `${kikuzukiTestBaseUrl()}${path}`, kikuzukiTestExtraHeaders())
    expect(builtInResponse?.status()).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await expect(page.getByRole('navigation', { name: 'การนำทางหลัก' }).getByRole('link', { name: 'เมนู', exact: true })).toBeVisible()
  }
})


// Brand's Translations row is a link to the Brand's translations mode, and the
// mode reads the organization's own localization, the type the registry knows.
test('Kikuzuki Brand translations open from their URL in the stored language', async ({ browser, playwright }) => {
  const baseURL = testBaseUrl()
  const owner = await playwright.request.newContext({ baseURL })
  try {
    await loginAs(owner, baseURL)
    const dashboardContext = await browser.newContext({ baseURL, storageState: await owner.storageState() })
    const cms = await dashboardContext.newPage()
    try {
      const brandPath = `/dashboard/${organizationId}/website/brand`
      await openTenantPage(cms, `${baseURL}${brandPath}`, {})
      await expect(cms.locator('#dashboard-panel-organization-brand').getByRole('link', { name: /^Translations/ })).toHaveAttribute('href', `${brandPath}?editMode=translations`)
      const loaded = cms.waitForResponse(response => response.request().method() === 'GET'
        && new URL(response.url()).pathname === `/api/editor/organizations/${organizationId}/localization/organization/${organizationId}/${locale}`)
      // A plain load: openTenantPage dismisses whatever dialog is open, which here is the mode under test.
      await cms.goto(`${baseURL}${brandPath}?editMode=translations&locale=${locale}`)
      await waitForNuxtHydration(cms)
      expect((await loaded).status()).toBe(200)
      await expect(cms.getByTestId('localize-field-name')).toHaveValue('Kikuzuki กระบี่ ประเทศไทย')
      await expect(cms.getByTestId('localize-field-brand_description')).toHaveValue('อาหารญี่ปุ่นต้นตำรับในกระบี่')
    } finally {
      await cms.close()
      await dashboardContext.close()
    }
  } finally {
    await owner.dispose()
  }
})

test('Kikuzuki Localize preserves its translated address', async ({ browser, playwright }) => {
  const baseURL = testBaseUrl()
  const owner = await playwright.request.newContext({ baseURL })
  try {
    await loginAs(owner, baseURL)
    const dashboardContext = await browser.newContext({ baseURL, storageState: await owner.storageState() })
    const cms = await dashboardContext.newPage()
    try {
      // Languages is a row on the location's settings list; it opens the
      // location's translations mode, which its URL holds with the language.
      const settingsPath = `/dashboard/${organizationId}/locations/kikuzuki-japanese-robatayaki-izakaya/settings`
      await openTenantPage(cms, `${baseURL}${settingsPath}`, {})
      await cms.getByRole('link', { name: /^Languages/ }).click()
      await expect(cms).toHaveURL(`${baseURL}${settingsPath}?editMode=translations`)
      await cms.getByTestId('localize-language').click()
      await cms.getByRole('option', { name: /ไทย \(th\)/ }).click()
      await expect(cms).toHaveURL(`${baseURL}${settingsPath}?editMode=translations&locale=th`)
      // A reload reconstructs the same record, mode and language from the URL.
      await cms.reload()
      await expect(cms.getByTestId('localize-language')).toContainText('ไทย (th)')
      await expect(cms.getByTestId('localize-field-address.addressLines')).toHaveValue('325')
      await expect(cms.getByTestId('localize-field-address.sublocality')).toHaveValue('ตำบลอ่าวนาง')
      const saveResponse = await Promise.all([
        cms.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/localization/business_location/loc-kikuzuki/th')),
        cms.getByTestId('localize-save').click(),
      ]).then(([response]) => response)
      expect(saveResponse.status()).toBe(200)
      const payload = saveResponse.request().postDataJSON() as { values: { address: unknown } }
      expect(payload.values.address).toEqual({ addressLines: ['325'], sublocality: 'ตำบลอ่าวนาง', locality: 'กระบี่' })
      // Saving leaves the mode, so the URL no longer reopens it.
      await expect(cms).not.toHaveURL(/editMode=/)
      await expect(cms.getByTestId('localize-language')).toHaveCount(0)
    } finally {
      await cms.close()
      await dashboardContext.close()
    }
  } finally {
    await owner.dispose()
  }
})
