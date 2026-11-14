import test from 'node:test'
import assert from 'node:assert/strict'

import { cloudflareSslSettings, domainRecordsPointToSaas, mapCloudflareStatus, type DomainRecord } from '../../server/utils/domains.ts'
import { domainInstructions, groupCustomDomains } from '../../server/utils/domain-read-model.ts'

function domain(overrides: Partial<DomainRecord>): DomainRecord {
  return {
    id: 'domain-root',
    organization_id: 'org',
    domain: 'example.com',
    type: 'custom',
    role: 'secondary',
    status: 'pending',
    dns_status: 'pending',
    dns_target: 'customers.krabiclaw.com',
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
    ...overrides,
  }
}

test('Cloudflare moved hostnames map to a persisted failure so PATCH recovery remains available', () => {
  assert.equal(mapCloudflareStatus('moved', 'pending_validation', 'valid'), 'failed')
})

test('only account-specific CNAMEs prove that DNS points to SaaS', () => {
  const cases = [
    { name: 'exact CNAME', cname: ['customers.krabiclaw.com'], a: [], aaaa: [], expected: true },
    { name: 'managed descendant CNAME', cname: ['tenant.customers.krabiclaw.com'], a: [], aaaa: [], expected: true },
    { name: 'unrelated CNAME', cname: ['proxy.example.net'], a: [], aaaa: [], expected: false },
    { name: 'shared IPv4 only', cname: [], a: ['104.21.79.204'], aaaa: [], expected: null },
    { name: 'shared IPv6 only', cname: [], a: [], aaaa: ['2606:4700:3030::6815:4fcc'], expected: null },
    { name: 'valid NODATA', cname: [], a: [], aaaa: [], expected: false },
  ] as const

  for (const entry of cases) {
    assert.equal(
      domainRecordsPointToSaas([...entry.cname], [...entry.a], [...entry.aaaa], 'customers.krabiclaw.com'),
      entry.expected,
      entry.name,
    )
  }
})

test('standard custom hostnames use HTTP DCV by default', () => {
  assert.deepEqual(cloudflareSslSettings(), {
    method: 'http',
    type: 'dv',
    bundle_method: 'ubiquitous',
  })
})

test('manual validation strategies still request TXT DCV explicitly', () => {
  assert.equal(cloudflareSslSettings('txt_manual').method, 'txt')
  assert.equal(cloudflareSslSettings('delegated_dcv').method, 'txt')
})

test('domainInstructions uses first-class second SSL and Delegated DCV fields', () => {
  const instructions = domainInstructions(domain({
    validation_strategy: 'delegated_dcv',
    ownership_validation_name: '_cf-custom-hostname.example.com',
    ownership_validation_type: 'TXT',
    ownership_validation_value: 'ownership-token',
    ssl_validation_name: '_acme-challenge.example.com',
    ssl_validation_type: 'TXT',
    ssl_validation_value: 'ssl-token-1',
    ssl_validation_name_2: '_acme-challenge.example.com',
    ssl_validation_type_2: 'TXT',
    ssl_validation_value_2: 'ssl-token-2',
    dcv_delegation_name: '_acme-challenge.example.com',
    dcv_delegation_type: 'CNAME',
    dcv_delegation_value: 'krabiclaw.com.dcv.cloudflare.com',
    metadata: JSON.stringify({ ssl_validation_value2: 'legacy-hidden-token' }),
  }))

  assert.equal(instructions.ownership?.value, 'ownership-token')
  assert.equal(instructions.dcv_delegation?.value, 'krabiclaw.com.dcv.cloudflare.com')
  assert.deepEqual(instructions.ssl_records.map((record) => record.value), ['ssl-token-1', 'ssl-token-2'])
  assert.deepEqual(instructions.records.map((record) => record.value), [
    'ownership-token',
    'krabiclaw.com.dcv.cloudflare.com',
    'ssl-token-1',
    'ssl-token-2',
  ])
  assert.equal(instructions.records.some((record) => record.value === 'legacy-hidden-token'), false)
})

test('delegated DCV is ignored unless the domain is explicitly marked delegated', () => {
  const instructions = domainInstructions(domain({
    validation_strategy: 'http_auto',
    ssl_validation_name: '_acme-challenge.example.com',
    ssl_validation_type: 'TXT',
    ssl_validation_value: 'ssl-token',
    dcv_delegation_name: '_acme-challenge.example.com',
    dcv_delegation_type: 'CNAME',
    dcv_delegation_value: 'synthetic.example.dcv.cloudflare.com',
  }))

  assert.equal(instructions.dcv_delegation, null)
  assert.deepEqual(instructions.records.map((record) => record.value), [
    'ssl-token',
  ])
})

test('groupCustomDomains renders apex and www as one customer domain row', () => {
  const groups = groupCustomDomains([
    domain({
      id: 'domain-apex',
      domain: 'example.com',
      validation_strategy: 'delegated_dcv',
      role: 'secondary',
      status: 'verifying',
      ownership_validation_name: '_cf-custom-hostname.example.com',
      ownership_validation_type: 'TXT',
      ownership_validation_value: 'ownership-token',
      dcv_delegation_name: '_acme-challenge.example.com',
      dcv_delegation_type: 'CNAME',
      dcv_delegation_value: 'krabiclaw.com.dcv.cloudflare.com',
    }),
    domain({
      id: 'domain-www',
      domain: 'www.example.com',
      role: 'canonical',
      status: 'verifying',
      ssl_validation_name: '_acme-challenge.www.example.com',
      ssl_validation_type: 'TXT',
      ssl_validation_value: 'www-certificate-token',
    }),
    domain({
      id: 'domain-platform',
      domain: 'demo.krabiclaw.com',
      type: 'subdomain',
      status: 'active',
    }),
  ])

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.domain, 'example.com')
  assert.equal(groups[0]?.role, 'canonical')
  assert.equal(groups[0]?.www_domain_id, 'domain-www')
  assert.deepEqual(groups[0]?.records.map((record) => [record.type, record.name, record.value]), [
    ['TXT', '_cf-custom-hostname.example.com', 'ownership-token'],
    ['CNAME', '_acme-challenge.example.com', 'krabiclaw.com.dcv.cloudflare.com'],
    ['CNAME', 'www', 'customers.krabiclaw.com'],
    ['TXT', '_acme-challenge.www.example.com', 'www-certificate-token'],
  ])
})
