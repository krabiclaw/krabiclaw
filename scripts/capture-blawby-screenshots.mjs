#!/usr/bin/env node
import { chromium } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import {
  environmentTenantAliasHostname,
  usesTenantHeader,
} from '../server/utils/tenant-hosts.ts'
import {
  BLAWBY_PARITY_ROUTES,
  BLAWBY_PARITY_VIEWPORTS,
  BLAWBY_REFERENCE_COMMIT,
  BLAWBY_REFERENCE_ETAG,
  BLAWBY_REFERENCE_URL,
} from './blawby-parity-config.mjs'

function parseArgs(argv) {
  const args = {
    url: '',
    source: 'blawby',
    sourceRevision: '',
    outDir: 'client-imports/north-carolina-legal-services/evidence',
    tenantSlug: '',
    sitemapUrl: '',
    routes: structuredClone(BLAWBY_PARITY_ROUTES),
    explicitRoutes: {},
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--url') args.url = argv[++i]
    else if (arg === '--source') args.source = argv[++i]
    else if (arg === '--source-revision') args.sourceRevision = argv[++i]
    else if (arg === '--out-dir') args.outDir = argv[++i]
    else if (arg === '--tenant-slug') args.tenantSlug = argv[++i]
    else if (arg === '--sitemap-url') args.sitemapUrl = argv[++i]
    else if (arg === '--route') {
      const [name, route] = argv[++i].split('=')
      if (!name || !route) throw new Error('--route must use name=/path')
      args.routes[name] = { path: route, sections: [] }
      args.explicitRoutes[name] = { path: route, sections: [] }
    }
  }
  if (!['reference', 'blawby'].includes(args.source)) {
    throw new Error('--source must be reference or blawby')
  }
  if (args.source === 'reference') {
    args.sourceRevision ||= BLAWBY_REFERENCE_COMMIT
    if (args.sourceRevision !== BLAWBY_REFERENCE_COMMIT) {
      throw new Error(`Reference captures must use pinned commit ${BLAWBY_REFERENCE_COMMIT}`)
    }
  } else {
    args.sourceRevision ||= process.env.GITHUB_SHA || 'working-tree'
  }
  return args
}

function resolveUrl(base, route) {
  const baseUrl = new URL(base)
  const resolved = new URL(route, `${baseUrl.origin}/`)
  if (resolved.origin !== baseUrl.origin) throw new Error(`Route escapes capture origin: ${route}`)
  return resolved.toString()
}

async function publishedRoutes(sitemapUrl) {
  const source = new URL(sitemapUrl)
  const response = await fetch(source, { signal: AbortSignal.timeout(15_000) })
  if (response.status !== 200) throw new Error(`Published route sitemap returned ${response.status}: ${source}`)
  const xml = await response.text()
  if (/<sitemapindex\b/i.test(xml)) throw new Error(`Expected route URLs, received a sitemap index: ${source}`)
  const paths = new Set()
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const route = new URL(match[1].replaceAll('&amp;', '&'))
    if (route.origin !== source.origin) throw new Error(`Sitemap route belongs to another origin: ${route}`)
    paths.add(`${route.pathname}${route.search}`)
  }
  if (!paths.size) throw new Error(`Published route sitemap has no routes: ${source}`)
  return Object.fromEntries([...paths].map((route, index) => [`published-${String(index + 1).padStart(3, '0')}`, { path: route, sections: [] }]))
}

function portablePath(root, filePath) {
  return path.relative(path.resolve(root), filePath).replaceAll('\\', '/')
}

