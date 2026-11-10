// render-capture.mjs <page.html> <out.png> [scroll-selector] [scroll-top]
// Renders a saved dashboard DOM at 390 x 844 (2x) with scripts removed, so the
// signed-in page draws exactly as the owner saw it without any credentials.
import { chromium } from 'playwright'
import fs from 'node:fs'

const [, , input, output, scrollSelector, scrollTop] = process.argv
const origin = 'https://krabiclaw.com/'
const html = fs.readFileSync(input, 'utf8')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/ crossorigin="[^"]*"/g, '') // the stylesheets load cross-origin from a blank page
  .replace(/<head([^>]*)>/i, `<head$1><base href="${origin}">`)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'networkidle' })
if (scrollSelector) await page.evaluate(([selector, top]) => { for (const el of document.querySelectorAll(selector)) el.scrollTop = Number(top) }, [scrollSelector, scrollTop])
await page.screenshot({ path: output })
await browser.close()
