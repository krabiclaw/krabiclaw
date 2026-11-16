import { expect, test } from '@playwright/test'
import { loginAs } from '../e2e/helpers/auth'
import { waitForNuxtHydration } from '../e2e/helpers'
import { docsCategoryArt } from '../../utils/docs-category-art'

test('platform blog renders its public API posts in server HTML', async ({ request }) => {
  const api = await request.get('/api/public/blog')
  expect(api.ok()).toBe(true)
  const { posts } = await api.json()
  expect(Array.isArray(posts)).toBe(true)

  const response = await request.get('/blog')
  expect(response.ok()).toBe(true)
  const html = await response.text()
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  expect(markup.includes('Blog unavailable'), 'SSR must not render the blog error state').toBe(false)
  expect(markup.includes('Loading posts...'), 'SSR must finish loading the blog').toBe(false)
  if (posts.length === 0) {
    expect(markup).toContain('No posts yet')
  }
  for (const post of posts.filter((post: { hide_from_nav: boolean }, index: number) => index === 0 || !post.hide_from_nav)) {
    const title = post.title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
    expect(markup).toContain(title)
  }
})

test('platform documentation renders its docs collection in server HTML', async ({ request }) => {
  const api = await request.get('/api/public/blog?collection=docs')
  expect(api.ok()).toBe(true)
  const { posts } = await api.json()
  expect(Array.isArray(posts)).toBe(true)
  for (const post of posts) expect(post.collection).toBe('docs')

  const index = await request.get('/docs')
  expect(index.ok()).toBe(true)
  const markup = (await index.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  for (const post of posts) {
    const title = post.title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
    expect(markup).toContain(title)
  }

  const blog = await request.get('/api/public/blog')
  const blogPosts = (await blog.json()).posts as Array<{ collection: string }>
  for (const post of blogPosts) expect(post.collection).toBe('blog')
})

// Read the application's rendered graph, not a fixture or a second schema builder.
function renderedGraph(html: string) {
  const scripts = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
  expect(scripts.length).toBeGreaterThan(0)
  return scripts.flatMap(match => {
    const schema = JSON.parse(match[1]!)
    expect(schema['@context']).toBe('https://schema.org')
    return (schema['@graph'] ?? [schema]) as Array<Record<string, unknown>>
  })
}

function requireNode(nodes: Array<Record<string, unknown>>, type: string) {
  const matches = nodes.filter(node => node['@type'] === type)
  expect(matches, `one ${type} per canonical page`).toHaveLength(1)
  return matches[0]!
}

function expectPageIdentity(nodes: Array<Record<string, unknown>>, url: string, pageType: string) {
  const ids = nodes.map(node => node['@id']).filter(Boolean)
  expect(new Set(ids).size, 'top-level graph identifiers are unique').toBe(ids.length)
  const page = requireNode(nodes, pageType)
  expect(page.url).toBe(url)
  expect(page['@id']).toBe(`${url}#webpage`)
  const breadcrumbs = requireNode(nodes, 'BreadcrumbList')
  expect(page.breadcrumb).toEqual({ '@id': breadcrumbs['@id'] })
  const entries = breadcrumbs.itemListElement as Array<{ position: number; name: string; item: string }>
  expect(entries.length).toBeGreaterThanOrEqual(2)
  entries.forEach((entry, i) => {
    expect(entry.position).toBe(i + 1)
    expect(entry.name.trim()).not.toBe('')
    expect(new URL(entry.item).origin).toBe(new URL(url).origin)
  })
  expect(entries.at(-1)?.item).toBe(url)
  return page
}

test('docs collection, categories and articles publish connected canonical JSON-LD', async ({ request, baseURL }) => {
  const response = await request.get('/api/public/blog?collection=docs')
  expect(response.status()).toBe(200)
  const { posts } = await response.json() as { posts: Array<{ slug: string; title: string; category: { slug: string; name: string } | null }> }
  expect(posts.length, 'the existing published docs must be available').toBeGreaterThan(0)
  const categories = [...new Set(posts.flatMap(post => post.category ? [post.category.slug] : []))]
  // Every published guide and category is fetched over the network.
  test.setTimeout(30_000 + (posts.length + categories.length) * 3_000)
  for (const path of ['/docs', ...categories.map(slug => `/docs/category/${slug}`)]) {
    const result = await request.get(path)
    expect(result.status()).toBe(200)
    const html = await result.text()
    const nodes = renderedGraph(html)
    const url = new URL(path, baseURL).href
    const page = expectPageIdentity(nodes, url, 'CollectionPage')
    const list = requireNode(nodes, 'ItemList')
    expect(page.mainEntity).toEqual({ '@id': list['@id'] })
    expect(list.mainEntityOfPage).toEqual({ '@id': page['@id'] })
    const expected = path === '/docs' ? posts : posts.filter(post => path.endsWith(`/${post.category?.slug}`))
    const entries = list.itemListElement as Array<{ position: number; item: { '@id': string; url: string; name: string } }>
    expect(list.numberOfItems).toBe(expected.length)
    expect(entries).toHaveLength(expected.length)
    expect(new Set(entries.map(entry => entry.item.url)).size).toBe(expected.length)
    entries.forEach((entry, i) => {
      expect(entry.position).toBe(i + 1)
      const article = expected.find(post => entry.item.url === new URL(`/docs/${post.slug}`, baseURL).href)
      expect(article, 'each schema item is a real published article').toBeDefined()
      expect(entry.item.name).toBe(article!.title)
      expect(entry.item['@id']).toBe(`${entry.item.url}#webpage`)
    })
  }
  let howToCount = 0
  for (const post of posts) {
    const path = `/docs/${post.slug}`
    const result = await request.get(path)
    expect(result.status()).toBe(200)
    const html = await result.text()
    const nodes = renderedGraph(html)
    const url = new URL(path, baseURL).href
    const page = expectPageIdentity(nodes, url, 'WebPage')
    const article = requireNode(nodes, 'TechArticle')
    expect(article.url).toBe(url)
    expect(article['@id']).toBe(`${url}#article`)
    expect(article.headline).toBe(post.title)
    expect(article.mainEntityOfPage).toEqual({ '@id': page['@id'] })
    expect(page.mainEntity).toEqual({ '@id': article['@id'] })
    expect(article.publisher).toEqual({ '@id': requireNode(nodes, 'Organization')['@id'] })
    expect(article.inLanguage).toBe('en-US')
    for (const key of ['datePublished', 'dateModified']) {
      if (article[key]) expect(Number.isNaN(Date.parse(String(article[key])))).toBe(false)
    }
    expect(nodes.some(node => node.aggregateRating || node.review)).toBe(false)
    const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    for (const node of nodes.filter(node => node['@type'] === 'HowTo')) {
      howToCount++
      const steps = node.step as Array<{ text: string }>
      expect(steps.length).toBeGreaterThanOrEqual(2)
      for (const step of steps) expect(body).toContain(step.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'))
    }
  }
  expect(howToCount, 'the published docs must exercise HowTo semantics').toBeGreaterThan(0)
})

test('mobile docs retain full navigation and one accessible prompt copy action', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/docs/make-your-first-site-edit')
  await expect(page.locator('article h1')).toHaveText('Make your first site edit')
  await waitForNuxtHydration(page)
  const sections = page.getByRole('button', { name: 'On this page', exact: true })
  await sections.press('Enter')
  await expect(sections).toHaveAttribute('aria-expanded', 'true')
  const section = page.getByRole('navigation', { name: 'On this page' }).filter({ visible: true }).getByRole('link', { name: '3. Check the result', exact: true })
  await section.click()
  await expect(sections).toHaveAttribute('aria-expanded', 'false')
  expect(new URL(page.url()).hash).toContain('check-the-result')
  const copy = page.getByRole('button', { name: 'Copy prompt', exact: true })
  await expect(copy).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Copy code', exact: true })).toHaveCount(0)
  const source = await page.locator('article pre').textContent()
  await copy.press('Enter')
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source)
  await page.getByRole('button', { name: 'Copied', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source)
  const viewport = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }))
  expect(viewport.document).toBeLessThanOrEqual(viewport.viewport)
  const next = page.getByRole('link', { name: 'Next Customize your brand and theme' })
  await expect(next).toBeVisible()
  const title = next.locator('span').last()
  const titleWidth = await title.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }))
  expect(titleWidth.scroll).toBeLessThanOrEqual(titleWidth.client + 1)
})


