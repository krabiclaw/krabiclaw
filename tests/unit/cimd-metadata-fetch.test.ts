import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { cimd } from '@better-auth/cimd'
import { oauthProvider } from '@better-auth/oauth-provider'
import { betterAuth } from 'better-auth'
import { jwt } from 'better-auth/plugins'
import { fetchCimdMetadataResource } from '../../server/utils/cimd-metadata-fetch.ts'

const BASE_URL = 'https://auth.test'
const CLIENT_ID = 'https://client.example/oauth/client.json'
const REDIRECT_URI = 'https://client.example/callback'
const SCOPES = ['openid', 'email', 'offline_access', 'tenant']
const METADATA = {
  client_id: CLIENT_ID,
  client_name: 'Conditional metadata client',
  redirect_uris: [REDIRECT_URI],
  grant_types: ['authorization_code'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

async function createProvider(database: DatabaseSync) {
  const auth = betterAuth({
    database,
    baseURL: BASE_URL,
    secret: 'better-auth-cimd-revalidation-test-secret',
    rateLimit: { enabled: false },
    plugins: [
      jwt(),
      oauthProvider({
        loginPage: '/login',
        consentPage: '/consent',
        scopes: SCOPES,
        silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
      }),
      cimd({ fetchClientMetadataResource: fetchCimdMetadataResource }),
    ],
  })
  await (await auth.$context).runMigrations()
  return auth
}

async function authorize(auth: ReturnType<typeof betterAuth>) {
  const query = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: 'test-pkce-challenge-0123456789-abcdefghijklmnop',
    code_challenge_method: 'S256',
  })
  return auth.handler(new Request(`${BASE_URL}/api/auth/oauth2/authorize?${query}`))
}

test('validated client metadata survives conditional 304 revalidation', async (t) => {
  const database = new DatabaseSync(':memory:')
  const requests: Headers[] = []
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    requests.push(new Headers(init?.headers))
    return requests.length === 1
      ? Response.json(METADATA, { headers: { 'cache-control': 'no-cache', etag: '"metadata-v1"' } })
      : new Response(null, { status: 304, headers: { 'cache-control': 'max-age=60', etag: '"metadata-v1"' } })
  })
  try {
    const auth = await createProvider(database)
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await authorize(auth)
      assert.equal(response.status, 302)
      assert.equal(new URL(response.headers.get('location')!, BASE_URL).pathname, '/login')
    }
    assert.equal(requests.length, 2)
    assert.equal(requests[0]!.get('if-none-match'), null)
    assert.equal(requests[1]!.get('if-none-match'), '"metadata-v1"')
    const client = database.prepare('SELECT name, redirectUris, clientDiscoveryId, scopes FROM oauthClient WHERE clientId = ?')
      .get(CLIENT_ID) as { name: string; redirectUris: string; clientDiscoveryId: string; scopes: string }
    assert.equal(client.name, METADATA.client_name)
    assert.deepEqual(JSON.parse(client.redirectUris), [REDIRECT_URI])
    assert.equal(client.clientDiscoveryId, 'cimd')
    assert.deepEqual(JSON.parse(client.scopes), SCOPES)
  }
  finally {
    database.close()
  }
})

test('unvalidated 304 and redirected metadata cannot register a client', async (t) => {
  for (const status of [304, 302]) {
    await t.test(`HTTP ${status}`, async (t) => {
      const database = new DatabaseSync(':memory:')
      const fetch = t.mock.method(globalThis, 'fetch', async (_input, init) => {
        assert.equal(init?.redirect, 'manual')
        return new Response(null, { status, headers: { location: 'https://other.example/client.json' } })
      })
      try {
        const response = await authorize(await createProvider(database))
        assert.equal(response.status, 400)
        const error = await response.json() as { error: string; error_description: string }
        assert.equal(error.error, 'invalid_client')
        assert.equal(error.error_description, status === 304
          ? 'Metadata document returned 304 without a conditional validator'
          : 'Metadata document fetch returned HTTP 302')
        assert.equal(fetch.mock.callCount(), 1)
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM oauthClient').get()!.count, 0)
      }
      finally {
        database.close()
      }
    })
  }
})