async function stabilizePage(page) {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `,
  })
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready
    const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
    const step = Math.max(window.innerHeight, 600)
    for (let top = 0; top < document.documentElement.scrollHeight; top += step) {
      window.scrollTo(0, top)
      await delay(50)
    }
    window.scrollTo(0, 0)
    for (const image of document.images) image.loading = 'eager'
  })
  await page.waitForFunction(() => Array.from(document.images).every(image => image.complete))
  await page.evaluate(() => Promise.all(Array.from(document.images, image => image.decode())))
}

async function markCaptureSections(page, routeName, expectedSections) {
  return page.evaluate(({ routeName, expectedSections }) => {
    const visible = element => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }
    const contentSection = element => visible(element) && !['HEADER', 'FOOTER'].includes(element.tagName)
    const colorCanvas = document.createElement('canvas')
    colorCanvas.width = 1
    colorCanvas.height = 1
    const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true })
    const normalizedColor = (value) => {
      if (!colorContext || !value) return value
      colorContext.clearRect(0, 0, 1, 1)
      colorContext.fillStyle = value
      colorContext.fillRect(0, 0, 1, 1)
      const [red, green, blue, alpha] = colorContext.getImageData(0, 0, 1, 1).data
      return `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`
    }
    const normalizedFont = (value) => {
      const lower = value.toLowerCase()
      if (lower.includes('bitter')) return 'Bitter'
      if (lower.includes('marcellus')) return 'Marcellus'
      if (lower.includes('poppins')) return 'Poppins'
      return value.replaceAll('"', '')
    }
    const styleSnapshot = (element) => {
      if (!element) return null
      const style = getComputedStyle(element)
      return {
        background_color: normalizedColor(style.backgroundColor),
        border_radius: style.borderRadius,
        box_shadow: style.boxShadow === 'none' ? 'none' : 'present',
        color: normalizedColor(style.color),
        column_gap: style.columnGap,
        display: style.display,
        font_family: normalizedFont(style.fontFamily),
        font_size: style.fontSize,
        font_weight: style.fontWeight,
        grid_columns: style.display === 'grid' ? style.gridTemplateColumns.split(/\s+/).filter(Boolean).length : null,
        line_height: style.lineHeight,
        max_width: style.maxWidth,
        object_fit: style.objectFit,
        overflow_x: style.overflowX,
        overflow_y: style.overflowY,
        padding_bottom: style.paddingBottom,
        padding_left: style.paddingLeft,
        padding_right: style.paddingRight,
        padding_top: style.paddingTop,
        row_gap: style.rowGap,
        text_align: style.textAlign,
      }
    }
    const firstVisible = (root, selector) => Array.from(root.querySelectorAll(selector)).find(visible) || null
    const styleSignature = (element) => {
      const descendants = Array.from(element.querySelectorAll('*')).filter(visible)
      const grid = descendants.find((candidate) => getComputedStyle(candidate).display === 'grid') || null
      const card = descendants.find((candidate) => {
        const style = getComputedStyle(candidate)
        return style.borderRadius !== '0px'
          && style.boxShadow !== 'none'
          && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
      }) || null
      return {
        section: styleSnapshot(element),
        heading: styleSnapshot(firstVisible(element, 'h1, h2, h3')),
        copy: styleSnapshot(firstVisible(element, 'p')),
        grid: styleSnapshot(grid),
        card: styleSnapshot(card),
        media: styleSnapshot(firstVisible(element, 'img')),
      }
    }
    document.querySelectorAll('[data-parity-capture-slot]').forEach(element => {
      element.removeAttribute('data-parity-capture-slot')
    })

    const targets = []
    const add = (element, slot, name) => {
      if (!element || !visible(element)) return
      element.setAttribute('data-parity-capture-slot', slot)
      const rect = element.getBoundingClientRect()
      const documentWidth = document.documentElement.scrollWidth
      const documentHeight = document.documentElement.scrollHeight
      const x = Math.max(0, rect.left + window.scrollX)
      const y = Math.max(0, rect.top + window.scrollY)
      const width = Math.min(rect.width, documentWidth - x)
      const height = Math.min(rect.height, documentHeight - y)
      if (width <= 0 || height <= 0) return
      targets.push({
        slot,
        name,
        style_signature: styleSignature(element),
        clip: {
          x,
          y,
          width,
          height,
        },
      })
    }

    add(Array.from(document.querySelectorAll('header')).find(visible), 'header', 'header')

    let root = document.querySelector('[data-parity-root]')
    if (!root) {
      const mainCandidates = Array.from(document.querySelectorAll('main')).filter(visible)
      root = mainCandidates.sort((left, right) => {
        const leftChildren = Array.from(left.children).filter(visible).length
        const rightChildren = Array.from(right.children).filter(visible).length
        return rightChildren - leftChildren
      })[0] || null
    }

    if (root) {
      const explicit = Array.from(root.querySelectorAll('[data-parity-section]')).filter(element => {
        if (!visible(element)) return false
        return !element.parentElement?.closest('[data-parity-section]')
      })
      const elements = root.matches('section')
        ? [root]
        : explicit.length
        ? explicit
        : Array.from(root.children).filter(contentSection)
      if (!elements.length) {
        add(root, 'main-01', expectedSections[0] || `${routeName}-content`)
      } else {
        elements.forEach((element, index) => {
          const slot = `main-${String(index + 1).padStart(2, '0')}`
          const explicitName = element.getAttribute('data-parity-section')
          add(element, slot, explicitName || expectedSections[index] || `${routeName}-unexpected-${index + 1}`)
        })
      }
    }

    add(Array.from(document.querySelectorAll('footer')).find(visible), 'footer', 'footer')
    return targets
  }, { routeName, expectedSections })
}

const args = parseArgs(process.argv.slice(2))
if (args.source === 'blawby' && args.tenantSlug) {
  const url = new URL(args.url)
  const environmentAlias = environmentTenantAliasHostname(url.hostname, args.tenantSlug)
  if (environmentAlias) {
    url.hostname = environmentAlias
    args.url = url.toString().replace(/\/$/, '')
  }
}
if (!args.url) {
  console.error('Usage: node scripts/capture-blawby-screenshots.mjs --url https://example.com --source reference|blawby [--sitemap-url https://example.com/sitemap.xml] [--route name=/path] [--source-revision sha] [--out-dir dir]')
  process.exit(2)
}
const inventoryMode = Boolean(args.sitemapUrl || args.source === 'blawby' && Object.keys(args.explicitRoutes).length)
if (inventoryMode) {
  if (args.source !== 'blawby') throw new Error('--sitemap-url requires --source blawby')
  args.routes = { ...(args.sitemapUrl ? await publishedRoutes(args.sitemapUrl) : {}), ...args.explicitRoutes }
}

let referenceEtag = null
if (args.source === 'reference') {
  const referenceUrl = new URL(args.url)
  if (referenceUrl.origin !== BLAWBY_REFERENCE_URL) {
    throw new Error(`Reference capture must use ${BLAWBY_REFERENCE_URL}`)
  }
  const response = await fetch(BLAWBY_REFERENCE_URL, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
  referenceEtag = response.headers.get('etag')
  if (referenceEtag !== BLAWBY_REFERENCE_ETAG) {
    throw new Error(`Live reference moved: expected ETag ${BLAWBY_REFERENCE_ETAG}, found ${referenceEtag || 'none'}. Review the source deployment before updating the pin.`)
  }
}

const browser = await chromium.launch({ channel: 'chromium' })
const manifest = {
  schema_version: 2,
  captured_at: new Date().toISOString(),
  source: args.source,
  source_revision: args.sourceRevision,
  pinned_reference_revision: BLAWBY_REFERENCE_COMMIT,
  pinned_reference_etag: BLAWBY_REFERENCE_ETAG,
  observed_reference_etag: referenceEtag,
  base_url: args.url,
  route_inventory_source: args.sitemapUrl || (inventoryMode ? 'command-line --route' : null),
  browser: { name: 'chromium', channel: 'chromium', version: browser.version(), device_scale_factor: 1 },
  rendering: {
    color_scheme: 'light',
    locale: 'en-US',
    reduced_motion: true,
    timezone: 'America/New_York',
  },
  screenshots: [],
  sections: [],
  states: [],
}

try {
  const captures = Object.entries(inventoryMode
    ? { mobile: BLAWBY_PARITY_VIEWPORTS.mobile, desktop: BLAWBY_PARITY_VIEWPORTS.desktop }
    : BLAWBY_PARITY_VIEWPORTS).flatMap(([viewportName, viewport]) =>
    Array.from({ length: inventoryMode ? 2 : 1 }, (_, lane) => ({
      viewportName, viewport,
      routes: Object.entries(args.routes).filter((_, index) => !inventoryMode || index % 2 === lane),
    })))
  await Promise.all(captures.map(async ({ viewportName, viewport, routes }) => {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'en-US',
      reducedMotion: 'reduce',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: args.tenantSlug && usesTenantHeader(new URL(args.url).hostname)
        ? { 'x-preview-tenant': args.tenantSlug, 'cache-control': 'no-store' }
        : undefined,
    })
    const page = await context.newPage()
    const captureSession = await context.newCDPSession(page)
    const pageErrors = []
    const failedFirstParty = []
    const consoleErrors = []
    const requestFailures = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('requestfailed', request => {
      if (new URL(request.url()).origin === new URL(args.url).origin) {
        requestFailures.push(`${request.failure()?.errorText} ${request.url()}`)
      }
    })
    page.on('response', response => {
      if (new URL(response.url()).origin === new URL(args.url).origin && response.status() >= 400) {
        failedFirstParty.push(`${response.status()} ${response.url()}`)
      }
    })
    const failureDetails = async () => {
      const failedMedia = await page.evaluate(captureOrigin => {
        const origins = new Set([captureOrigin, 'https://media.krabiclaw.com', 'https://imagedelivery.net'])
        return Array.from(document.images)
          .filter(image => origins.has(new URL(image.currentSrc || image.src, document.baseURI).origin)
            && (!image.complete || image.naturalWidth === 0))
          .map(image => ({ src: image.currentSrc || image.src, currentSrc: image.currentSrc, loading: image.loading, complete: image.complete, naturalWidth: image.naturalWidth }))
      }, new URL(args.url).origin)
      const failedUrls = new Set(failedMedia.map(image => image.src))
      return {
        pageErrors, failedFirstParty, consoleErrors, requestFailures, failedMedia,
        imageRequests: (await page.requests()).filter(request => failedUrls.has(request.url()))
          .map(request => ({ url: request.url(), timing: request.timing(), failure: request.failure() })),
        appError: await page.evaluate(() => {
          const error = document.querySelector('#__nuxt')?.__vue_app__?.$nuxt?.payload?.error
          return error ? { message: error.message, status: error.statusCode, stack: error.stack, cause: error.cause?.message } : null
        }),
      }
    }
    for (const [routeName, routeConfig] of routes) {
      pageErrors.length = 0
      failedFirstParty.length = 0
      consoleErrors.length = 0
      requestFailures.length = 0
      const targetUrl = resolveUrl(args.url, routeConfig.path)
      const filePath = path.resolve(args.outDir, 'screenshots', args.source, `${routeName}-${viewportName}.png`)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      if (inventoryMode) {
        if (response?.status() !== 200) throw new Error(`${routeConfig.path} returned ${response?.status() ?? 'no response'} at ${viewportName}`)
        await page.waitForFunction(() => document.querySelector('#__nuxt')?.__vue_app__?.$nuxt?.isHydrating === false).catch(async error => {
          throw new Error(`${routeConfig.path} did not hydrate at ${viewportName} (${page.url()}): ${JSON.stringify(await failureDetails())}`, { cause: error })
        })
      }
      await stabilizePage(page).catch(async error => {
        throw new Error(`${routeConfig.path} could not stabilize at ${viewportName} (${page.url()}): ${JSON.stringify(await failureDetails())}`, { cause: error })
      })
      const { cssContentSize } = await captureSession.send('Page.getLayoutMetrics')
      const dimensions = { width: Math.ceil(cssContentSize.width), height: Math.ceil(cssContentSize.height) }
      const clips = []
      // Keep native compositor surfaces below its texture limit without changing the document viewport.
      for (let top = 0; top < dimensions.height; top += 8_192) {
        const height = Math.min(8_192, dimensions.height - top)
        const input = await page.screenshot({ fullPage: true, clip: { x: 0, y: top, width: dimensions.width, height } })
        if (input.readUInt32BE(16) !== dimensions.width || input.readUInt32BE(20) !== height) {
          throw new Error(`${routeConfig.path} screenshot clip geometry mismatch at ${viewportName}, row ${top}`)
        }
        clips.push({ input, top, left: 0 })
      }
      await sharp({ create: { ...dimensions, channels: 3, background: 'white' } }).composite(clips).png().toFile(filePath)
      if (inventoryMode) {
        const finalUrl = new URL(page.url()).href
        if (finalUrl !== new URL(targetUrl).href) {
          throw new Error(`${routeConfig.path} final URL mismatch at ${viewportName}: expected ${targetUrl}, found ${finalUrl}`)
        }
        const htmlLang = await page.locator('html').getAttribute('lang')
        const mainText = await page.locator('main').innerText().catch(async error => {
          throw new Error(`${routeConfig.path} could not read main content at ${viewportName} (${page.url()}): ${JSON.stringify(await failureDetails())}`, { cause: error })
        })
        if (!mainText.trim()) throw new Error(`${routeConfig.path} has no visible main content at ${viewportName}`)
        const details = await failureDetails()
        const { failedMedia } = details
        if (pageErrors.length || failedFirstParty.length || consoleErrors.length || requestFailures.length || failedMedia.length) {
          throw new Error(`${routeConfig.path} failed at ${viewportName}: ${JSON.stringify(details)}`)
        }
        manifest.screenshots.push({ route_name: routeName, route: routeConfig.path, viewport: viewportName,
          final_url: finalUrl, html_lang: htmlLang,
          status: response.status(), file: portablePath(args.outDir, filePath),
          contentSize: cssContentSize, imageSize: dimensions,
          pageErrors: [...pageErrors], failedFirstParty: [...failedFirstParty], consoleErrors: [...consoleErrors],
          requestFailures: [...requestFailures], failedMedia: [...failedMedia] })
        continue
      }
      await page.evaluate(() => window.scrollTo(0, 0))
      const markedSections = await markCaptureSections(page, routeName, routeConfig.sections)
      const markedMainNames = markedSections
        .filter(section => section.slot.startsWith('main-'))
        .map(section => section.name)
      if (JSON.stringify(markedMainNames) !== JSON.stringify(routeConfig.sections)) {
        throw new Error(
          `Section recipe mismatch for ${routeName}/${viewportName}: `
          + `expected ${JSON.stringify(routeConfig.sections)}, found ${JSON.stringify(markedMainNames)}`,
        )
      }
      manifest.screenshots.push({
        route_name: routeName,
        route: routeConfig.path,
        viewport: viewportName,
        status: response?.status() ?? null,
        file: portablePath(args.outDir, filePath),
      })

      for (const section of markedSections) {
        const sectionPath = path.resolve(
          args.outDir,
          'screenshots',
          args.source,
          'sections',
          routeName,
          viewportName,
          `${section.slot}-${section.name}.png`,
        )
        await fs.mkdir(path.dirname(sectionPath), { recursive: true })
        try {
          if (section.slot !== 'header') {
            await page.locator('header').first().evaluate(element => { element.style.visibility = 'hidden' })
          }
          await page.locator(`[data-parity-capture-slot="${section.slot}"]`).first().screenshot({
            path: sectionPath,
            animations: 'disabled',
          })
        } catch (error) {
          throw new Error(
            `Section capture failed for ${routeName}/${viewportName}/${section.slot}-${section.name} `
            + `at ${JSON.stringify(section.clip)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error },
          )
        } finally {
          if (section.slot !== 'header') {
            await page.locator('header').first().evaluate(element => { element.style.visibility = '' })
          }
        }
        manifest.sections.push({
          route_name: routeName,
          route: routeConfig.path,
          viewport: viewportName,
          slot: section.slot,
          name: section.name,
          style_signature: section.style_signature,
          file: portablePath(args.outDir, sectionPath),
        })
      }

    }
    await context.close()
  }))
} finally {
  await browser.close()
}

const manifestPath = path.resolve(args.outDir, `screenshots-${args.source}.json`)
await fs.mkdir(path.dirname(manifestPath), { recursive: true })
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({
  source: manifest.source,
  source_revision: manifest.source_revision,
  observed_reference_etag: manifest.observed_reference_etag,
  screenshots: manifest.screenshots.length,
  sections: manifest.sections.length,
  states: manifest.states.length,
  manifest: portablePath(process.cwd(), manifestPath),
}, null, 2)}\n`)
