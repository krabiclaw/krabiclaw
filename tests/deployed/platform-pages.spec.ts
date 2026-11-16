import { expect, test } from '@playwright/test'
import { openTenantPage, waitForNuxtHydration } from '../e2e/helpers'
import { testBaseUrl } from '../e2e/test-env'
import mcpCatalog from '../../server/utils/mcp-catalog-snapshots/tenant.json' with { type: 'json' }

// KrabiClaw's own pages are authored on production; the platform project runs
// these there only.

test('KrabiClaw pricing retains its billing plans after hydration', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addInitScript(() => localStorage.setItem('krabiclaw-theme', 'light'))
  const baseURL = testBaseUrl()
  const response = await openTenantPage(page, `${baseURL}/pricing`, {})
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByRole('heading', { name: 'Basic', exact: true })).toBeVisible()
  const billing = await page.request.get(`${baseURL}/api/billing/plans`)
  expect(billing.status()).toBe(200)
  const plans = await billing.json() as Array<{ id: string; name: string }>
  const paid = plans.find(plan => plan.id === 'growth')
  expect(paid).toBeDefined()
  await expect(page.getByRole('heading', { name: paid!.name, exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Get Growth', exact: true })).toHaveAttribute('href', '/signup?plan=growth&redirect=%2Fapi%2Fpost-login%3Fplan%3Dgrowth')
})

// The docs renderer at a phone width: overflow and table scrolling fail there first.
{
  const width = 390
  test(`KrabiClaw MCP reference has usable anchors and contained tables at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const baseURL = testBaseUrl()
    const response = await openTenantPage(page, `${baseURL}/docs/mcp-tool-reference`, {})
    expect(response?.status()).toBe(200)
    await waitForNuxtHydration(page)
    const article = page.locator('article.blog-article')
    await expect(article.getByRole('heading', { name: 'MCP tool reference', exact: true, level: 1 })).toBeVisible()
    // The catalog guard checks this canonical snapshot against the registry.
    await expect(article).toContainText(`Tools: ${mcpCatalog.tools.length}.`)
    await expect(article).toContainText(`Reference fingerprint: ${mcpCatalog.documentationFingerprint}`)
    const toolNames = mcpCatalog.tools.map(tool => tool.name).sort()
    expect((await article.locator('h3 code').allTextContents()).sort()).toEqual(toolNames)
    const anchorFailures = await article.evaluate((element, names) => {
      const ids = [...element.querySelectorAll('[id]')].map(target => target.id)
      const failures = names.filter(name => ids.filter(id => id === name).length !== 1)
      for (const link of element.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
        const id = decodeURIComponent(link.hash.slice(1))
        if (!id || !element.contains(document.getElementById(id))) failures.push(link.getAttribute('href')!)
      }
      return failures
    }, toolNames)
    expect(anchorFailures, 'Every tool and nested-shape link must resolve inside the rendered article').toEqual([])
    expect(await page.evaluate(() => window.innerWidth)).toBe(width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const tables = article.locator('table')
    expect(await tables.count()).toBeGreaterThan(0)
    const tableFailures = await tables.evaluateAll(elements => elements.flatMap((table, index) => {
      const bounds = table.getBoundingClientRect()
      const failures: string[] = []
      if (Math.floor(bounds.left) < 0 || Math.ceil(bounds.right) > window.innerWidth) failures.push(`table ${index} escapes the viewport`)
      for (const cell of table.querySelectorAll('th, td:first-child code')) {
        const text = document.createRange()
        text.selectNodeContents(cell)
        if (text.getClientRects().length !== 1) failures.push(`table ${index} wraps identifier/header: ${cell.textContent}`)
      }
      for (const code of table.querySelectorAll('code')) {
        if (getComputedStyle(code, '::before').content !== 'none' || getComputedStyle(code, '::after').content !== 'none') {
          failures.push(`table ${index} adds decorative code characters`)
        }
      }
      return failures
    }))
    expect(tableFailures).toEqual([])
    const horizontalScroll = await tables.evaluateAll(elements => {
      const table = elements.find(element => element.scrollWidth > element.clientWidth)
      if (!table) return null
      table.scrollLeft = table.scrollWidth
      const result = { tableMoved: table.scrollLeft > 0, pageLeft: window.scrollX }
      table.scrollLeft = 0
      return result
    })
    expect(horizontalScroll, 'Narrow tables must remain independently scrollable').not.toBeNull()
    expect(horizontalScroll).toEqual({ tableMoved: true, pageLeft: 0 })
    for (const name of [toolNames[0]!, toolNames.at(-1)!]) {
      await article.locator(`a[href="#${name}"]`).first().click()
      expect(new URL(page.url()).hash).toBe(`#${name}`)
      const heading = article.locator('h3').filter({ hasText: new RegExp(` — ${name}$`) })
      await expect(heading).toBeVisible()
      const headerBottom = await page.locator('header').first().evaluate(element => Math.ceil(element.getBoundingClientRect().bottom))
      await expect.poll(() => heading.evaluate(element => Math.floor(element.getBoundingClientRect().top)), 'Tool anchors must land below the sticky site header').toBeGreaterThanOrEqual(headerBottom)
    }
  })

  test(`KrabiClaw policies render their own headers and body at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    for (const policy of [
      { path: '/policies/privacy', title: 'Privacy Policy', body: 'This Privacy Policy explains how we collect, use, disclose, retain, and protect Personal Data' },
      { path: '/policies/terms', title: 'Terms of Service', body: 'A contract for the sale or provision of a merchant\'s products or services is directly between the merchant and its customer.' },
    ]) {
      const response = await openTenantPage(page, `${testBaseUrl()}${policy.path}`, {})
      expect(response?.status()).toBe(200)
      await waitForNuxtHydration(page)
      await expect(page.getByRole('heading', { name: policy.title, exact: true, level: 1 })).toBeVisible()
      await expect(page.locator('main')).toContainText(policy.body)
      await expect(page.locator('.kc-parallax-hero')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth), policy.path).toBeLessThanOrEqual(width)
    }
    expect(errors).toEqual([])
  })
}

test('KrabiClaw social viewer keyboard navigation changes the visible media', async ({ page }) => {
  const response = await openTenantPage(page, `${testBaseUrl()}/`, {})
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
  const cards = page.locator('[data-social-posts=block] [data-social-post]')
  const mark = /^Posted on (Facebook|Instagram)$/
  // A website-only post carries no channel mark; the newest post may be one
  // (production, 2026-10-06). The first card published to a channel carries
  // its account name in an unlinked mark, not the channel's own name.
  const firstCard = cards.first()
  const socialCard = cards.filter({ has: page.getByLabel(mark) }).first()
  // A post published to both channels carries both marks, each with its account name.
  const channelMarks = socialCard.getByLabel(mark)
  await expect(channelMarks.first()).toBeVisible()
  for (const channelMark of await channelMarks.all()) await expect(channelMark).toHaveText(/\S/)
  await expect(socialCard.locator('time, a')).toHaveCount(0)
  await expect(firstCard.locator('time, a')).toHaveCount(0)
  // Select the first card through the carousel.
  await page.locator('[data-social-posts=block]').getByRole('tab', { name: 'Go to slide 1', exact: true }).click()
  // The viewer opens on the card that was clicked; the first card puts the first picture at the top.
  await firstCard.click()
  const viewer = page.getByRole('dialog', { name: 'Photos and videos', exact: true })
  await expect(viewer).toBeVisible()
  const pictures = viewer.locator('section')
  const mediaBounds = await pictures.first().locator('img:not([aria-hidden]), video').boundingBox()
  const captionBounds = await pictures.first().locator('p').boundingBox()
  expect(mediaBounds).not.toBeNull()
  expect(captionBounds).not.toBeNull()
  expect(captionBounds!.x >= mediaBounds!.x + mediaBounds!.width || captionBounds!.y >= mediaBounds!.y + mediaBounds!.height).toBe(true)
  expect(await pictures.count()).toBeGreaterThan(1)
  const close = viewer.getByRole('button', { name: 'Close photos and videos', exact: true })
  await close.press('ArrowDown')
  await expect.poll(() => pictures.nth(1).evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(0)
  const visibleMedia = pictures.nth(1).locator('img:not([aria-hidden]), video')
  if (await visibleMedia.evaluate(element => element instanceof HTMLVideoElement)) {
    await expect(visibleMedia).toHaveJSProperty('controls', true)
    const initialTime = await visibleMedia.evaluate(element => (element as HTMLVideoElement).currentTime)
    await visibleMedia.press('Space')
    await expect(visibleMedia).toHaveJSProperty('paused', false)
    await expect.poll(() => visibleMedia.evaluate((element, start) => {
      const video = element as HTMLVideoElement
      return video.currentTime > start && !video.paused ? 'playing' : {
        time: video.currentTime, paused: video.paused, readyState: video.readyState,
        networkState: video.networkState, error: video.error?.message ?? null, src: video.currentSrc,
      }
    }, initialTime)).toBe('playing')
  }
  await expect.poll(() => visibleMedia.evaluate(element => element instanceof HTMLVideoElement ? element.videoWidth : (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await close.press('ArrowUp')
  await expect.poll(() => pictures.nth(0).evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(0)
  await close.click()
  await expect(viewer).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  const homeCards = page.locator('[data-social-posts=block] [data-social-post]')
  const first = await homeCards.nth(0).boundingBox()
  const second = await homeCards.nth(1).boundingBox()
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  expect(second!.y).toBe(first!.y)
  expect(second!.x).toBeGreaterThan(first!.x + first!.width)
  await openTenantPage(page, `${testBaseUrl()}/posts`, {})
  await waitForNuxtHydration(page)
  const feedCards = page.locator('[data-social-posts=feed] [data-social-post]')
  const top = await feedCards.nth(0).boundingBox()
  const next = await feedCards.nth(1).boundingBox()
  expect(top).not.toBeNull()
  expect(next).not.toBeNull()
  expect(next!.x).toBe(top!.x)
  expect(next!.y).toBeGreaterThan(top!.y + top!.height)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

// Video cannot be stored outside production (posters live in Cloudflare Images),
// so playback is read here, on KrabiClaw's own published video posts.
test('KrabiClaw video posts play in the feed and the post gallery and yield to the viewer', async ({ page }) => {
  // The post is one the feed's first page renders with a video preview.
  let post: { id: string; slug: string } | undefined
  const playing = (element: Element) => {
    const video = element as HTMLVideoElement
    return video.currentTime > 0 && !video.paused ? 'playing' : {
      time: video.currentTime, paused: video.paused, readyState: video.readyState,
      networkState: video.networkState, error: video.error?.message ?? null, source: video.currentSrc,
    }
  }

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    expect((await openTenantPage(page, `${testBaseUrl()}/posts`, {}))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    if (!post) {
      const id = await page.locator('[data-social-posts] [data-social-post]:has(video)').first().getAttribute('data-social-post')
      expect(id, 'KrabiClaw\'s feed shows a post with a video').toBeTruthy()
      const listed = await page.request.get(`${testBaseUrl()}/api/public/posts`, { params: { limit: 50 } })
      expect(listed.status()).toBe(200)
      post = (await listed.json() as { posts: Array<{ id: string; slug: string }> }).posts.find(row => row.id === id)
      expect(post, 'The rendered post is in the public API').toBeDefined()
    }
    const card = page.locator(`[data-social-post=${JSON.stringify(post!.id)}]`)
    const preview = card.locator('video')
    await preview.scrollIntoViewIfNeeded()
    await expect(preview).toHaveJSProperty('muted', true)
    await expect(preview).toHaveJSProperty('loop', true)
    await expect.poll(() => preview.evaluate(playing)).toBe('playing')
    await expect.poll(() => page.locator('[data-social-posts] video').evaluateAll(elements => elements.filter(element => !(element as HTMLVideoElement).paused).length)).toBe(1)
    await card.click()
    const viewer = page.getByRole('dialog')
    await expect(viewer).toBeVisible()
    await expect(preview).toHaveJSProperty('paused', true)
    await viewer.getByRole('button', { name: 'Close photos and videos', exact: true }).click()
    await expect(preview).toHaveJSProperty('paused', false)
    await page.locator('footer').first().scrollIntoViewIfNeeded()
    await expect(preview).toHaveJSProperty('paused', true)

    expect((await openTenantPage(page, `${testBaseUrl()}/posts/${encodeURIComponent(post!.slug)}`, {}))?.status()).toBe(200)
    await waitForNuxtHydration(page)
    // The gallery renders a phone hero and a wider grid; read the one on screen.
    const detailPreview = page.locator('[data-media-gallery] video:visible').first()
    await detailPreview.scrollIntoViewIfNeeded()
    await expect.poll(() => detailPreview.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
    await page.locator('[data-media-gallery]').getByRole('button', { name: /^Play video,/ }).locator('visible=true').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(detailPreview).toHaveJSProperty('paused', true)
    await page.getByRole('dialog').getByRole('button', { name: 'Close photos and videos', exact: true }).click()
    await expect(detailPreview).toHaveJSProperty('paused', false)
    // Reduced motion stops the preview; it stays a usable control.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => detailPreview.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  }
})
