import { expect, test } from '@playwright/test'
import { openTenantPage } from './helpers'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, seededSiteURL, testBaseUrl } from './test-env'
import type { FormAnswerSnapshot, FormQuestion } from '../../shared/form-questions'

type Settings = { inquiry_questions: FormQuestion[]; inquiry_questions_revision: string }

test('an owner adds an inquiry question in Website, a visitor answers it, and the conversation and record show the answer', async ({ browser, playwright }, testInfo) => {
  test.setTimeout(120_000)
  const restaurant = seededTenant('restaurant')
  const baseURL = testBaseUrl()
  const unlock = await acquireTenantMutationLock(testInfo, restaurant.organizationId)
  const owner = await playwright.request.newContext({ baseURL })
  await loginAs(owner, baseURL)
  const settingsUrl = `/api/organizations/${restaurant.organizationId}/settings`
  const read = async () => {
    const response = await owner.get(settingsUrl)
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json() as { settings: Settings }).settings
  }
  const original = await read()
  const dashboard = await browser.newContext({ baseURL, storageState: await owner.storageState(), viewport: { width: 1280, height: 900 } })
  try {
    const cms = await dashboard.newPage()
    await openTenantPage(cms, `${baseURL}/dashboard/${restaurant.slug}/website`, {})
    await cms.getByTestId('website-booking-card').click({ timeout: 30_000 })
    await cms.getByTestId('booking-intake-questions-link').click({ timeout: 30_000 })
    await expect(cms).toHaveURL(new RegExp(`/dashboard/${restaurant.slug}/website/inquiry-form$`))
    await cms.getByTestId('list-editor-add').click({ timeout: 30_000 })
    await expect(cms).toHaveURL(/\/website\/inquiry-form\/new$/)
    await cms.getByLabel('Question', { exact: true }).fill('How did you hear about us?')
    await cms.getByText('One choice', { exact: true }).click()
    await cms.getByLabel('Option 1', { exact: true }).fill('A friend')
    await cms.getByLabel('Option 2', { exact: true }).fill('Instagram')
    await cms.getByRole('switch', { name: 'Required' }).click()
    const added = await Promise.all([
      cms.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/dashboard/settings', { timeout: 60_000 }),
      cms.getByRole('button', { name: 'Add', exact: true }).click(),
    ]).then(([response]) => response)
    expect(added.status(), await added.text()).toBe(200)
    await expect(cms).toHaveURL(new RegExp(`/website/inquiry-form$`))
    await expect(cms.getByText('One choice from 2 · Required', { exact: true })).toBeVisible()

    // Read back through the settings API and MCP, not the screen that wrote it.
    const saved = await read()
    const question = saved.inquiry_questions.at(-1)!
    expect(saved.inquiry_questions).toHaveLength(original.inquiry_questions.length + 1)
    expect(question).toEqual({ id: 'how_did_you_hear_about_us', label: 'How did you hear about us?', type: 'single_choice', required: true, help_text: null, choices: [{ id: 'a_friend', label: 'A friend' }, { id: 'instagram', label: 'Instagram' }] })
    const mcpRead = await mcpRequest(owner, baseURL, { method: 'tools/call', toolName: 'get_organization_settings', args: { organization_id: restaurant.organizationId } })
    expect(mcpData<{ settings: Settings }>(await mcpRead.json()).settings.inquiry_questions_revision).toBe(saved.inquiry_questions_revision)

    // The website index previews the saved form on the Booking card.
    await openTenantPage(cms, `${baseURL}/dashboard/${restaurant.slug}/website`, {})
    await expect(cms.getByTestId('website-booking-card')).toContainText(`${saved.inquiry_questions.length} intake question`)

    const guest = await browser.newPage()
    await openTenantPage(guest, `${seededSiteURL('restaurant')}/contact`, seededSiteHeaders('restaurant'))
    await expect(guest.locator('[data-hydrated]')).toHaveAttribute('data-hydrated', 'true')
    await guest.getByLabel(/your name/i).fill('Question Journey')
    await guest.getByLabel(/email/i).fill(`questions-${Date.now()}@playwright.example`)
    await guest.getByRole('radio', { name: 'Instagram', exact: true }).check()
    const submission = guest.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/public/contact'))
    await guest.getByRole('button', { name: 'Send message', exact: true }).click()
    const submitted = await submission
    expect(submitted.status(), await submitted.text()).toBe(201)
    const requestId = (await submitted.json() as { request_id: string }).request_id
    await expect(guest).toHaveURL(/\/contact\/confirmed/)

    // The answers are the submission's, kept with the conversation; MCP reads them out (the inbox view does not carry them).
    const savedAnswers = async () => {
      const response = await mcpRequest(owner, baseURL, { method: 'tools/call', toolName: 'get_conversation', args: { organization_id: restaurant.organizationId, conversation_id: requestId } })
      expect(response.status(), await response.text()).toBe(200)
      return mcpData<{ guest: { answers: FormAnswerSnapshot[] } }>(await response.json()).guest.answers
    }
    const answers = await savedAnswers()
    expect(answers).toEqual([{ question_id: question.id, label: 'How did you hear about us?', type: 'single_choice', help_text: null, value: 'instagram', selected_choices: [{ id: 'instagram', label: 'Instagram' }] }])
    await openTenantPage(cms, `${baseURL}/dashboard/${restaurant.slug}/messages/${requestId}`, {})
    // The answers are part of the visitor's opening message, as they wrote them.
    const answered = cms.locator('[data-message]').first()
    await expect(answered).toBeVisible({ timeout: 30_000 })
    await expect(answered).toContainText('How did you hear about us? Instagram')

    // Removing the question keeps the answer the visitor gave.
    await openTenantPage(cms, `${baseURL}/dashboard/${restaurant.slug}/website/inquiry-form/${question.id}`, {})
    const removed = await Promise.all([
      cms.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/dashboard/settings', { timeout: 60_000 }),
      cms.getByRole('button', { name: /Remove question/ }).click({ timeout: 30_000 }),
    ]).then(([response]) => response)
    expect(removed.status(), await removed.text()).toBe(200)
    expect((await read()).inquiry_questions).toEqual(original.inquiry_questions)
    expect(await savedAnswers()).toEqual(answers)
  } finally {
    const current = await read()
    if (current.inquiry_questions_revision !== original.inquiry_questions_revision) {
      const restored = await owner.patch(settingsUrl, { data: { inquiry_questions: original.inquiry_questions, expected_inquiry_questions_revision: current.inquiry_questions_revision } })
      expect(restored.status(), await restored.text()).toBe(200)
    }
    await dashboard.close()
    await owner.dispose()
    await unlock()
  }
})
