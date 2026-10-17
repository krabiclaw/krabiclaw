import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDashboardAppPath, resolveDashboardAppTarget } from '../../shared/auth/return-target.ts'
import { appDashboardPath, DASHBOARD_DESTINATIONS } from '../../server/utils/dashboard-links.ts'

test('isDashboardAppPath identifies /dashboard/app and its subpaths', () => {
  assert.equal(isDashboardAppPath('/dashboard/app'), true)
  assert.equal(isDashboardAppPath('/dashboard/app/'), true)
  assert.equal(isDashboardAppPath('/dashboard/app/products'), true)
  assert.equal(isDashboardAppPath('/dashboard/app/products/menu?tab=drinks#special'), true)
  assert.equal(isDashboardAppPath('/dashboard/app?tab=overview'), true)
  assert.equal(isDashboardAppPath('/dashboard/app#heading'), true)

  assert.equal(isDashboardAppPath('/dashboard'), false)
  assert.equal(isDashboardAppPath('/dashboard/'), false)
  assert.equal(isDashboardAppPath('/dashboard/acme-bistro'), false)
  assert.equal(isDashboardAppPath('/dashboard/account/profile'), false)
  assert.equal(isDashboardAppPath('/dashboard/apple'), false)
  assert.equal(isDashboardAppPath('/login'), false)
})

test('resolveDashboardAppTarget maps /dashboard/app subpaths to the active organization destination', () => {
  const base = '/dashboard/pinecone-stays'

  assert.equal(resolveDashboardAppTarget(base, '/dashboard/app'), '/dashboard/pinecone-stays')
  assert.equal(resolveDashboardAppTarget(base, '/dashboard/app/'), '/dashboard/pinecone-stays')
  assert.equal(resolveDashboardAppTarget(base, '/dashboard/app/products'), '/dashboard/pinecone-stays/products')
  assert.equal(resolveDashboardAppTarget(base, '/dashboard/app/products/menu'), '/dashboard/pinecone-stays/products/menu')
  assert.equal(resolveDashboardAppTarget(base, '/dashboard/app/website/brand?tab=logo'), '/dashboard/pinecone-stays/website/brand?tab=logo')
  assert.equal(resolveDashboardAppTarget(base, '/dashboard/app?tab=activity'), '/dashboard/pinecone-stays?tab=activity')

  // When org destination is restricted to member calendar profile, does not append org-wide subpaths
  const memberCal = '/dashboard/account/profile/calendar?organization_id=org_123'
  assert.equal(resolveDashboardAppTarget(memberCal, '/dashboard/app/products'), memberCal)

  // Non-app paths remain untouched
  assert.equal(resolveDashboardAppTarget(base, '/dashboard/account/profile'), '/dashboard/account/profile')
})

test('appDashboardPath generates canonical org-agnostic deep-links', () => {
  assert.equal(appDashboardPath(), '/dashboard/app')
  assert.equal(appDashboardPath(''), '/dashboard/app')
  assert.equal(appDashboardPath('products'), '/dashboard/app/products')
  assert.equal(appDashboardPath('/products/menu'), '/dashboard/app/products/menu')
  assert.equal(appDashboardPath('website/brand'), '/dashboard/app/website/brand')
})

test('DASHBOARD_DESTINATIONS includes canonical app settings destinations', () => {
  assert.equal(DASHBOARD_DESTINATIONS.products, 'products')
  assert.equal(DASHBOARD_DESTINATIONS['products.menu'], 'products/menu')
  assert.equal(DASHBOARD_DESTINATIONS['website.brand'], 'website/brand')
  assert.equal(DASHBOARD_DESTINATIONS['website.pages'], 'website/pages')
  assert.equal(DASHBOARD_DESTINATIONS.team, 'team')
  assert.equal(DASHBOARD_DESTINATIONS.payments, 'payments')
})
