import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileZarazAnalyticsConfig, type ZarazConfig } from '../../server/utils/zaraz-analytics.ts'

test('reconciliation removes duplicate GA senders and gates pageviews without a system pageload trigger', () => {
  const tool = { component: 'google-analytics_v4', name: 'GA', enabled: true, settings: { tid: 'G-TEST' }, actions: {
    AllPageviews: { actionType: 'pageview', enabled: true, firingTriggers: ['Pageview'] },
    AllTracks: { actionType: 'event', enabled: true, firingTriggers: ['AllTracks'] },
  } }
  const config: ZarazConfig = { tools: { 'ga-platform': tool, 'ga-tenant-platform': structuredClone(tool), 'unrelated-ga': {
    ...tool,
    actions: {
      AllPageviews: { ...tool.actions.AllPageviews, firingTriggers: ['krabiclaw-native-pageview'] },
      AllTracks: { ...tool.actions.AllTracks, blockingTriggers: ['krabiclaw-native-pageview'] },
    },
  } },
    triggers: { AllTracks: { loadRules: [] }, 'krabiclaw-native-pageview': { loadRules: [] } }, historyChange: true }
  const input = { platformOrigin: 'https://example.com', tenants: [{ organizationId: 'platform', measurementId: 'G-TEST', hostnames: ['example.com'] }] }
  assert.equal(reconcileZarazAnalyticsConfig(config, input).removedAnalyticsTools, 1)
  assert.equal(config.historyChange, false)
  assert.deepEqual(config.tools['unrelated-ga']!.settings, tool.settings)
  assert.match(config.consent!.consentModalIntroHTML!, /https:\/\/example\.com\/policies\/privacy/)
  assert.deepEqual(config.tools['ga-tenant-platform']!.actions.AllPageviews!.firingTriggers, ['ga-tenant-platform'])
  assert.deepEqual(config.tools['ga-tenant-platform']!.actions.AllTracks!.firingTriggers, ['ga-tenant-platform-tracks'])
  assert.deepEqual(config.tools['ga-tenant-platform']!.actions.AllPageviews!.blockingTriggers, [])
  assert.deepEqual(config.tools['ga-tenant-platform']!.actions.AllTracks!.blockingTriggers, [])
  assert.deepEqual(config.triggers['ga-tenant-platform']!.loadRules, [
    { id: 'kc-native-pageview', match: '{{ client.__zarazTrack }}', op: 'EQUALS', value: 'krabiclaw_native_pageview' },
    { id: 'kc-tenant-hostname', match: '{{ system.page.url.hostname }}', op: 'MATCH_REGEX', value: '^(example\\.com)$' },
  ])
  assert.equal(config.triggers['blawby-native-pageview']!.system, undefined)
  assert.equal(config.triggers['krabiclaw-native-pageview'], undefined)
  assert.deepEqual(config.tools['unrelated-ga']!.actions.AllPageviews!.firingTriggers, ['blawby-native-pageview'])
  assert.deepEqual(config.tools['unrelated-ga']!.actions.AllTracks!.blockingTriggers, ['blawby-native-pageview'])
  assert.deepEqual(config.triggers.AllTracks!.loadRules, [{ id: 'kc-exclude-native-pageview', match: '{{ client.__zarazTrack }}', op: 'NOT_MATCH_REGEX', value: '^krabiclaw_native_pageview$' }])
  assert.equal(reconcileZarazAnalyticsConfig(config, input).updated, false)
})

