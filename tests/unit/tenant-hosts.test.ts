import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  environmentTenantAliasHostname,
  environmentTenantAliasSlug,
  getFreeOrganizationDomain,
  getPlatformHtmlCacheHosts,
  getPlatformHosts,
  hostnameOf,
  isPlatformHost,
  isNonProductionHost,
  normalizeHost,
  usesTenantHeader,
  type TenantHostEnv,
} from '../../server/utils/tenant-hosts.ts'

const prodEnv: TenantHostEnv = {
  NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: 'krabiclaw.com',
  NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.com',
}

const localEnv: TenantHostEnv = {
  NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: 'http://localhost:3000',
  NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.com',
}

const stagingEnv: TenantHostEnv = {
  NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: 'https://krabiclaw.com',
  NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://staging.krabiclaw.com',
}

const portedCustomEnv: TenantHostEnv = {
  NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: 'http://myapp.example.com:3000',
  NUXT_PUBLIC_PLATFORM_DOMAIN: 'https://krabiclaw.com',
}

test('normalizeHost strips protocol, trailing slash and port', () => {
  assert.equal(normalizeHost('https://krabiclaw.com'), 'krabiclaw.com')
  assert.equal(normalizeHost('http://localhost:3000'), 'localhost')
  assert.equal(normalizeHost('http://localhost:3000/'), 'localhost')
  assert.equal(normalizeHost('https://krabiclaw.com/api/mcp'), 'krabiclaw.com')
  assert.equal(normalizeHost('krabiclaw.com'), 'krabiclaw.com')
  assert.equal(normalizeHost(''), '')
  assert.equal(normalizeHost(undefined), '')
})

test('hostnameOf strips the port from a Host header', () => {
  assert.equal(hostnameOf('localhost:3000'), 'localhost')
  assert.equal(hostnameOf('127.0.0.1:3000'), '127.0.0.1')
  assert.equal(hostnameOf('krabiclaw.com'), 'krabiclaw.com')
  assert.equal(hostnameOf(''), '')
})

test('getPlatformHosts includes loopback and only explicitly configured domains', () => {
  for (const env of [prodEnv, localEnv]) {
    const hosts = getPlatformHosts(env)
    assert.ok(hosts.includes('localhost'))
    assert.ok(hosts.includes('127.0.0.1'))
    assert.ok(hosts.includes(normalizeHost(env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN)))
    assert.ok(hosts.includes(normalizeHost(env.NUXT_PUBLIC_PLATFORM_DOMAIN)))
    assert.equal(hosts.includes('www.krabiclaw.com'), false)
  }
  assert.deepEqual(getPlatformHosts({}), ['localhost', '127.0.0.1'])
})

test('getPlatformHosts folds the configured domains in without duplicates', () => {
  const hosts = getPlatformHosts(prodEnv)
  assert.equal(hosts.filter((h) => h === 'krabiclaw.com').length, 1)
})

test('getPlatformHtmlCacheHosts covers all platform host cache prefixes', () => {
  assert.deepEqual(getPlatformHtmlCacheHosts(prodEnv, ['https://krabiclaw.com/api/mcp']), [
    'krabiclaw.com',
    'localhost',
    '127.0.0.1',
])
})

test('isPlatformHost', async (t) => {
  await t.test('recognizes localhost and loopback with and without a port', () => {
    for (const env of [prodEnv, localEnv]) {
      assert.equal(isPlatformHost('localhost', env), true)
      assert.equal(isPlatformHost('localhost:3000', env), true)
      assert.equal(isPlatformHost('127.0.0.1', env), true)
      assert.equal(isPlatformHost('127.0.0.1:3000', env), true)
    }
  })

  await t.test('recognizes the configured platform domain with and without a port', () => {
    assert.equal(isPlatformHost('krabiclaw.com', prodEnv), true)
    assert.equal(isPlatformHost('krabiclaw.com:443', prodEnv), true)
    assert.equal(isPlatformHost('www.krabiclaw.com', prodEnv), false)
    assert.equal(isPlatformHost('www.krabiclaw.com:443', prodEnv), false)
  })

  await t.test('does not recognize an unconfigured production host', () => {
    const env = { ...localEnv, NUXT_PUBLIC_PLATFORM_DOMAIN: 'http://localhost:3000' }
    assert.equal(isPlatformHost('krabiclaw.com', env), false)
    assert.equal(isPlatformHost('www.krabiclaw.com', env), false)
  })

  await t.test('rejects unrelated external hosts and tenant custom domains', () => {
    for (const env of [prodEnv, localEnv]) {
      assert.equal(isPlatformHost('example.com', env), false)
      assert.equal(isPlatformHost('pottery-house-krabi.com', env), false)
      assert.equal(isPlatformHost('pottery-house-krabi.com:8080', env), false)
      assert.equal(isPlatformHost('demo.krabiclaw.com', env), false)
    }
  })

  await t.test('recognizes the deployed *.pages.dev preview host', () => {
    assert.equal(isPlatformHost('krabiclaw.pages.dev', prodEnv), true)
    assert.equal(isPlatformHost('preview-123.krabiclaw.pages.dev', prodEnv), true)
  })

  await t.test('treats workers.dev hosts as no platform host', () => {
    assert.equal(isPlatformHost('krabiclaw-preview.paulchrisluke.workers.dev', prodEnv), false)
    assert.equal(isPlatformHost('some-other-worker.paulchrisluke.workers.dev', prodEnv), false)
  })
})

