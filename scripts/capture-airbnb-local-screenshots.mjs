import { chromium } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'

const PORT = 3005
const BASE_URL = `http://localhost:${PORT}`
const ARTIFACT_DIR = '/Users/paulchrisluke/.gemini/antigravity/brain/2dfe1353-4f6a-4736-a0d2-76ef224e4af1'
const SCREENSHOT_DIR = path.resolve('docs/design/airbnb/screenshots')

async function run() {
  const browser = await chromium.launch({ headless: true })

  console.log('3. Capturing Confirm and Pay Page for Stay...')
  const staysContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    extraHTTPHeaders: {
      'x-preview-tenant': 'saltleaf-stays-demo',
    },
  })
  const stayPage = await staysContext.newPage()
  const stayPayUrl = `${BASE_URL}/pay/0580a120-e849-448c-ae97-769a4f22ef6c#1b16e5a5-7a27-4b42-a0f8-07241bde0ce6682acbe0-aec5-41ef-a0d5-9d90767c8dc0`
  await stayPage.goto(stayPayUrl, { waitUntil: 'domcontentloaded' })
  await stayPage.locator('[data-payment-stay]').waitFor({ state: 'visible', timeout: 15000 })
  await stayPage.waitForTimeout(1500)
  const payStayPath = path.join(SCREENSHOT_DIR, '03-confirm-and-pay-stay.png')
  await stayPage.screenshot({ path: payStayPath, fullPage: true })
  fs.copyFileSync(payStayPath, path.join(ARTIFACT_DIR, '03-confirm-and-pay-stay.png'))
  console.log('Captured 03-confirm-and-pay-stay.png')
  await staysContext.close()

  console.log('4. Capturing Confirm and Pay Page for Service Booking (demo)...')
  const serviceContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    extraHTTPHeaders: {
      'x-preview-tenant': 'demo',
    },
  })
  const servicePage = await serviceContext.newPage()
  const servicePayUrl = `${BASE_URL}/pay/071aa018-f720-4eed-b5e1-8f19f08fce1c#e5b66206-8ef4-4aca-8a09-eadab858373b26c107c1-6b8c-44e5-91b3-857a291d59d0`
  await servicePage.goto(servicePayUrl, { waitUntil: 'domcontentloaded' })
  await servicePage.locator('[data-payment-total]').waitFor({ state: 'visible', timeout: 15000 })
  await servicePage.waitForTimeout(1500)
  const payServicePath = path.join(SCREENSHOT_DIR, '04-confirm-and-pay-service.png')
  await servicePage.screenshot({ path: payServicePath, fullPage: true })
  fs.copyFileSync(payServicePath, path.join(ARTIFACT_DIR, '04-confirm-and-pay-service.png'))
  console.log('Captured 04-confirm-and-pay-service.png')

  await serviceContext.close()
  await browser.close()
  console.log('Screenshots 03 and 04 captured successfully!')
}

run().catch(err => {
  console.error('Screenshot capture failed:', err)
  process.exit(1)
})
