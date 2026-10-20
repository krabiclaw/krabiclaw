import assert from 'node:assert/strict'
import test from 'node:test'
import { isNonIndexableHost, isPrivateSeoPath, isTenantOnlySeoPath, resolveRuntimeSeoConfig } from '../../server/utils/seo-policy.ts'
import { DEMO_HOSTS, isDemoHost, isDemoOrganization } from '../../shared/demo.ts'
import { TENANT_TYPES } from '../../utils/tenant-routing.ts'

test('demo contracts correctly identify the showcase tenants and hosts', () => {
  assert.ok(DEMO_HOSTS.has('demo.krabiclaw.com'))
  assert.ok(DEMO_HOSTS.has('demo.localhost'))

  assert.equal(isDemoOrganization({ subdomain: 'demo' }), true)
  assert.equal(isDemoOrganization({ subdomain: 'saltleaf-stays-demo' }), true)
  assert.equal(isDemoOrganization({ subdomain: 'pottery-house-krabi' }), false)
  assert.equal(isDemoOrganization({ subdomain: null }), false)
  assert.equal(isDemoOrganization(null), false)
  assert.equal(isDemoOrganization(undefined), false)

  assert.equal(isDemoHost('demo.krabiclaw.com'), true)
  assert.equal(isDemoHost('demo.krabiclaw.com:443'), true)
  assert.equal(isDemoHost('demo.localhost'), true)
  assert.equal(isDemoHost('demo.localhost:3000'), true)
  assert.equal(isDemoHost('DEMO.KRABICLAW.COM'), true)
  assert.equal(isDemoHost('krabiclaw.com'), false)
  assert.equal(isDemoHost('pottery-house-krabi.com'), false)
})

test('isNonIndexableHost classifies staging, cloudflare previews, and demo showcase hosts as non-indexable', () => {
  // Demo showcase hosts
  assert.equal(isNonIndexableHost('demo.krabiclaw.com'), true)
  assert.equal(isNonIndexableHost('demo.localhost'), true)
  assert.equal(isNonIndexableHost('demo.localhost:3000'), true)

  // Staging and previews
  assert.equal(isNonIndexableHost('staging.krabiclaw.com'), true)
  assert.equal(isNonIndexableHost('pottery-house-staging.krabiclaw.com'), true)
  assert.equal(isNonIndexableHost('preview.pages.dev'), true)
  assert.equal(isNonIndexableHost('app.workers.dev'), true)

  // Production indexable hosts
  assert.equal(isNonIndexableHost('krabiclaw.com'), false)
  assert.equal(isNonIndexableHost('www.krabiclaw.com'), false)
  assert.equal(isNonIndexableHost('pottery-house-krabi.com'), false)
  assert.equal(isNonIndexableHost('kikuzuki.krabiclaw.com'), false)
})

test('resolveRuntimeSeoConfig produces non-indexable configuration for demo hosts and demo organizations', () => {
  const demoHostResult = resolveRuntimeSeoConfig({
    tenantType: TENANT_TYPES.TENANT,
    origin: 'https://demo.krabiclaw.com',
    hostname: 'demo.krabiclaw.com',
    tenantName: 'Ember & Slice',
  })
  assert.equal(demoHostResult.indexable, false)

  const demoOrgResult = resolveRuntimeSeoConfig({
    tenantType: TENANT_TYPES.TENANT,
    origin: 'https://custom-demo.com',
    hostname: 'custom-demo.com',
    tenantName: 'Ember & Slice',
    tenantSubdomain: 'demo',
  })
  assert.equal(demoOrgResult.indexable, false)

  const realTenantResult = resolveRuntimeSeoConfig({
    tenantType: TENANT_TYPES.TENANT,
    origin: 'https://pottery-house-krabi.com',
    hostname: 'pottery-house-krabi.com',
    tenantName: 'Pottery House Krabi',
    tenantSubdomain: 'pottery-house-krabi',
  })
  assert.equal(realTenantResult.indexable, true)
  assert.equal(realTenantResult.name, 'Pottery House Krabi')

  const platformResult = resolveRuntimeSeoConfig({
    tenantType: TENANT_TYPES.PLATFORM,
    origin: 'https://krabiclaw.com',
    hostname: 'krabiclaw.com',
  })
  assert.equal(platformResult.indexable, true)
  assert.equal(platformResult.name, 'KrabiClaw')
})

test('isTenantOnlySeoPath correctly isolates tenant-specific paths from platform', () => {
  assert.equal(isTenantOnlySeoPath('/reservations'), true)
  assert.equal(isTenantOnlySeoPath('/reservations/123'), true)
  assert.equal(isTenantOnlySeoPath('/menu'), true)
  assert.equal(isTenantOnlySeoPath('/contact'), true)
  assert.equal(isTenantOnlySeoPath('/bookings/abc'), true)
  assert.equal(isTenantOnlySeoPath('/locations/branch-1'), true)

  assert.equal(isTenantOnlySeoPath('/'), false)
  assert.equal(isTenantOnlySeoPath('/blog'), false)
  assert.equal(isTenantOnlySeoPath('/docs'), false)
  assert.equal(isTenantOnlySeoPath('/pricing'), false)
})

test('isPrivateSeoPath accurately identifies non-indexable application and admin routes', () => {
  assert.equal(isPrivateSeoPath('/api/health'), true)
  assert.equal(isPrivateSeoPath('/dashboard'), true)
  assert.equal(isPrivateSeoPath('/auth/login'), true)

  assert.equal(isPrivateSeoPath('/'), false)
  assert.equal(isPrivateSeoPath('/blog'), false)
  assert.equal(isPrivateSeoPath('/docs/guide'), false)
})
