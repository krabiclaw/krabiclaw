import { linkedAccountAccessToken, type CloudflareEnv } from './auth'
import { storeIntegration } from './organization-integrations'

/**
 * Google Analytics as a product of its own, over a Better Auth linked Google
 * account. This module owns the GA4 property the tenant picked, the
 * measurement id derived from it, and the `account_id` it was picked through;
 * the account and its tokens are Better Auth's.
 *
 * The measurement id is what Zaraz serves. There is one way to write it,
 * which is choosing a property here.
 */

export interface Ga4Property {
  accountName: string
  propertyId: string
  propertyName: string
}

const googleJson = async <T>(url: string, accessToken: string): Promise<T> => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`)
  }
  return (await response.json()) as T
}

/** The GA4 properties the connected account can read. */
export async function listGa4Properties(accessToken: string): Promise<Ga4Property[]> {
  const response = await googleJson<{
    accountSummaries?: Array<{
      account: string
      displayName: string
      propertySummaries?: Array<{ property: string; displayName: string }>
    }>
  }>('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', accessToken)

  const properties: Ga4Property[] = []
  for (const account of response.accountSummaries ?? []) {
    for (const property of account.propertySummaries ?? []) {
      properties.push({
        accountName: account.displayName,
        propertyId: property.property.replace(/^properties\//, ''),
        propertyName: property.displayName,
      })
    }
  }
  return properties
}

/**
 * The property's web data stream measurement id — what the page actually
 * needs, so the tenant is never asked to go and find a `G-XXXXXXX` themselves.
 */
export async function getGa4MeasurementId(accessToken: string, propertyId: string): Promise<string | null> {
  const response = await googleJson<{ dataStreams?: Array<{ webStreamData?: { measurementId?: string } }> }>(
    `https://analyticsadmin.googleapis.com/v1beta/properties/${propertyId}/dataStreams?pageSize=200`, accessToken,
  )
  for (const stream of response.dataStreams ?? []) {
    if (stream.webStreamData?.measurementId) return stream.webStreamData.measurementId
  }
  return null
}

/** Picks the property and resolves its measurement id in one step. */
export async function selectAnalyticsProperty(
  env: CloudflareEnv,
  organizationId: string,
  accountId: string,
  propertyId: string,
  propertyName: string,
  expected: { revision: string | null },
): Promise<string> {
  const { accessToken } = await linkedAccountAccessToken(env, accountId)
  const measurementId = await getGa4MeasurementId(accessToken, propertyId)
  if (!measurementId) {
    throw new Error('That property has no web data stream, so there is no measurement ID to collect with.')
  }
  await storeIntegration(env.DB, organizationId, 'google_analytics', {
    account_id: accountId, target_id: propertyId, target_name: propertyName, measurement_id: measurementId,
  }, expected)
  return measurementId
}

export interface Ga4ReportInput {
  dateRanges: Array<{ startDate: string; endDate: string; name?: string }>
  dimensions: string[]
  metrics: string[]
  /** Every filter must match: a dimension's value, compared as `match` says. */
  filters: Array<{ dimension: string; match: 'EXACT' | 'BEGINS_WITH' | 'ENDS_WITH' | 'CONTAINS' | 'FULL_REGEXP'; value: string }>
  orderBy: { field: string; kind: 'metric' | 'dimension'; desc: boolean } | null
  limit: number
  offset: number
}

export interface Ga4Report {
  rows: Array<{ dimensions: Record<string, string>; metrics: Record<string, number> }>
  rowCount: number
  timeZone: string
  currencyCode: string
  /** GA4's token allowance for the property, as the report left it. */
  propertyQuota: Record<string, { consumed?: number; remaining?: number }> | null
}

/**
 * A GA4 report through the Data API's `properties.runReport`. More than one
 * date range adds GA4's own `dateRange` dimension, naming each row's range.
 */
export async function runGa4Report(accessToken: string, propertyId: string, input: Ga4ReportInput): Promise<Ga4Report> {
  if (!/^\d+$/u.test(propertyId)) throw new Error(`GA4 property id must be numeric: ${propertyId}`)
  const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      dateRanges: input.dateRanges,
      dimensions: input.dimensions.map(name => ({ name })),
      metrics: input.metrics.map(name => ({ name })),
      ...(input.filters.length ? { dimensionFilter: { andGroup: { expressions: input.filters.map(filter => ({ filter: { fieldName: filter.dimension, stringFilter: { matchType: filter.match, value: filter.value } } })) } } } : {}),
      ...(input.orderBy ? { orderBys: [{ desc: input.orderBy.desc, ...(input.orderBy.kind === 'metric' ? { metric: { metricName: input.orderBy.field } } : { dimension: { dimensionName: input.orderBy.field } }) }] } : {}),
      limit: input.limit,
      offset: input.offset,
      returnPropertyQuota: true,
    }),
  })
  if (!response.ok) throw new Error(`Google Analytics report failed (${response.status}): ${(await response.text()).slice(0, 300)}`)
  const data = await response.json() as {
    dimensionHeaders?: Array<{ name: string }>
    metricHeaders?: Array<{ name: string }>
    rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }>
    rowCount?: number
    metadata?: { timeZone?: string; currencyCode?: string }
    propertyQuota?: Record<string, { consumed?: number; remaining?: number }>
  }
  if (!data.metadata?.timeZone || !data.metadata.currencyCode) throw new Error(`Google Analytics did not report property ${propertyId}'s time zone and currency`)
  const dimensionNames = (data.dimensionHeaders ?? []).map(header => header.name)
  const metricNames = (data.metricHeaders ?? []).map(header => header.name)
  return {
    rows: (data.rows ?? []).map((row) => {
      const dimensions = dimensionNames.map(name => [name, row.dimensionValues?.[dimensionNames.indexOf(name)]?.value] as const)
      const metrics = metricNames.map(name => [name, Number(row.metricValues?.[metricNames.indexOf(name)]?.value)] as const)
      if (dimensions.some(([, value]) => typeof value !== 'string') || metrics.some(([, value]) => !Number.isFinite(value))) {
        throw new Error(`Google Analytics returned an incomplete row for property ${propertyId}`)
      }
      return { dimensions: Object.fromEntries(dimensions) as Record<string, string>, metrics: Object.fromEntries(metrics) }
    }),
    rowCount: data.rowCount ?? (data.rows?.length ?? 0),
    timeZone: data.metadata.timeZone,
    currencyCode: data.metadata.currencyCode,
    propertyQuota: data.propertyQuota ?? null,
  }
}
