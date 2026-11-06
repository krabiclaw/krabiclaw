import { testBaseUrl } from '../e2e/test-env'
import { expect, test, type Page } from '@playwright/test'
import { openTenantPage } from '../e2e/helpers'
import { strutBaseURL, blawbyBaseURL, blawbyExtraHeaders, kikuzukiBaseURL, kikuzukiExtraHeaders, potteryHouseBaseURL, potteryHouseExtraHeaders } from './real-tenants'

async function clientJourney(page: Page, options: {
  baseURL: string
  headers: Record<string, string>
  listPath: string
  listHeading: RegExp
  detailPath: string
  detailText: RegExp
}) {
  await openTenantPage(page, `${options.baseURL}/`, options.headers)
  await expect(page.locator('[data-hydrated]')).toHaveAttribute('data-hydrated', 'true')
  await page.locator(`a[href="${options.listPath}"]`).first().click()
  await expect(page).toHaveURL(new RegExp(`${options.listPath}/?$`))
  const main = page.locator('main')
  await expect(main.getByRole('heading').first()).toHaveText(options.listHeading)
  await main.locator(`a[href^="${options.detailPath}"]`).first().click()
  await expect(page).toHaveURL(new RegExp(`${options.detailPath}/?(?:\\?.*)?$`))
  await expect(main).toContainText(options.detailText)
}

test('Pottery home → experiences → experience detail', async ({ page }) => {
  await clientJourney(page, {
    baseURL: potteryHouseBaseURL, headers: potteryHouseExtraHeaders,
    listPath: '/experiences', listHeading: /Pottery House Krabi Experiences/i,
    detailPath: '/experiences/pottery-wheel-class', detailText: /Pottery Wheel Class/i,
  })
})

test('Kikuzuki home → menu → menu item and location preview interactions', async ({ page, request }) => {
  test.setTimeout(90_000)
  const baseURL = kikuzukiBaseURL
  const headers = kikuzukiExtraHeaders
  await clientJourney(page, {
    baseURL, headers,
    listPath: '/menu', listHeading: /Kikuzuki Krabi Thailand/i,
    detailPath: '/locations/kikuzuki-japanese-robatayaki-izakaya/menu/tuna-sushi', detailText: /Tuna Sushi/i,
  })

  const shellRead = await request.get(`${baseURL}/api/public/shell`, { headers })
  const shellBody = await shellRead.text()
  expect(shellRead.status(), shellBody).toBe(200)
  const shell = JSON.parse(shellBody) as {
    locations: Array<{ id: string; slug: string }>
  }
  expect(shell.locations.find(location => location.slug === 'kikuzuki-japanese-robatayaki-izakaya')).toMatchObject({
    id: 'loc-kikuzuki',
  })
  expect(shell.locations.find(location => location.slug === 'take-me-away-by-kikuzuki')).toMatchObject({
    id: 'loc-kikuzuki-tkma',
  })

  for (const path of ['/locations', '/locations/kikuzuki-japanese-robatayaki-izakaya', '/reservations']) {
    expect((await openTenantPage(page, `${baseURL}${path}`, headers))?.status(), path).toBe(200)
    const preview = page.locator('main video').first()
    await preview.scrollIntoViewIfNeeded()
    await expect(preview).toHaveAttribute('poster', /\S/)
    await expect.poll(() => preview.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false)
    await expect.poll(() => preview.evaluate(element => {
      const video = element as HTMLVideoElement
      return video.currentTime > 0 && !video.paused ? 'playing' : {
        src: video.currentSrc, time: video.currentTime, paused: video.paused,
        readyState: video.readyState, networkState: video.networkState, error: video.error?.message ?? null,
      }
    }), { message: `${path} must advance its selected preview` }).toBe('playing')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => preview.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect.poll(() => preview.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false)
    if (path === '/reservations') {
      const reservationButton = preview.locator('xpath=ancestor::article[1]').getByRole('button', { name: 'Request Reservation', exact: true })
      await reservationButton.scrollIntoViewIfNeeded()
      await expect(preview).toBeInViewport()
      await expect.poll(() => preview.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false)
      await reservationButton.click()
      await expect(page.getByRole('dialog')).toBeVisible()
    } else await page.locator('footer').scrollIntoViewIfNeeded()
    await expect.poll(() => preview.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true)
  }
})

test('NCLS home → services → service detail', async ({ page }) => {
  await clientJourney(page, {
    baseURL: blawbyBaseURL, headers: blawbyExtraHeaders,
    listPath: '/services', listHeading: /Our Services/i,
    detailPath: '/services/family', detailText: /Family Law/i,
  })
})

for (const [name, baseURL] of [['Strut', strutBaseURL], ['NCLS', blawbyBaseURL]]) {
  test(`${name} home → blog → article uses the shared navigation`, async ({ page }) => {
    test.skip(name === 'Strut' && new URL(testBaseUrl()).hostname !== 'krabiclaw.com', 'Strut is a production-only tenant; staging has no Strut organization.')
    expect((await openTenantPage(page, `${baseURL}/`, {}))?.status()).toBe(200)
    const consent = page.locator('.consent-notice')
    if (await consent.isVisible()) {
      await consent.getByRole('button', { name: 'Reject', exact: true }).click()
      await expect(consent).toBeHidden()
    }
    await expect(page.locator('footer a[href="/blog"]')).toHaveCount(1)
    const headerLink = page.locator('header nav').first().getByRole('link', { name: 'Blog', exact: true })
    await expect(headerLink).toBeVisible()
    await headerLink.click()
    await expect(page).toHaveURL(/\/blog$/)
    const article = page.locator('main article h2 a[href^="/blog/"]').first()
    await expect(article).toBeVisible()
    const title = await article.innerText()
    await article.click()
    await expect(page.locator('main h1')).toHaveText(title)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('header').getByLabel('Toggle navigation', { exact: true }).click()
    const mobileLink = page.locator('header details nav').last().getByRole('link', { name: 'Blog', exact: true })
    await expect(mobileLink).toBeVisible()
    await mobileLink.click()
    await expect(page).toHaveURL(/\/blog$/)
    await expect(page.locator('main')).toContainText(title)
  })
}
