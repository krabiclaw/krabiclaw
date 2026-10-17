import { expect, test } from '@playwright/test'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'

test('signed-out dashboard deep links preserve their destination through login', async ({ request }) => {
  const target = '/dashboard/ember-slice-demo/messages/thread-from-notification?source=whatsapp'
  const response = await request.get(target, { maxRedirects: 0 })

  expect(response.status()).toBe(302)
  expect(response.headers().location).toBe(`/login?redirect=${encodeURIComponent(target)}`)

  const appTarget = '/dashboard/app/products/menu?tab=specials'
  const appResponse = await request.get(appTarget, { maxRedirects: 0 })
  expect(appResponse.status()).toBe(302)
  expect(appResponse.headers().location).toBe(`/login?redirect=${encodeURIComponent(appTarget)}`)
})

test('a verified user without an organization starts onboarding and can explicitly visit their profile', async ({ request, baseURL }) => {
  await loginAs(request, baseURL!, 'user-e2e-oauth-private-cimd')

  const destination = await request.get('/api/post-login', { maxRedirects: 0 })
  expect(destination.status()).toBe(302)
  expect(destination.headers().location).toBe('/dashboard/onboarding')

  const appDestination = await request.get('/api/post-login?redirect=/dashboard/app/products', { maxRedirects: 0 })
  expect(appDestination.status()).toBe(302)
  expect(appDestination.headers().location).toBe('/dashboard/onboarding')

  const profile = await request.get('/api/post-login?redirect=/dashboard/account/profile', { maxRedirects: 0 })
  expect(profile.status()).toBe(302)
  expect(profile.headers().location).toBe('/dashboard/account/profile')
})

test('a signed-in owner resolves dashboard deep links with their query string even when a plan is supplied', async ({ request, baseURL }) => {
  await loginAs(request, baseURL!, 'user-e2e-demo-owner')

  const target = '/dashboard/app/products/menu?tab=specials&source=notification'
  for (const plan of [undefined, 'growth']) {
    const params = new URLSearchParams({ redirect: target })
    if (plan) params.set('plan', plan)
    const appDestination = await request.get(`/api/post-login?${params}`, { maxRedirects: 0 })
    expect(appDestination.status()).toBe(302)
    expect(appDestination.headers().location).toBe('/dashboard/ember-slice-demo/products/menu?tab=specials&source=notification')
  }
})

