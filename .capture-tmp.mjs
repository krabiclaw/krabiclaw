// Screens for the owner's visual review of PR #2051, against the local Worker.
import { chromium } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { writeFile, mkdir } from 'node:fs/promises'

const out = process.argv[2]
const base = 'http://localhost:3000'
const org = 'ember-slice-demo'
const booking = process.argv[3]
const product = process.argv[4]
await mkdir(out, { recursive: true })

// A two-page sample lease to upload, made here so nothing real is used.
const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
for (const [index, text] of ['Private event agreement', 'Signatures'].entries()) {
  const page = doc.addPage([612, 792])
  page.drawText(text, { x: 72, y: 700, size: 20, font })
  page.drawText(`Sample page ${index + 1}`, { x: 72, y: 670, size: 11, font })
  if (index === 1) for (const y of [300, 200]) page.drawLine({ start: { x: 72, y }, end: { x: 330, y }, thickness: 1 })
}
const pdfPath = `${out}/sample-agreement.pdf`
await writeFile(pdfPath, await doc.save())

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const shot = async (name) => { await page.waitForTimeout(800); await page.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name) }

const signIn = await page.request.post(`${base}/api/auth/sign-in/email`, { headers: { origin: base }, data: { email: 'platform-admin@playwright.example', password: 'E2e-Local-Password-7!' } })
if (!signIn.ok()) throw new Error(`Sign-in failed: ${signIn.status()} ${await signIn.text()}`)

const record = `${base}/dashboard/${org}/bookings/${booking}`
const openRow = async (id) => { await page.goto(record); await page.getByTestId(id).waitFor({ timeout: 60_000 }); await page.getByTestId(id).click() }
await page.goto(record)
await page.getByTestId('booking-agreement-row').waitFor({ timeout: 60_000 })
await page.getByTestId('booking-agreement-row').scrollIntoViewIfNeeded()
await shot('01-booking-details-agreement-and-deposit')

await page.getByTestId('booking-deposit-row').click()
await page.getByTestId('deposit-required').waitFor()
await shot('02-deposit-leaf')
await page.getByTestId('deposit-required').click()
await page.getByTestId('deposit-required-input').fill('200')
await shot('02b-deposit-amount-dialog')
await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
await page.getByRole('dialog').waitFor({ state: 'detached' })
await page.getByTestId('deposit-received').click()
await page.getByRole('dialog').waitFor()
await shot('02c-deposit-record-dialog')
await page.getByRole('dialog').getByRole('button', { name: 'Record', exact: true }).click()
await page.getByRole('dialog').waitFor({ state: 'detached' })
await page.getByTestId('deposit-entries').waitFor()
await shot('03-deposit-leaf-received')

await openRow('booking-agreement-row')
await page.getByTestId('card-signers').waitFor()
await shot('04-agreement-checklist-empty')
await page.getByTestId('picker-send').setInputFiles(pdfPath)
await shot('05-agreement-checklist-ready')
await page.getByTestId('booking-agreement-prepare').click()
await page.getByTestId('fullscreen-field-workspace').waitFor()
for (const button of await page.getByTestId('place-signature').all()) await button.click()
await shot('06-field-workspace')
await page.getByTestId('rail-tab-pages').click()
await shot('07-field-workspace-pages')
await page.keyboard.press('Escape')

await page.goto(`${base}/dashboard/${org}/products/${product}/agreement`)
await page.getByTestId('agreement-mode').waitFor()
await shot('08-listing-agreement-choices')
await page.getByText('Write your template').click()
await page.getByTestId('template-text').fill('# Private event agreement\n\n{{business_name}} hosts {{client_name}} ({{client_email}}) for {{offering}} on {{start_date}}.\n\nThe price is {{price}}. {{cancellation_policy}}')
await shot('09-template-editor')
await page.getByTestId('template-save').click()
await page.waitForTimeout(2000)

await openRow('booking-agreement-row')
await page.getByTestId('card-template').waitFor()
await shot('10-checklist-from-template')
await page.getByTestId('card-template').click()
await page.getByTestId('fullscreen-field-workspace').waitFor({ timeout: 30_000 })
await shot('11-template-filled-workspace')

await context.close()
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: undefined })
await browser.close()