test('docs reading header exposes one mobile search shortcut without a second content search bar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/docs')
  await expect(page.locator('h1')).toHaveText('Docs')
  const inventory = await page.request.get('/api/public/blog?collection=docs')
  expect(inventory.status()).toBe(200)
  const { posts } = await inventory.json() as { posts: Array<{ category: { id: string } | null }> }
  await expect(page.locator('.docs-task')).toHaveCount(posts.filter((post, index) => index > 0 && post.category !== null).length)
  await page.setViewportSize({ width: 390, height: 844 })
  const search = page.locator('header').getByRole('button', { name: 'Search docs, blog, help...' }).filter({ visible: true })
  await expect(search).toHaveCount(1)
  await expect(page.locator('main').getByRole('button', { name: /Search/ })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await waitForNuxtHydration(page)
  await search.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.goto('/docs/category/getting-started')
  await page.goto('/docs/make-your-first-site-edit')
  await page.setViewportSize({ width: 1440, height: 900 })
})


test('docs category landings explain published tasks and preserve canonical guide identities', async ({ page, request, baseURL }) => {
  const response = await request.get('/api/public/blog?collection=docs')
  const { posts, categories } = await response.json() as { posts: Array<{ slug: string; title: string; excerpt: string | null; category: { slug: string } }>; categories: Array<{ slug: string; name: string }> }
  // Every category landing is opened in the browser.
  test.setTimeout(30_000 + categories.length * 10_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const category of categories) {
    await page.goto(`/docs/category/${category.slug}`)
    await expect(page.locator('h1')).toHaveText(category.name)
    await expect(page.locator('.docs-category > header > p')).toBeVisible()
    const own = posts.filter(post => post.category.slug === category.slug)
    const feature = page.locator('[data-category-feature]')
    await expect(feature).toBeVisible()
    await expect(page.locator('[data-category-guides] article')).toHaveCount(own.length - 1)
    for (const post of own) {
      const link = page.locator(`[data-category-feature] a[href="/docs/${post.slug}"], [data-category-guides] a[href="/docs/${post.slug}"]`)
      await expect(link).toHaveCount(1)
      if (post.excerpt) await expect(page.locator('.docs-category')).toContainText(post.excerpt)
    }
    // Schema and visible primary guide order describe the same real articles.
    const schema = await page.locator('script[type="application/ld+json"]').allTextContents()
    const nodes = schema.flatMap(text => JSON.parse(text)['@graph']) as Array<Record<string, unknown>>
    const list = requireNode(nodes, 'ItemList')
    const entries = list.itemListElement as Array<{ item: { url: string } }>
    const visiblePaths = await page.locator('[data-category-feature] a, [data-category-guides] a').evaluateAll(links => links.map(link => (link as HTMLAnchorElement).pathname))
    expect(entries.map(entry => new URL(entry.item.url).pathname)).toEqual(visiblePaths)
    const links = await page.locator('.docs-category a').evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href))
    links.forEach(link => {
      const path = new URL(link).pathname
      expect(new URL(link).origin).toBe(new URL(baseURL!).origin)
      expect(posts.some(post => path === `/docs/${post.slug}`) || categories.some(item => path === `/docs/category/${item.slug}`) || path === '/docs').toBe(true)
    })
    if (category.slug === 'getting-started') {
      await expect(feature.getByRole('heading')).toHaveText('Create your KrabiClaw account')
      const image = page.locator('[data-category-illustration]')
      await expect(image).toHaveAttribute('src', '/platform/docs/categories/krabiclaw-getting-started-category.png')
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true)
    }
    // Artwork exists for the categories that have it in code; a category the
    // CMS adds later renders without it and shares the site's social image.
    const art = docsCategoryArt(category.slug)
    await expect(page.locator('[data-category-illustration]')).toHaveCount(art ? 1 : 0)
    await expect(feature.locator('figcaption')).toHaveCount(0)
    const og = await page.locator('meta[property="og:image"]').getAttribute('content')
    expect(og).toBeTruthy()
    await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute('content', og!)
    if (art) {
      expect(new URL(og!, baseURL!).pathname).toBe(art.og)
      await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200')
      await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630')
    }
    const ogResponse = await page.request.get(og!)
    expect(ogResponse.status()).toBe(200)
    expect(ogResponse.headers()['content-type']).toMatch(/^image\//)
    for (const image of await page.locator('[data-category-illustration]').all()) {
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(feature).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  // Exercise Nuxt client navigation, rather than proving only independent SSR loads.
  await page.locator('aside a[href="/docs/category/getting-started"]').click()
  await expect(page.locator('h1')).toHaveText('Getting Started')
  await expect(page.locator('[data-category-feature] h2')).toHaveText('Create your KrabiClaw account')
})


