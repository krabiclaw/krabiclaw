import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTenantHeadLinks } from '../../utils/tenant-head.ts'

test('buildTenantHeadLinks serves Blawby icons for platform', () => {
  const links = buildTenantHeadLinks({ isPlatform: true })
  assert.deepEqual(links, [
    { key: 'app-icon-svg', rel: 'icon', type: 'image/svg+xml', href: '/platform/blawby.svg?v=2' },
    { key: 'app-icon', rel: 'icon', href: '/platform/blawby.ico?v=2' },
    { key: 'app-icon-apple', rel: 'apple-touch-icon', href: '/platform/blawby-180.png?v=2' },
  ])
})

test('buildTenantHeadLinks serves custom favicon for tenant with favicon placement', () => {
  const links = buildTenantHeadLinks({
    isPlatform: false,
    organizationMedia: [
      { slot: 'logo', public_url: 'https://media.example.com/logo.png' },
      { slot: 'favicon', public_url: 'https://media.example.com/tenant-favicon.png' },
    ],
  })
  assert.deepEqual(links, [
    { key: 'app-icon', rel: 'icon', href: 'https://media.example.com/tenant-favicon.png' },
    { key: 'app-icon-apple', rel: 'apple-touch-icon', href: 'https://media.example.com/tenant-favicon.png' },
  ])
})

test('buildTenantHeadLinks suppresses platform icons for tenant without favicon placement', () => {
  const links = buildTenantHeadLinks({
    isPlatform: false,
    organizationMedia: [
      { slot: 'logo', public_url: 'https://media.example.com/logo.png' },
    ],
  })
  assert.deepEqual(links, [])
})
