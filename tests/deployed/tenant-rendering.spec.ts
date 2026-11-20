import { expect, test, type Page } from '@playwright/test'
import { openTenantPage } from '../e2e/helpers'
import { blawbyBaseURL, blawbyExtraHeaders, kikuzukiBaseURL, kikuzukiExtraHeaders, potteryHouseBaseURL, potteryHouseExtraHeaders } from './real-tenants'

// One real customer site per vertical this renderer serves, all on .tenant-layout:
// Pottery House a venue, Kikuzuki a restaurant and NCLS a legal practice. A
// visitor reaches each detail page by clicking from home through its listing.
type Tenant = {
  name: string
  baseURL: string
  headers: Record<string, string>
  shell: string
  identity: RegExp
  definingContent: RegExp
  primaryLabel: RegExp
  listPath: string
  listHeading: RegExp
  detailPath: string
  detailContent: RegExp
  forbidden: RegExp[]
  // The shell's own theme token, asserted to survive hydration. Saya and
  // blawby name theirs differently.
  themeVar: string
}

const tenants: Tenant[] = [
  {
    name: 'Pottery House', baseURL: potteryHouseBaseURL, headers: potteryHouseExtraHeaders,
    shell: '.tenant-layout', identity: /Pottery House/i, definingContent: /pottery|wheel|clay/i,
    primaryLabel: /product|class|book/i, listPath: '/experiences', listHeading: /Pottery House Krabi Experiences/i,
    detailPath: '/experiences/pottery-wheel-class',
    detailContent: /Pottery Wheel Class/i, themeVar: '--ui-bg',
    forbidden: [/Come dine with us/i, /Reserve a table/i, /From the kitchen/i, /Also part of Saya/i],
  },
  {
    name: 'Kikuzuki', baseURL: kikuzukiBaseURL, headers: kikuzukiExtraHeaders,
    shell: '.tenant-layout', identity: /Kikuzuki Krabi Thailand/i, definingContent: /Kikuzuki/i,
    primaryLabel: /menu|reserv/i, listPath: '/menu', listHeading: /Kikuzuki Krabi Thailand/i,
    detailPath: '/locations/kikuzuki-japanese-robatayaki-izakaya/menu/tuna-sushi',
    detailContent: /Tuna Sushi/i, themeVar: '--ui-bg',
    forbidden: [/Pottery House/i, /No services/i],
  },
  {
    name: 'North Carolina Legal Services', baseURL: blawbyBaseURL, headers: blawbyExtraHeaders,
    shell: '.tenant-layout', identity: /North Carolina Legal Services/i,
    definingContent: /Access to Justice|affordable legal services/i,
    primaryLabel: /services|get started|consultation/i, listPath: '/services', listHeading: /Our Services/i,
    detailPath: '/services/family',
    detailContent: /Family Law|child custody|divorce/i, themeVar: '--ui-bg',
    forbidden: [/Ember & Slice/i, /No services/i],
  },
]

async function expectTenantDocument(page: Page, tenant: Tenant) {
  await expect(page.locator(tenant.shell)).toBeVisible()
  await expect(page.locator('header').getByRole('link', { name: tenant.identity }).first()).toBeVisible()
  await expect(page.locator('main')).toContainText(tenant.definingContent)
  await expect(page.locator('footer')).toBeVisible()
  await expect(page.locator('footer')).not.toBeEmpty()
  await expect(page.getByRole('link', { name: tenant.primaryLabel }).first()).toBeVisible()
  // Authored media has to arrive, not merely be referenced: a placement that
  // lost its asset still renders an <img> with a src that 404s.
  const media = page.locator([
    'img[src^="https://media.blawby.com/"]',
    'video[src^="https://media.blawby.com/"]',
    'img[src^="https://media.krabiclaw.com/"]',
    'video[src^="https://media.krabiclaw.com/"]',
    'img[src*="imagedelivery.net"]',
    'video[src*="imagedelivery.net"]',
  ].join(', ')).first()
  await expect(media).toBeVisible()
  for (const text of tenant.forbidden) await expect(page.locator('body')).not.toContainText(text)
  // A component handed a prop it never declared renders it onto the element as
  // block="[object Object]". The shield divider did exactly that for seven weeks
  // while every assertion here still passed, because nothing read the markup.
  expect(await page.content()).not.toContain('[object Object]')
  await page.waitForFunction(() => Boolean(
    (document.querySelector('#__nuxt') as (Element & { __vue_app__?: unknown }) | null)?.__vue_app__,
  ))
}

for (const tenant of tenants) {
  test(`${tenant.name} renders home and reaches its detail page by clicking on desktop`, async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const response = await openTenantPage(page, `${tenant.baseURL}/`, tenant.headers)
    expect(response?.status()).toBe(200)
    expect(new URL(page.url()).origin).toBe(new URL(tenant.baseURL).origin)
    await expectTenantDocument(page, tenant)
    await page.locator(`a[href="${tenant.listPath}"]`).first().click()
    await expect(page).toHaveURL(new RegExp(`${tenant.listPath}/?$`))
    const main = page.locator('main')
    await expect(main.getByRole('heading').first()).toHaveText(tenant.listHeading)
    await main.locator(`a[href^="${tenant.detailPath}"]`).first().click()
    await expect(page).toHaveURL(new RegExp(`${tenant.detailPath}/?(?:\\?.*)?$`))
    await expect(main).toContainText(tenant.detailContent)
    await expect(page.locator(tenant.shell)).toBeVisible()
    // The tenant's own theme tokens must survive hydration; losing them
    // repaints the detail page in the platform default mid-load.
    await expect(page.locator(tenant.shell)).not.toHaveCSS(tenant.themeVar, '')
    for (const text of tenant.forbidden) await expect(page.locator('body')).not.toContainText(text)

    if (tenant.name === 'Pottery House') {
      const shell = await request.get(`${tenant.baseURL}/api/public/shell`, { headers: tenant.headers })
      expect(shell.status(), await shell.text()).toBe(200)
      const socialImage = (await shell.json()).organization.social_image
      expect(socialImage).toMatchObject({ width: 1200, height: 630 })
      for (const path of ['/reviews', '/photos']) {
        const aggregate = await openTenantPage(page, `${tenant.baseURL}${path}`, tenant.headers)
        expect(aggregate?.status()).toBe(200)
        await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', socialImage.url)
        await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200')
        await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630')
      }
    }
  })
}
