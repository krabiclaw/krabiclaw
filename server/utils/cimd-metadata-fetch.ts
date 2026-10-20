import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider'

/**
 * Workers transport for Client ID Metadata Documents and CIMD-owned JWKS.
 * Keep `global_fetch_strictly_public` enabled in wrangler.toml: these URLs
 * come from unauthenticated clients and need the runtime's network boundary.
 *
 * Never follow redirects. Better Auth rejects redirect responses and owns
 * status validation, including conditional 304 metadata revalidation. Forward
 * its headers and abort signal rather than duplicating that lifecycle here.
 */
export const fetchCimdMetadataResource: ClientMetadataResourceFetch = (input, init) =>
  fetch(input, { ...init, redirect: 'manual' })
