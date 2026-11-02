import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DASHBOARD_CACHE_TTL_MS, clearDashboardCache } from '../../composables/dashboardFetch.ts'

test('clearDashboardCache clears without error', () => {
  assert.equal(typeof clearDashboardCache, 'function')
  clearDashboardCache()
})

test('DASHBOARD_CACHE_TTL_MS is 30 seconds', () => {
  assert.equal(DASHBOARD_CACHE_TTL_MS, 30_000)
})
