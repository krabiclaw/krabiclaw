import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openTenantPage, waitForNuxtHydration } from './helpers'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, seededSiteURL } from './test-env'
import { loginAs } from './helpers/auth'

const DEFAULT_ARTIFACT_DIR = '/Users/paulchrisluke/.gemini/antigravity/brain/528cd9a5-d63f-4437-b153-d904fcf58b3c/screenshots'
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || (fs.existsSync(DEFAULT_ARTIFACT_DIR) ? DEFAULT_ARTIFACT_DIR : path.resolve(process.cwd(), '.screenshots'))
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
}

async function chooseFirstAvailableTime(page: Page) {
  const slot = page.getByRole('button', { name: /\bAvailable$/ }).first()
  await expect(slot).toBeVisible()
  await slot.click()
  await page.getByRole('button', { name: /continue/i }).click()
}

test('Capture full Zillow-parity agreement preparation, full-screen signing, escrow & rent ledger flow', async ({ page, baseURL, browser }) => {
  test.setTimeout(180_000)

  // 1. PUBLIC CHECKOUT (Clean & Frictionless)
  const studio = seededTenant('experience')
  const wheel = studio.products['wheel-class']!
  const guestOrigin = seededSiteURL('experience')
  const guestHeaders = seededSiteHeaders('experience')
  const wheelPath = `/locations/${studio.locations['ao-nang']!.slug}/products/${wheel.slug}`

  await openTenantPage(page, `${guestOrigin}${wheelPath}`, guestHeaders)
  await waitForNuxtHydration(page)

  await page.getByRole('button', { name: 'Book now' }).first().click()
  await chooseFirstAvailableTime(page)

  await page.getByLabel('Full name').fill('Harold Webber')
  const guestEmail = `lodging-invitee@playwright.example`
  await page.getByLabel('Email address').fill(guestEmail)
  await page.getByLabel(/Phone number/i).fill('+66812345678')

  const submission = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes(`/products/${wheel.slug}/book`))
  await page.getByRole('button', { name: 'Confirm booking' }).click()
  const response = await submission
  expect(response.status()).toBe(201)
  const booked = await response.json() as { conversation_id: string; booking_id: string }

  // 2. OPERATOR CMS: Dedicated Lease/Agreement Leaf
  const adminContext = await browser.newContext()
  const adminPage = await adminContext.newPage()
  adminPage.on('console', msg => console.log('[ADMIN LOG]:', msg.text()))
  adminPage.on('pageerror', err => console.log('[ADMIN ERROR]:', err))
  await adminPage.setViewportSize({ width: 1440, height: 900 })

  await loginAs(adminContext.request, baseURL!, 'user-e2e-pottery-owner')
  await adminPage.goto(`${baseURL}/dashboard/${studio.slug}/messages/${booked.conversation_id}`)
  await waitForNuxtHydration(adminPage)
  await adminPage.waitForTimeout(2000)

  // Navigate to Agreement leaf via row
  const agreementRow = adminPage.locator('[data-testid="booking-agreement-row"]')
  await expect(agreementRow).toBeVisible({ timeout: 15_000 })
  await agreementRow.click()
  await adminPage.waitForTimeout(1500)

  // 3. Verify Zillow 4-Card Checklist Hub & Open Terms Modal (Zillow Screenshots 01-09)
  const cardDocs = adminPage.locator('[data-testid="card-documents"]')
  await expect(cardDocs).toBeVisible({ timeout: 15_000 })
  const cardDuration = adminPage.locator('[data-testid="card-duration"]')
  await expect(cardDuration).toBeVisible()
  const cardSigners = adminPage.locator('[data-testid="card-signers"]')
  await expect(cardSigners).toBeVisible()
  const cardRent = adminPage.locator('[data-testid="card-rent"]')
  await expect(cardRent).toBeVisible()

  // Open Duration Wizard Modal (Zillow Screenshots 01 & 02)
  const editDurationBtn = adminPage.locator('[data-testid="edit-duration-btn"]')
  await editDurationBtn.click()
  await adminPage.waitForTimeout(1000)

  // Screenshot 1: Structured Terms Modal (Lease summary)
  await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, '01-zillow-lease-terms-builder.png') })

  // Save and continue modal
  const saveDurationBtn = adminPage.getByRole('button', { name: /Save and continue/i }).first()
  await saveDurationBtn.click()
  await adminPage.waitForTimeout(1000)

  // Click "Next" to generate PDF and launch Full-Screen Field Workspace (Zillow Screenshot 09)
  const prepareBtn = adminPage.locator('[data-testid="booking-agreement-prepare"]')
  await expect(prepareBtn).toBeVisible()
  await prepareBtn.click()
  await adminPage.waitForTimeout(3500)

  // 4. Full-Screen Field Placement Workspace (#1909 - Zillow Screenshots 10, 11, 12 & Image 1)
  const fullscreenWorkspace = adminPage.locator('[data-testid="fullscreen-field-workspace"]')
  await expect(fullscreenWorkspace).toBeVisible({ timeout: 15_000 })
  await adminPage.waitForTimeout(1500)

  // Screenshot 2: Full-Screen Workspace with Palette, Canvas & Markers
  await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, '02-zillow-fullscreen-field-workspace.png') })

  // Click "Request signatures" button
  const requestSignaturesBtn = adminPage.locator('[data-testid="request-signatures-button"]')
  await expect(requestSignaturesBtn).toBeVisible()
  await requestSignaturesBtn.click()
  await adminPage.waitForTimeout(3000)

  // 5. TENANT CMS: Full-Screen Document Review & In-Document Signing Experience
  const guestContext = await browser.newContext()
  const guestPage = await guestContext.newPage()
  await guestPage.setViewportSize({ width: 1440, height: 900 })

  await loginAs(guestContext.request, baseURL!, 'user-e2e-lodging-invitee')
  await guestPage.goto(`${baseURL}/dashboard/account/messages/${booked.conversation_id}`)
  await waitForNuxtHydration(guestPage)
  await guestPage.waitForTimeout(2000)

  // 1. In the guest thread, click "View" on the agreement event
  const viewAgreementBtn = guestPage.locator('[data-testid="conversation-open-agreement"]').first()
  await expect(viewAgreementBtn).toBeVisible({ timeout: 15_000 })
  await viewAgreementBtn.click()
  await guestPage.waitForTimeout(1000)

  // 2. Click "Sign" button inside the agreement dialog to launch Full-Screen Signing Workspace
  const signPromptBtn = guestPage.locator('[data-testid="booking-agreement-sign"]').first()
  await expect(signPromptBtn).toBeVisible({ timeout: 15_000 })
  await signPromptBtn.click()
  await guestPage.waitForTimeout(2500)

  // Screenshot 3: Full-Screen Tenant Document Review & Sign Experience
  await guestPage.screenshot({ path: path.join(SCREENSHOT_DIR, '03-zillow-fullscreen-tenant-signing.png') })

  // Open Signature Adoption Modal (via Next signature helper)
  const nextSigBtn = guestPage.locator('[data-testid="next-signature-button"]')
  await expect(nextSigBtn).toBeVisible({ timeout: 15_000 })
  await nextSigBtn.click()

  // Fill legal name & consent in adoption modal
  const nameInput = guestPage.locator('[data-testid="agreement-name"]')
  await expect(nameInput).toBeVisible({ timeout: 10_000 })
  await nameInput.fill('Harold Webber')
  const consentCheckbox = guestPage.locator('[data-testid="agreement-consent"]')
  await consentCheckbox.check()
  await guestPage.waitForTimeout(500)

  // Screenshot 4: Signature Adoption Card with Snell Roundhand cursive preview
  await guestPage.screenshot({ path: path.join(SCREENSHOT_DIR, '04-zillow-signature-adoption-card.png') })

  // Adopt signature (Zillow Image 2: "Adopt and sign")
  const adoptBtn = guestPage.getByRole('button', { name: /Adopt and sign|Adopt and apply/i })
  await adoptBtn.click()
  await guestPage.waitForTimeout(1000)

  // Submit signed document and assert 200 response
  const finishBtn = guestPage.locator('[data-testid="agreement-submit"]')
  await expect(finishBtn).toBeEnabled({ timeout: 10_000 })
  const signPromise = guestPage.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/agreement/sign'))
  await finishBtn.click()
  const signRes = await signPromise
  expect(signRes.status()).toBe(200)

  // 6. OPERATOR BOOKING DETAILS: Executed Agreement row
  await adminPage.goto(`${baseURL}/dashboard/${studio.slug}/messages/${booked.conversation_id}`)
  await waitForNuxtHydration(adminPage)

  // Verify executed agreement is visible on booking details
  const finalAgreementRow = adminPage.locator('[data-testid="booking-agreement-row"]')
  await expect(finalAgreementRow).toBeVisible({ timeout: 15_000 })
  await finalAgreementRow.scrollIntoViewIfNeeded()

  // Screenshot 5: Operator CMS with Agreement row
  await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, '05-zillow-booking-details-escrow-ledger.png') })

  await adminContext.close()
  await guestContext.close()
})
