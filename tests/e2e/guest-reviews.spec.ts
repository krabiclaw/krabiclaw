import { expect, test, type APIResponse } from '@playwright/test'
import type { GuestThreadDetailViewModel, GuestThreadListItemViewModel } from '../../server/domain/guest-threads/types'
import type { DashboardBookingDetails } from '../../server/utils/dashboard-booking-details'
import type { ReviewFeedback } from '../../shared/review-feedback'
import { loginAs } from './helpers/auth'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { openTenantPage, waitForNuxtHydration } from './helpers'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, testBaseUrl } from './test-env'

const baseURL = testBaseUrl()
// Clayhouse Studio: its seed leaves one instant class booking whose session has ended.
const studio = () => seededTenant('experience')
const ownerId = 'user-e2e-pottery-owner'
const writable = ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)

async function body<T>(response: APIResponse, status: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(status)
  return await response.json() as T
}

test('a guest who did not come is marked a no-show from the booking record, and that stops their review invitation', async ({ page }, testInfo) => {
  test.skip(!writable, 'No-show writes require disposable local data')
  const { organizationId, slug } = studio()
  const release = await acquireTenantMutationLock(testInfo, organizationId)
  try {
    await loginAs(page.request, baseURL, ownerId)
    const past = (await body<{ threads: GuestThreadListItemViewModel[] }>(await page.request.get(`/api/dashboard/organizations/${organizationId}/guest-threads`, { params: { mailbox: 'past' } }), 200)).threads
    // An ended, confirmed visit nobody has reviewed: the record says whether it may still be a no-show.
    let target: { thread: GuestThreadListItemViewModel; details: DashboardBookingDetails } | null = null
    for (const thread of past.filter(item => item.submissionType === 'booking' || item.submissionType === 'reservation')) {
      const { booking } = await body<{ booking: DashboardBookingDetails }>(await page.request.get(`/api/dashboard/bookings/${thread.submissionType}/${thread.id}`, { params: { org: slug } }), 200)
      if (booking.canMarkNoShow) { target = { thread, details: booking }; break }
    }
    expect(target, 'The studio\'s seed includes an ended, confirmed visit with no review').not.toBeNull()
    const { thread, details } = target!

    await page.goto(`/dashboard/${slug}/bookings/${thread.submissionType}/${thread.id}`)
    await waitForNuxtHydration(page)
    await page.getByRole('button', { name: /^Manage / }).click()
    await page.getByRole('button', { name: 'Mark as a no-show', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Mark as a no-show' })
    await expect(dialog).toContainText('won’t be asked to review')
    await dialog.getByRole('button', { name: 'Mark as a no-show', exact: true }).click()
    await expect(page.getByTestId('booking-review-state')).toContainText('No-show')

    // Read back through other paths: the record, the conversation, and a repeat refused.
    const after = (await body<{ booking: DashboardBookingDetails }>(await page.request.get(`/api/dashboard/bookings/${thread.submissionType}/${thread.id}`, { params: { org: slug } }), 200)).booking
    expect(after.noShowAt).not.toBeNull()
    expect(after.canMarkNoShow).toBe(false)
    expect(after.status).toBe(details.status)
    const conversation = (await body<{ thread: GuestThreadDetailViewModel }>(await page.request.get(`/api/dashboard/organizations/${organizationId}/guest-threads/${thread.id}`), 200)).thread
    expect(conversation.entries.filter(entry => entry.eventName === `${thread.submissionType}.no_show`)).toHaveLength(1)
    const repeat = await page.request.post(`/api/dashboard/organizations/${organizationId}/guest-threads/${thread.id}/operations/no_show`, { data: { idempotencyKey: `repeat-${Date.now()}` } })
    expect(repeat.status(), await repeat.text()).toBe(409)
  } finally {
    await release()
  }
})

test('Insights reads guest feedback apart from published reviews', async ({ page }) => {
  const { slug } = studio()
  await loginAs(page.request, baseURL, ownerId)
  const feedback = await body<ReviewFeedback>(await page.request.get('/api/dashboard/review-feedback', { params: { org: slug, days: '365' } }), 200)
  expect(feedback.organizationWide).toBe(true)
  expect((await page.request.get('/api/dashboard/review-feedback', { params: { org: slug, days: '400' } })).status()).toBe(400)

  await page.goto(`/dashboard/${slug}/insights?tab=reviews`)
  await waitForNuxtHydration(page)
  await expect(page.getByRole('heading', { name: 'Guest feedback' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Published reviews' })).toBeVisible()
  await expect(page.getByTestId('feedback-overall')).toHaveText(feedback.overall.average === null ? '—' : String(feedback.overall.average))
})

test('a review link opens the one review address, and an unknown link says it is unavailable', async ({ page }) => {
  await openTenantPage(page, `${baseURL}/locations/${studio().locations['ao-nang']!.slug}/review-submit?token=not-a-real-token`, seededSiteHeaders('experience'))
  expect(new URL(page.url()).pathname).toBe('/review-submit')
  expect(new URL(page.url()).searchParams.get('token')).toBe('not-a-real-token')
  await expect(page.getByRole('heading', { name: 'This review link is not available' })).toBeVisible()
})
