// The template steps: a booking missing a fact the template names, then a template it can fill.
import { chromium } from 'playwright'

const [out, booking, product] = process.argv.slice(2)
const base = 'http://localhost:3000'
const org = 'ember-slice-demo'
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const shot = async (name) => { await page.waitForTimeout(800); await page.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name) }
await page.request.post(`${base}/api/auth/sign-in/email`, { headers: { origin: base }, data: { email: 'platform-admin@playwright.example', password: 'E2e-Local-Password-7!' } })
const record = `${base}/dashboard/${org}/bookings/${booking}`
const openAgreement = async () => {
  await page.goto(record)
  await page.getByTestId('booking-agreement-row').click()
  await page.getByTestId('card-template').waitFor({ timeout: 60_000 })
}

await openAgreement()
await page.getByTestId('card-template').click()
await page.getByText(/to fill the template with/).waitFor({ timeout: 30_000 })
await shot('11-template-missing-price')

await page.goto(`${base}/dashboard/${org}/products/${product}/agreement`)
await page.getByTestId('template-text').waitFor()
await page.getByTestId('template-text').fill('# Private event agreement\n\n{{business_name}} hosts {{client_name}} ({{client_email}}) for {{offering}} on {{start_date}} at {{address}}.\n\nCancellation. {{cancellation_policy}}\n\nThe guest is responsible for their party and for any damage to the kitchen.')
await page.getByTestId('template-save').click()
await page.waitForTimeout(2500)

await openAgreement()
await page.getByTestId('card-template').click()
await page.getByTestId('fullscreen-field-workspace').waitFor({ timeout: 60_000 })
await page.waitForTimeout(2500)
await shot('12-template-filled-workspace')
await browser.close()