// One journey, run once. The route matrix, the redirects and the SSR HTML do
// not change with viewport width; only the header does, so the narrow pass is
// the header checks that actually differ rather than a second full traversal.
test('public auth CTAs reflect the SSR session', async ({ page, baseURL }) => {
  await dismissPreviewToolbar(page)

  // `Start free` is the action at every width. At 620px and below the header
  // bar gives up its `Sign in` text link and the collapsed navigation carries
  // it instead.
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/')
  // The menu button is server-rendered; it opens the menu once Vue owns it.
  await waitForNuxtHydration(page)
  const narrowHeader = page.locator('header').first()
  await expect(narrowHeader.getByRole('link', { name: 'Start free', exact: true }).first()).toBeVisible()
  await expect(narrowHeader.getByRole('link', { name: 'Sign in', exact: true }).first()).toBeHidden()
  await narrowHeader.getByRole('button', { name: 'Open menu' }).click()
  await expect(narrowHeader.locator('#platform-mobile-nav').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 1280, height: 900 })
  for (const path of ['/', '/docs']) {
    await page.goto(path)
    const header = page.locator('header').first()
    await expect(header.getByRole('link', { name: 'Sign in', exact: true }).first()).toBeVisible()
    await expect(header.getByRole('link', { name: 'Start free', exact: true }).first()).toBeVisible()
  }
  for (const path of ['/login', '/signup']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: path === '/login' ? 'Sign in' : 'Create your account', exact: true })).toBeVisible()
  }

  await loginAs(page.request, baseURL!, 'user-e2e-oauth-private-cimd')
  const session = await (await page.request.get('/api/auth/get-session')).json()

  for (const path of ['/', '/docs', '/plugin', '/features', '/pricing', '/templates/saya']) {
    const response = await page.goto(path)
    expect(response?.status()).toBe(200)
    expect(response!.headers()['cache-control']).toContain('no-store')
    const header = page.locator('header').first()
    // The avatar is a disclosure, not a link: it carries no label of its own
    // because a word in English is not something every owner can act on.
    const account = header.getByLabel(`Account: ${session.user.name}`).first()
    await expect(account).toBeVisible()
    await expect(page.locator('a[href^="/signup"]')).toHaveCount(0)
    await account.click()
    await expect(header.getByRole('link', { name: 'Dashboard', exact: true }).first()).toHaveAttribute('href', '/api/post-login')
    await expect(header.getByRole('link', { name: 'Account settings', exact: true })).toHaveAttribute('href', '/dashboard/account/profile')
    await expect(header.getByRole('button', { name: 'Log out', exact: true })).toBeVisible()
  }
  for (const path of ['/login', '/signup']) {
    const response = await page.request.get(path, { maxRedirects: 0 })
    expect(response.status()).toBe(302)
    expect(response.headers().location).toBe('/api/post-login')
    const target = '/dashboard/account/profile'
    const redirected = await page.request.get(`${path}?redirect=${encodeURIComponent(target)}`, { maxRedirects: 0 })
    expect(redirected.headers().location).toBe(`/api/post-login?redirect=${encodeURIComponent(target)}`)
    const unsafe = await page.request.get(`${path}?redirect=https://example.com`, { maxRedirects: 0 })
    expect(unsafe.headers().location).toBe('/api/post-login')
    await page.goto(path)
    await expect(page).toHaveURL(/\/dashboard\/onboarding$/)
  }
  // Narrow, while still signed in. Only the signed-out `Sign in` text link
  // gives way below 620px; the account control stays at every width. This has
  // to run before the switch-account flow below, which signs the session out.
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/docs')
  await expect(page.locator('header').first().getByLabel(`Account: ${session.user.name}`).first()).toBeVisible()
  await expect(page.locator('a[href^="/signup"]')).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 900 })

  // "Sign in with a different account" signs the current session out, so this
  // is the last thing the journey does.
  await page.goto('/oauth/login')
  await expect(page.getByRole('button', { name: /^Continue as / })).toBeVisible()
  await waitForNuxtHydration(page)
  await page.getByRole('button', { name: 'Sign in with a different account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in to connect', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/oauth\/login$/)
})

test('invitation account switching updates the reactive session without reloading', async ({ page, baseURL }) => {
  await loginAs(page.request, baseURL!, 'user-e2e-oauth-private-cimd')
  await dismissPreviewToolbar(page)
  await page.goto('/accept-invitation/nonexistent-invitation')
  await waitForNuxtHydration(page)
  await page.getByRole('button', { name: 'Sign in with a different account', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Sign in with email', exact: true })).toBeVisible()
})

test('signed-in paid CTAs retain their selected plan through the canonical billing redirect', async ({ page, baseURL }) => {
  await loginAs(page.request, baseURL!, 'user-e2e-demo-owner')
  await page.goto('/pricing')
  for (const [plan, label] of [['growth', 'Get Growth'], ['business', 'Get Business']] as const) {
    await expect(page.getByRole('link', { name: label, exact: true })).toHaveAttribute('href', `/api/post-login?plan=${plan}`)
    const destination = await page.request.get(`/api/post-login?plan=${plan}`, { maxRedirects: 0 })
    expect(destination.status()).toBe(302)
    expect(destination.headers().location).toBe(`/dashboard/ember-slice-demo/payments?tab=plan&plan=${plan}`)
  }
  for (const plan of ['commerce', 'marketing', 'unknown']) {
    const invalid = await page.request.get(`/api/post-login?plan=${plan}`, { maxRedirects: 0 })
    expect(invalid.status()).toBe(400)
  }
})

test('sign-in surfaces the last used method without remembering the account', async ({ page, baseURL }) => {
  await dismissPreviewToolbar(page)
  await loginAs(page.request, baseURL!, 'user-e2e-oauth-private-cimd')
  const signOut = await page.request.post('/api/auth/sign-out', { headers: { origin: baseURL! }, data: {} })
  expect(signOut.status()).toBe(200)

  await page.goto('/login')
  // Better Auth's lastLoginMethod records the method, so the email form is
  // badged. No identity is retained: the email field is empty and nothing
  // offers to continue as the previous account.
  await expect(page.getByText('Last used', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toHaveValue('')
  expect(await (await page.request.get('/api/auth/get-session')).json()).toBeNull()
})
