import assert from 'node:assert/strict'
import test from 'node:test'
import { isNonIndexableHost, isPrivateSeoPath, resolveRuntimeSeoConfig } from '../../server/utils/seo-policy.ts'
import { TENANT_TYPES } from '../../utils/tenant-routing.ts'

test('isNonIndexableHost classifies staging, cloudflare previews, and demo showcase hosts as non-indexable', () => {
  // Demo showcase hosts
  for (const demo of ['demo.blawby.com', 'saltleaf-stays-demo.blawby.com', 'cedar-legal.blawby.com']) {
    assert.equal(isNonIndexableHost(demo), true, demo)
  }
  assert.equal(isNonIndexableHost('demo.krabiclaw.com'), true)
  assert.equal(isNonIndexableHost('demo.localhost'), true)
  assert.equal(isNonIndexableHost('demo.localhost:3000'), true)

  // Staging and previews
  assert.equal(isNonIndexableHost('staging.krabiclaw.com'), true)
  assert.equal(isNonIndexableHost('staging.blawby.com'), true)
  assert.equal(isNonIndexableHost('pottery-house-staging.blawby.com'), true)
  assert.equal(isNonIndexableHost('pottery-house-staging.krabiclaw.com'), true)
  assert.equal(isNonIndexableHost('preview.pages.dev'), true)
  assert.equal(isNonIndexableHost('app.workers.dev'), true)

  // Production indexable hosts
  assert.equal(isNonIndexableHost('krabiclaw.com'), false)
  assert.equal(isNonIndexableHost('blawby.com'), false)
  assert.equal(isNonIndexableHost('pottery-house-krabi.com'), false)
  assert.equal(isNonIndexableHost('kikuzuki.blawby.com'), false)
})

test('resolveRuntimeSeoConfig produces non-indexable configuration for demo hosts and demo organizations', () => {
  const demoHostResult = resolveRuntimeSeoConfig({
    tenantType: TENANT_TYPES.TENANT,
    origin: 'https://demo.blawby.com',
    hostname: 'demo.blawby.com',
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
    origin: 'https://blawby.com',
    hostname: 'blawby.com',
  })
  assert.equal(platformResult.indexable, true)
  assert.equal(platformResult.name, 'Blawby')
})

test('isPrivateSeoPath accurately identifies non-indexable application and admin routes', () => {
  assert.equal(isPrivateSeoPath('/api/health'), true)
  assert.equal(isPrivateSeoPath('/dashboard'), true)
  assert.equal(isPrivateSeoPath('/auth/login'), true)

  assert.equal(isPrivateSeoPath('/'), false)
  assert.equal(isPrivateSeoPath('/blog'), false)
  assert.equal(isPrivateSeoPath('/docs/guide'), false)
})
