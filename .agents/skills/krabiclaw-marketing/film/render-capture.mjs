// render-capture.mjs <page.html> <out.png> <origin> [scroll-selector] [scroll-top]
// Renders a saved dashboard DOM at 390 x 844 (2x) with scripts removed, so the
// signed-in page draws exactly as the owner saw it without any credentials.
import { chromium } from 'playwright'
import fs from 'node:fs'

const [, , input, output, origin, scrollSelector, scrollTop] = process.argv
if (!/^https:\/\/[^/]+\/$/.test(origin ?? '')) throw new Error(`origin must be the captured page's https origin with a trailing slash, got ${origin}`)
const html = fs.readFileSync(input, 'utf8')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/ crossorigin="[^"]*"/g, '') // the stylesheets load cross-origin from a blank page
  .replace(/(<html\b[^>]*?) class="dark"/i, '$1') // films use the light theme whatever the owner's Chrome is set to
  .replace(/<head([^>]*)>/i, `<head$1><base href="${origin}">`)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' })
await page.setContent(html, { waitUntil: 'networkidle' })
if (scrollSelector) await page.evaluate(([selector, top]) => { for (const el of document.querySelectorAll(selector)) el.scrollTop = Number(top) }, [scrollSelector, scrollTop])
await page.screenshot({ path: output })
await browser.close()
