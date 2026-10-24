import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INTEGRATIONS, integrationDefinition, type IntegrationKey } from '../../shared/integrations.ts'

test('all registered integrations have unique keys and customer-facing identities', () => {
  const keys = new Set<string>()
  for (const integration of INTEGRATIONS) {
    assert.ok(integration.key, 'Integration must have a key')
    assert.ok(!keys.has(integration.key), `Duplicate integration key: ${integration.key}`)
    keys.add(integration.key)

    assert.ok(integration.name.length > 0, `Integration ${integration.key} must have a name`)
    assert.ok(integration.logo.length > 0, `Integration ${integration.key} must have a logo`)
    assert.ok(integration.purpose.length > 0, `Integration ${integration.key} must have a purpose`)
  }
})

test('integrationDefinition resolves airbnb correctly', () => {
  const airbnb = integrationDefinition('airbnb')
  assert.equal(airbnb.key, 'airbnb')
  assert.equal(airbnb.name, 'Airbnb')
  assert.equal(airbnb.logo, 'i-simple-icons-airbnb')
})

test('integrationDefinition throws on unknown key', () => {
  assert.throws(() => integrationDefinition('unknown' as IntegrationKey), /Unknown integration/)
})
