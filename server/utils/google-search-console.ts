import { linkedAccountAccessToken, type CloudflareEnv } from './auth'
import { deleteIntegration, storeIntegration } from './organization-integrations'

/**
 * Search Console as a product of its own, over a Better Auth linked Google
 * account the organization names by `account_id`.
 *
 * The tenant never pastes a verification token. KrabiClaw controls the site's
 * public HTML, so it can do what a verification token is for: Google issues
 * the token, the site serves it as `<meta name="google-site-verification">`,
 * Google fetches the page and confirms, and the property is added. The token
 * is stored only for as long as it must keep being served.
 */

export interface SearchConsoleSite {
  siteUrl: string
  permissionLevel: string
}

const googleJson = async <T>(url: string, accessToken: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`)
  }
  return response.status === 204 ? (undefined as T) : (await response.json()) as T
}

/** The properties the connected account already owns, which need no verification. */
export async function listSearchConsoleSites(accessToken: string): Promise<SearchConsoleSite[]> {
  const response = await googleJson<{ siteEntry?: SearchConsoleSite[] }>(
    'https://www.googleapis.com/webmasters/v3/sites', accessToken,
  )
  return (response.siteEntry ?? []).filter(site =>
    site.permissionLevel === 'siteOwner' || site.permissionLevel === 'siteFullUser')
}

/**
 * Asks Google for this site's META verification token. The same URL-prefix
 * property always gets the same token back, so calling it again while a
 * verification is in flight is safe.
 */
export async function requestVerificationToken(accessToken: string, siteUrl: string): Promise<string> {
  const response = await googleJson<{ token?: string }>(
    'https://www.googleapis.com/siteVerification/v1/token', accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        verificationMethod: 'META',
        site: { type: 'SITE', identifier: siteUrl },
      }),
    },
  )
  // Google returns the whole tag; the content attribute is what the page needs.
  const token = response.token ?? ''
  const content = /content=["']([^"']+)["']/.exec(token)?.[1] ?? token
  if (!content) throw new Error('Google did not return a site verification token')
  return content
}

/** Tells Google to fetch the page and confirm the tag it issued is being served. */
export async function verifySiteOwnership(accessToken: string, siteUrl: string): Promise<void> {
  await googleJson('https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=META', accessToken, {
    method: 'POST',
    body: JSON.stringify({ site: { type: 'SITE', identifier: siteUrl } }),
  })
}

/** Adds the property to Search Console. Verification must already have passed. */
export async function addSearchConsoleSite(accessToken: string, siteUrl: string): Promise<void> {
  await googleJson(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`, accessToken, {
    method: 'PUT',
  })
}

/**
 * The whole automated verification, in the order the outside world requires:
 * ask for the token, serve it, have Google look, then add the property.
 * `publish` is what makes the tag reachable — the public cache purge — and is
 * awaited before Google is asked to fetch.
 */
export async function verifyAndAddProperty(
  env: CloudflareEnv,
  organizationId: string,
  accountId: string,
  siteUrl: string,
  publish: () => Promise<void>,
): Promise<void> {
  const { accessToken } = await linkedAccountAccessToken(env, accountId)
  const token = await requestVerificationToken(accessToken, siteUrl)
  // The token is stored before Google is asked to look for it: the page has
  // to be serving the tag by the time the fetch arrives.
  const selection = { account_id: accountId, target_id: siteUrl, target_name: siteUrl, verification_token: token }
  const revision = await storeIntegration(env.DB, organizationId, 'google_search_console', { ...selection, verified: false }, { revision: null })
  try {
    await publish()
    await verifySiteOwnership(accessToken, siteUrl)
    await addSearchConsoleSite(accessToken, siteUrl)
  } catch (error) {
    // A property Google would not verify is not connected: the pending record
    // goes, and the tag stops being served, before the failure is reported.
    await deleteIntegration(env.DB, organizationId, 'google_search_console', { revision })
    await publish()
    throw error
  }
  // A property KrabiClaw verified keeps its token: Google re-checks the tag and
  // drops ownership if it stops being served.
  await storeIntegration(env.DB, organizationId, 'google_search_console', { ...selection, verified: true }, { revision })
}

export interface SearchAnalyticsInput {
  startDate: string
  endDate: string
  dimensions: Array<'query' | 'page' | 'country' | 'device' | 'date' | 'searchAppearance'>
  /** Every filter must match. */
  filters: Array<{ dimension: 'query' | 'page' | 'country' | 'device' | 'searchAppearance'; operator: 'equals' | 'notEquals' | 'contains' | 'notContains' | 'includingRegex' | 'excludingRegex'; expression: string }>
  searchType: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews'
  /** final: finished days only; all: also the days Google is still finalizing. */
  dataState: 'final' | 'all'
  /** auto lets Google choose; byPage counts a page once per result; byProperty counts the property once. */
  aggregationType: 'auto' | 'byPage' | 'byProperty'
  rowLimit: number
  startRow: number
}

export interface SearchAnalyticsRow {
  keys: Record<string, string>
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/** Organic clicks, impressions, CTR and average position through `searchanalytics.query`. */
export async function querySearchAnalytics(accessToken: string, siteUrl: string, input: SearchAnalyticsInput): Promise<{ rows: SearchAnalyticsRow[]; aggregationType: string | null }> {
  const response = await googleJson<{
    rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>
    responseAggregationType?: string
  }>(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      startDate: input.startDate,
      endDate: input.endDate,
      dimensions: input.dimensions,
      type: input.searchType,
      dataState: input.dataState,
      aggregationType: input.aggregationType,
      rowLimit: input.rowLimit,
      startRow: input.startRow,
      ...(input.filters.length ? { dimensionFilterGroups: [{ groupType: 'and', filters: input.filters }] } : {}),
    }),
  })
  return {
    rows: (response.rows ?? []).map((row) => {
      if (row.keys?.length !== input.dimensions.length || typeof row.clicks !== 'number' || typeof row.impressions !== 'number' || typeof row.ctr !== 'number' || typeof row.position !== 'number') {
        throw new Error(`Search Console returned an incomplete row for ${siteUrl}`)
      }
      return { keys: Object.fromEntries(input.dimensions.map((dimension, index) => [dimension, row.keys![index]!])), clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position }
    }),
    aggregationType: response.responseAggregationType ?? null,
  }
}