test('a blank platform zone inherits the linked tool’s events and withdraws it when disconnected', () => {
  const tool = {
    component: 'google-analytics_v4', name: 'Existing platform GA4', enabled: true,
    settings: { tid: 'G-LINKED', ecommerce: true },
    actions: {
      AllPageviews: { actionType: 'pageview', enabled: true, firingTriggers: ['krabiclaw-native-pageview'] },
      AllTracks: { actionType: 'event', enabled: true, firingTriggers: ['AllTracks'], data: { en: '{{ client.__zarazTrack }}' } },
    },
  }
  const config: ZarazConfig = { tools: {}, triggers: {} }
  const platformOrigin = 'https://blawby.com'
  const platformTemplate = { tool, allTracks: { name: 'All Tracks', loadRules: [
    { match: '{{ client.__zarazEcommerce }}', op: 'NOT_MATCH_REGEX', value: 'true' },
  ] } }
  const input = { platformOrigin, platformTemplate, tenants: [{ organizationId: 'platform', measurementId: 'G-LINKED', hostnames: ['blawby.com'] }] }
  assert.equal(reconcileZarazAnalyticsConfig(config, input).updated, true)
  const installed = config.tools['ga-tenant-platform']!
  assert.deepEqual(installed.settings, { tid: 'G-LINKED', ecommerce: true })
  assert.deepEqual(installed.actions.AllTracks, { ...tool.actions.AllTracks, firingTriggers: ['ga-tenant-platform-tracks'], blockingTriggers: [] })
  assert.deepEqual(installed.actions.AllPageviews!.firingTriggers, ['ga-tenant-platform'])
  assert.deepEqual(installed.actions.AllPageviews!.blockingTriggers, [])
  assert.equal(installed.defaultPurpose, 'kc_analytics')
  assert.equal(config.settings?.ecommerce, true)
  assert.deepEqual(config.triggers.AllTracks!.loadRules, [
    ...platformTemplate.allTracks.loadRules,
    { id: 'kc-exclude-native-pageview', match: '{{ client.__zarazTrack }}', op: 'NOT_MATCH_REGEX', value: '^krabiclaw_native_pageview$' },
  ])
  assert.deepEqual(config.triggers['ga-tenant-platform']!.loadRules, [
    { id: 'kc-native-pageview', match: '{{ client.__zarazTrack }}', op: 'EQUALS', value: 'krabiclaw_native_pageview' },
    { id: 'kc-tenant-hostname', match: '{{ system.page.url.hostname }}', op: 'MATCH_REGEX', value: '^(blawby\\.com)$' },
  ])
  assert.deepEqual(config.triggers['ga-tenant-platform-tracks']!.loadRules, [
    ...platformTemplate.allTracks.loadRules,
    { id: 'kc-exclude-native-pageview', match: '{{ client.__zarazTrack }}', op: 'NOT_MATCH_REGEX', value: '^krabiclaw_native_pageview$' },
    { id: 'kc-tenant-hostname', match: '{{ system.page.url.hostname }}', op: 'MATCH_REGEX', value: '^(blawby\\.com)$' },
  ])
  assert.equal(reconcileZarazAnalyticsConfig(config, input).updated, false)
  assert.equal(reconcileZarazAnalyticsConfig(config, { platformOrigin, tenants: [] }).removedAnalyticsTools, 1)
  assert.equal(config.tools['ga-tenant-platform'], undefined)
  assert.equal(config.triggers['ga-tenant-platform'], undefined)
  assert.equal(config.triggers['ga-tenant-platform-tracks'], undefined)
})

test('multiple tenants receive isolated firing triggers and cannot execute each other’s tools', () => {
  const config: ZarazConfig = { tools: {}, triggers: {} }
  const input = {
    platformOrigin: 'https://blawby.com',
    tenants: [
      { organizationId: 'ncls', measurementId: 'G-NCLS', hostnames: ['northcarolinalegalservices.org', 'www.northcarolinalegalservices.org'] },
      { organizationId: 'cedar', measurementId: 'G-CEDAR', hostnames: ['cedar-legal.blawby.com'] },
      { organizationId: 'platform', measurementId: 'G-PLATFORM', hostnames: ['blawby.com'] },
    ],
  }
  assert.equal(reconcileZarazAnalyticsConfig(config, input).configuredTenants, 3)

  // Verify each tenant has its own isolated pageview firing trigger
  const nclsPageviewTrigger = config.triggers['ga-tenant-ncls'] as { loadRules: Array<{ match: string; op: string; value: string }> }
  const cedarPageviewTrigger = config.triggers['ga-tenant-cedar'] as { loadRules: Array<{ match: string; op: string; value: string }> }
  const platformPageviewTrigger = config.triggers['ga-tenant-platform'] as { loadRules: Array<{ match: string; op: string; value: string }> }

  assert.deepEqual(config.tools['ga-tenant-ncls']!.actions.AllPageviews.firingTriggers, ['ga-tenant-ncls'])
  assert.deepEqual(config.tools['ga-tenant-cedar']!.actions.AllPageviews.firingTriggers, ['ga-tenant-cedar'])
  assert.deepEqual(config.tools['ga-tenant-platform']!.actions.AllPageviews.firingTriggers, ['ga-tenant-platform'])

  // Check NCLS host rule
  const nclsHostRule = nclsPageviewTrigger.loadRules.find(r => r.match === '{{ system.page.url.hostname }}')!
  const nclsRegex = new RegExp(nclsHostRule.value)
  assert.equal(nclsRegex.test('www.northcarolinalegalservices.org'), true)
  assert.equal(nclsRegex.test('northcarolinalegalservices.org'), true)
  assert.equal(nclsRegex.test('cedar-legal.blawby.com'), false)
  assert.equal(nclsRegex.test('blawby.com'), false)

  // Check Cedar host rule
  const cedarHostRule = cedarPageviewTrigger.loadRules.find(r => r.match === '{{ system.page.url.hostname }}')!
  const cedarRegex = new RegExp(cedarHostRule.value)
  assert.equal(cedarRegex.test('cedar-legal.blawby.com'), true)
  assert.equal(cedarRegex.test('www.northcarolinalegalservices.org'), false)
  assert.equal(cedarRegex.test('blawby.com'), false)

  // Check Platform host rule
  const platformHostRule = platformPageviewTrigger.loadRules.find(r => r.match === '{{ system.page.url.hostname }}')!
  const platformRegex = new RegExp(platformHostRule.value)
  assert.equal(platformRegex.test('blawby.com'), true)
  assert.equal(platformRegex.test('www.northcarolinalegalservices.org'), false)
  assert.equal(platformRegex.test('cedar-legal.blawby.com'), false)
})
