import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileZarazAnalyticsConfig, type ZarazConfig } from '../../server/utils/zaraz-analytics.ts'

test('reconciliation removes duplicate GA senders and gates pageviews without a system pageload trigger', () => {
  const tool = { component: 'google-analytics_v4', name: 'GA', enabled: true, settings: { tid: 'G-TEST' }, actions: {
    AllPageviews: { actionType: 'pageview', enabled: true, firingTriggers: ['Pageview'] },
    AllTracks: { actionType: 'event', enabled: true, firingTriggers: ['AllTracks'] },
  } }
  const config: ZarazConfig = { tools: { 'ga-platform': tool, 'ga-tenant-platform': structuredClone(tool), 'unrelated-ga': structuredClone(tool) },
    triggers: { AllTracks: { loadRules: [] } }, historyChange: true }
  const input = { platformOrigin: 'https://example.com', tenants: [{ organizationId: 'platform', measurementId: 'G-TEST', hostnames: ['example.com'] }] }
  assert.equal(reconcileZarazAnalyticsConfig(config, input).removedAnalyticsTools, 1)
  assert.equal(config.historyChange, false)
  assert.deepEqual(config.tools['unrelated-ga'], tool)
  assert.match(config.consent!.consentModalIntroHTML!, /https:\/\/example\.com\/policies\/privacy/)
  assert.deepEqual(config.tools['ga-tenant-platform']!.actions.AllPageviews!.firingTriggers, ['krabiclaw-native-pageview'])
  assert.equal(config.triggers['krabiclaw-native-pageview']!.system, undefined)
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
  assert.deepEqual(installed.actions.AllTracks, { ...tool.actions.AllTracks, blockingTriggers: ['ga-tenant-platform'] })
  assert.deepEqual(installed.actions.AllPageviews!.firingTriggers, ['krabiclaw-native-pageview'])
  assert.equal(installed.defaultPurpose, 'kc_analytics')
  assert.equal(config.settings?.ecommerce, true)
  assert.deepEqual(config.triggers.AllTracks!.loadRules, [
    ...platformTemplate.allTracks.loadRules,
    { id: 'kc-exclude-native-pageview', match: '{{ client.__zarazTrack }}', op: 'NOT_MATCH_REGEX', value: '^krabiclaw_native_pageview$' },
  ])
  assert.equal(reconcileZarazAnalyticsConfig(config, input).updated, false)
  assert.equal(reconcileZarazAnalyticsConfig(config, { platformOrigin, tenants: [] }).removedAnalyticsTools, 1)
  assert.equal(config.tools['ga-tenant-platform'], undefined)
})