test('getFreeOrganizationDomain normalizes the configured domain and strips its port', () => {
  assert.equal(getFreeOrganizationDomain(prodEnv), 'krabiclaw.com')
  assert.equal(getFreeOrganizationDomain(localEnv), 'localhost')
  assert.equal(getFreeOrganizationDomain(portedCustomEnv), 'myapp.example.com')
})

test('getFreeOrganizationDomain rejects an unconfigured domain', () => {
  assert.throws(() => getFreeOrganizationDomain({}), /NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN is required/)
})

test('non-production is local and staging, including staging tenant aliases', () => {
  assert.equal(isNonProductionHost('localhost'), true)
  assert.equal(isNonProductionHost('localhost:3000'), true)
  assert.equal(isNonProductionHost('127.0.0.1:3000'), true)
  assert.equal(isNonProductionHost('preview.krabiclaw.com'), false)
  assert.equal(isNonProductionHost('staging.krabiclaw.com'), true)
  assert.equal(isNonProductionHost('pottery-house-preview.krabiclaw.com'), false)
  assert.equal(isNonProductionHost('pottery-house-staging.krabiclaw.com'), true)
  assert.equal(isNonProductionHost('preview.customer.com'), false)
  assert.equal(isNonProductionHost('some-other-worker.paulchrisluke.workers.dev'), false)
})

test('tenant headers are confined to local hosts', () => {
  assert.equal(usesTenantHeader('localhost:3000'), true)
  assert.equal(usesTenantHeader('krabiclaw-preview.paulchrisluke.workers.dev'), false)
  assert.equal(usesTenantHeader('preview.krabiclaw.com'), false)
  assert.equal(usesTenantHeader('staging.krabiclaw.com'), false)
  assert.equal(usesTenantHeader('pottery-house-staging.krabiclaw.com'), false)
})

test('Cloudflare Quick Tunnels are development hosts without implicit tenant or platform identity', () => {
  const hostname = 'construct-engineer-wings-smile.trycloudflare.com'
  assert.equal(isNonProductionHost(hostname), true)
  assert.equal(isNonProductionHost(`${hostname.toUpperCase()}.:443`), true)
  assert.equal(usesTenantHeader(hostname), false)
  assert.equal(isPlatformHost(hostname, prodEnv), false)
  assert.equal(isPlatformHost(hostname, { NUXT_PUBLIC_PLATFORM_DOMAIN: `https://${hostname}` }), true)

  for (const host of [
    'trycloudflare.com',
    `nested.${hostname}`,
    `${hostname}.example.com`,
    'trycloudflare.com.example.com',
    'example.ngrok.app',
    'example.workers.dev',
  ]) {
    assert.equal(isNonProductionHost(host), false)
    assert.equal(usesTenantHeader(host), false)
  }
})

test('environment tenant aliases use first-level staging hostnames', () => {
  assert.equal(
    environmentTenantAliasHostname('staging.krabiclaw.com', 'pottery-house'),
    'pottery-house-staging.krabiclaw.com',
  )
  assert.equal(environmentTenantAliasHostname('preview.krabiclaw.com', 'ncls'), '')
  assert.equal(environmentTenantAliasHostname('krabiclaw.com', 'ncls'), '')
  assert.equal(environmentTenantAliasHostname('staging.krabiclaw.com', '../ncls'), '')

  assert.equal(
    environmentTenantAliasSlug('pottery-house-staging.krabiclaw.com', stagingEnv),
    'pottery-house',
  )
  assert.equal(environmentTenantAliasSlug('staging.krabiclaw.com', stagingEnv), null)
  assert.equal(environmentTenantAliasSlug('pottery-house-preview.krabiclaw.com', stagingEnv), null)
  assert.equal(environmentTenantAliasSlug('unknown.example.com', stagingEnv), null)
})