test('mobile docs keep the signed-in account control visible beside search and navigation', async ({ page, baseURL }) => {
  await loginAs(page.request, baseURL!)
  const session = await (await page.request.get('/api/auth/get-session')).json()
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/docs')
  const header = page.locator('header').first()
  await expect(header.getByLabel(`Account: ${session.user.name}`)).toBeVisible()
  await expect(header.getByRole('button', { name: 'Search docs, blog, help...' }).filter({ visible: true })).toBeVisible()
  await expect(page.locator('a[href^="/signup"]')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

// The signed-in header's account control is covered beside search above; the menu is the same either way.
test('docs and blog global menu works on desktop and mobile', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const path of ['/docs', '/blog']) {
      await page.goto(path)
      // A click on the server-rendered toggle before hydration does nothing.
      await waitForNuxtHydration(page)
      const header = page.locator('header').first()
      const toggle = header.getByRole('button', { name: 'Open menu', exact: true })
      await expect(toggle).toBeVisible()
      await toggle.click()
      const menu = header.getByRole('navigation', { name: 'Site', exact: true })
      await expect(menu).toBeVisible()
      await expect(header.getByRole('button', { name: 'Close menu', exact: true })).toHaveAttribute('aria-expanded', 'true')
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
      await expect(toggle).toBeFocused()
      await toggle.click()
      await menu.getByRole('link', { name: 'Products', exact: true }).click()
      await expect(page).toHaveURL(/\/products$/)
      await expect(page.locator('#platform-mobile-nav')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.style.overflow)).not.toBe('hidden')
    }
  }
})
