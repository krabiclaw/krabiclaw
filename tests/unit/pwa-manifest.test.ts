import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

test('PWA manifest exists, is valid JSON, and meets Chromium installability standards', () => {
  const manifestPath = join(process.cwd(), 'public', 'manifest.webmanifest')
  assert.ok(existsSync(manifestPath), 'manifest.webmanifest must exist in public/')

  const raw = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(raw) as {
    name?: string
    short_name?: string
    start_url?: string
    scope?: string
    display?: string
    background_color?: string
    theme_color?: string
    icons?: Array<{ src: string; sizes: string; type: string; purpose?: string }>
  }

  assert.ok(manifest.name, 'manifest must have name')
  assert.ok(manifest.short_name, 'manifest must have short_name')
  assert.equal(manifest.start_url, '/dashboard', 'manifest start_url must be /dashboard')
  assert.equal(manifest.scope, '/dashboard', 'manifest scope must be /dashboard')
  assert.equal(manifest.display, 'standalone', 'manifest display must be standalone')
  assert.ok(manifest.background_color, 'manifest must declare background_color')
  assert.ok(manifest.theme_color, 'manifest must declare theme_color')

  const icons = manifest.icons ?? []
  assert.ok(icons.length >= 2, 'manifest must declare icons')

  // Check every icon exists on disk
  for (const icon of icons) {
    const iconRelativePath = icon.src.replace(/^\//, '')
    const iconFullPath = join(process.cwd(), 'public', iconRelativePath)
    assert.ok(existsSync(iconFullPath), `Icon ${icon.src} (${iconFullPath}) must exist on disk`)
    assert.ok(statSync(iconFullPath).size > 0, `Icon ${icon.src} must not be empty`)
  }

  // Chromium PWA install criteria requires 192x192 and 512x512 icons
  const has192 = icons.some(icon => icon.sizes === '192x192')
  const has512 = icons.some(icon => icon.sizes === '512x512')
  assert.ok(has192, 'manifest must declare a 192x192 icon for Android installability')
  assert.ok(has512, 'manifest must declare a 512x512 icon for Android installability')

  // Android adaptive icon support requires a maskable icon
  const hasMaskable = icons.some(icon => icon.purpose?.includes('maskable'))
  assert.ok(hasMaskable, 'manifest must declare at least one maskable icon for Android adaptive icons')
})

test('PWA service worker exists and declares essential lifecycle and push events', () => {
  const swPath = join(process.cwd(), 'public', 'sw.js')
  assert.ok(existsSync(swPath), 'public/sw.js must exist')

  const swContent = readFileSync(swPath, 'utf8')
  assert.ok(swContent.includes('install'), 'sw.js must handle install event')
  assert.ok(swContent.includes('activate'), 'sw.js must handle activate event')
  assert.ok(swContent.includes('push'), 'sw.js must handle push notifications')
  assert.ok(swContent.includes('notificationclick'), 'sw.js must handle notification clicks')
})
