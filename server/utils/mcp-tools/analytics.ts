import type { McpToolDefinition } from './shared'
import { organizationTool } from './shared'
import { ANALYTICS_QUERY_FIELDS, ANALYTICS_QUERY_METRICS } from '~/server/utils/analytics-query'
import { z } from 'zod'
import { analyticsReportSchema } from '~/shared/analytics-report'
import type { McpExecutorContext } from './execution'
import { NOT_HANDLED, optionalString } from './execution'
import { getAnalyticsReport } from '~/server/utils/analytics-report'
import { AnalyticsQueryError, queryOrganizationAnalytics, type AnalyticsQueryInput } from '~/server/utils/analytics-query'
import { MCP_ERROR, mcpProtocolError } from '~/server/utils/mcp-protocol'
import { HTTPError } from 'nitro'
import { readIntegration } from '~/server/utils/organization-integrations'
import { linkedAccountAccessToken } from '~/server/utils/auth'
import { runGa4Report, type Ga4ReportInput } from '~/server/utils/google-analytics'
import { querySearchAnalytics, type SearchAnalyticsInput } from '~/server/utils/google-search-console'

const string = { type: 'string' } as const
const nullableString = { type: ['string', 'null'] } as const

export const ANALYTICS_TOOLS: McpToolDefinition[] = [
  organizationTool({
    name: 'get_organization_analytics',
    description: 'Read website traffic, attribution, conversions, bookings, collected revenue and refunds. Amounts are minor units per currency; booking quotes are not collected revenue.',
    domain: 'analytics',
    minimumRole: 'admin',
    inputSchema: {
      start_date: { type: 'string', description: 'Inclusive local start date in YYYY-MM-DD format. Defaults to 29 days before end_date.' },
      end_date: { type: 'string', description: 'Inclusive local end date in YYYY-MM-DD format. Defaults to today.' },
    },
    outputSchema: z.toJSONSchema(analyticsReportSchema),
  }),
  organizationTool({
    name: 'query_organization_analytics',
    description: 'Read unsampled filtered events, sessions, breakdowns or daily summaries. Coverage reports missing facts; use next_cursor with the same query to continue. Event results omit unrestricted actor, custom-properties and metadata payloads.',
    domain: 'analytics',
    minimumRole: 'admin',
    required: ['mode'],
    inputSchema: {
      mode: { type: 'string', enum: ['events', 'sessions', 'breakdown', 'daily_summaries'], description: 'events | sessions | breakdown | daily_summaries' },
      start_date: { type: 'string', description: 'Inclusive local start date (YYYY-MM-DD). Defaults to 29 days before end_date.' },
      end_date: { type: 'string', description: 'Inclusive local end date (YYYY-MM-DD). Defaults to today.' },
      filters: {
        type: 'object',
        description: 'Exact-match filters (all must match). path_prefix matches the public path or anything under it. Names are the queryable fields; enumerated ones list their values.',
        additionalProperties: false,
        properties: {
          ...Object.fromEntries(Object.entries(ANALYTICS_QUERY_FIELDS).map(([name, description]) => [name, { type: 'string', description }])),
          path_prefix: { type: 'string', description: 'A public path prefix such as /th/ or /locations/main' },
          campaign_prefix: { type: 'string', description: 'Literal, case-sensitive campaign prefix under the selected attribution basis; % and _ are ordinary characters.' },
          summary_kind: { type: 'string', enum: ['organization_day', 'page_day', 'dimension_day'], description: 'daily_summaries only (required): the summary grain: one row per day, per day and public page path, or per day and country/city/device/referrer value.' },
          dimension: { type: 'string', enum: ['country', 'city', 'device', 'referrer'], description: 'daily_summaries with dimension_day: the dimension to read.' },
          value: { type: 'string', description: 'daily_summaries with dimension_day: one value of the dimension.' },
          outcome_event: { type: 'string', description: 'The outcome measured by converting_sessions and session_conversion_rate (sign_up, contact_submit, booking_submit, purchase, ...)' },
        },
      },
      attribution_basis: { type: 'string', enum: ['observed', 'event_snapshot', 'session_last_touch'], description: 'Which attribution the attribution fields read. Default event_snapshot (sessions: session_last_touch).' },
      sort: { description: 'events: occurred_at_desc (default) or occurred_at_asc. breakdown: { metric, direction } over a requested metric (default: the first metric, descending). Ties break deterministically.', oneOf: [{ type: 'string', enum: ['occurred_at_desc', 'occurred_at_asc'] }, { type: 'object', additionalProperties: false, properties: { metric: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } } }] },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Rows per page (default 50). A page size is not a total-result limit.' },
      cursor: { type: 'string', description: 'next_cursor from the previous page of this same request.' },
      dimensions: { type: 'array', items: { type: 'string', enum: Object.keys(ANALYTICS_QUERY_FIELDS) }, description: 'breakdown only: 1-6 fields to group by.' },
      metrics: { type: 'array', items: { type: 'string', enum: Object.keys(ANALYTICS_QUERY_METRICS) }, description: `breakdown only: 1-8 metrics. ${Object.entries(ANALYTICS_QUERY_METRICS).map(([name, metric]) => `${name} (${metric.unit})`).join('; ')}` },
      outcome_event: { type: 'string', description: 'The outcome measured by converting_sessions and session_conversion_rate.' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        mode: string,
        rows: { type: 'array', items: { type: 'object' } },
        next_cursor: nullableString,
        query: { type: 'object' },
        totals: { type: 'object' },
        coverage: { type: 'object' },
      },
      required: ['mode', 'rows', 'next_cursor', 'query', 'totals', 'coverage'],
    },
  }),
  organizationTool({
    name: 'query_google_analytics',
    description: 'Run a report on the connected Google Analytics 4 property: GA4 dimensions and metrics (such as date, landingPage, sessionSource, sessionMedium; activeUsers, sessions, screenPageViews, keyEvents) over one to four date ranges, with filters, ordering and paging. GA4 keeps history from before KrabiClaw; use it for periods the business\'s own analytics do not cover.',
    domain: 'analytics',
    minimumRole: 'admin',
    required: ['date_ranges', 'metrics'],
    inputSchema: {
      date_ranges: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['start_date', 'end_date'], properties: {
        start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        name: { type: 'string', maxLength: 40, description: 'Names the range in the dateRange dimension GA4 adds when there is more than one.' },
      } }, description: 'Days in the property time zone. Two ranges compare periods, such as this October and last October.' },
      dimensions: { type: 'array', maxItems: 9, items: { type: 'string', pattern: '^[A-Za-z0-9_:]+$' }, description: 'GA4 API dimension names.' },
      metrics: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', pattern: '^[A-Za-z0-9_:]+$' }, description: 'GA4 API metric names.' },
      filters: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['dimension', 'match', 'value'], properties: {
        dimension: { type: 'string', pattern: '^[A-Za-z0-9_:]+$' },
        match: { type: 'string', enum: ['EXACT', 'BEGINS_WITH', 'ENDS_WITH', 'CONTAINS', 'FULL_REGEXP'] },
        value: { type: 'string', maxLength: 500 },
      } }, description: 'Every filter must match.' },
      order_by: { type: 'object', additionalProperties: false, required: ['field', 'kind'], properties: {
        field: { type: 'string', pattern: '^[A-Za-z0-9_:]+$' }, kind: { type: 'string', enum: ['metric', 'dimension'] }, desc: { type: 'boolean', description: 'Default true.' },
      } },
      limit: { type: 'integer', minimum: 1, maximum: 10000, description: 'Rows per page (default 100).' },
      offset: { type: 'integer', minimum: 0, description: 'Rows to skip, for the next page.' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        property_id: string, time_zone: string, currency: string,
        row_count: { type: 'integer', description: 'All rows the report has; page with offset.' },
        property_quota: { type: ['object', 'null'], description: 'GA4 tokens consumed and remaining for the property after this report.' },
        rows: { type: 'array', items: { type: 'object', properties: {
          dimensions: { type: 'object', additionalProperties: string }, metrics: { type: 'object', additionalProperties: { type: 'number' } },
        }, required: ['dimensions', 'metrics'] } },
      },
      required: ['property_id', 'time_zone', 'currency', 'row_count', 'property_quota', 'rows'],
    },
  }),
  organizationTool({
    name: 'query_search_console',
    description: 'Read organic Google Search performance for the connected Search Console property: clicks, impressions, CTR and average position by query, page, country, device, date or search appearance, with filters and paging. final reads finished days only; all includes days Google is still finalizing.',
    domain: 'analytics',
    minimumRole: 'admin',
    required: ['start_date', 'end_date'],
    inputSchema: {
      start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'First day (Pacific Time, as Search Console counts).' },
      end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Last day, inclusive.' },
      dimensions: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['query', 'page', 'country', 'device', 'date', 'searchAppearance'] } },
      filters: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['dimension', 'operator', 'expression'], properties: {
        dimension: { type: 'string', enum: ['query', 'page', 'country', 'device', 'searchAppearance'] },
        operator: { type: 'string', enum: ['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'] },
        expression: { type: 'string', maxLength: 4096 },
      } }, description: 'Every filter must match.' },
      search_type: { type: 'string', enum: ['web', 'image', 'video', 'news', 'discover', 'googleNews'], description: 'Default web.' },
      data_state: { type: 'string', enum: ['final', 'all'], description: 'Default final.' },
      aggregation_type: { type: 'string', enum: ['auto', 'byPage', 'byProperty'], description: 'How results are counted: byPage counts each page; byProperty counts the site once per result. Default auto.' },
      limit: { type: 'integer', minimum: 1, maximum: 25000, description: 'Rows per page (default 1000).' },
      start_row: { type: 'integer', minimum: 0, description: 'Rows to skip, for the next page.' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        site_url: string, start_date: string, end_date: string, data_state: string, aggregation: nullableString,
        time_zone: { type: 'string', description: 'Search Console counts days in Pacific Time.' },
        next_start_row: { type: ['integer', 'null'], description: 'Set when this page is full: pass it as start_row for more. Google also omits rare queries, so a last page is not every query.' },
        rows: { type: 'array', items: { type: 'object', properties: {
          keys: { type: 'object', additionalProperties: string }, clicks: { type: 'number' }, impressions: { type: 'number' },
          ctr: { type: 'number', description: 'Clicks per impression, 0 to 1.' }, position: { type: 'number', description: 'Average position, 1 is the top.' },
        }, required: ['keys', 'clicks', 'impressions', 'ctr', 'position'] } },
      },
      required: ['site_url', 'start_date', 'end_date', 'data_state', 'aggregation', 'time_zone', 'next_start_row', 'rows'],
    },
  }),
]

/** The organization's connected Google property and a token Better Auth keeps for it. */
async function googleReportAccess(ctx: McpExecutorContext, provider: 'google_analytics' | 'google_search_console') {
  const integration = await readIntegration(ctx.organization.db, ctx.organization.organizationId, provider)
  const label = provider === 'google_analytics' ? 'Google Analytics' : 'Search Console'
  if (!integration?.account_id || !integration.target_id) {
    throw new HTTPError({ statusCode: 409, statusMessage: `${label} is not connected for this organization. Connect it in Settings -> Connections first.`, data: { code: 'INTEGRATION_NOT_CONNECTED' } })
  }
  const { accessToken } = await linkedAccountAccessToken(ctx.organization.env, integration.account_id)
  return { accessToken, target: integration.target_id }
}

export async function handleAnalyticsTools(ctx: McpExecutorContext): Promise<unknown> {
  if (ctx.toolName === 'query_google_analytics') {
    const { accessToken, target } = await googleReportAccess(ctx, 'google_analytics')
    const args = ctx.args as { date_ranges: Array<{ start_date: string; end_date: string; name?: string }>; dimensions?: string[]; metrics: string[]; filters?: Ga4ReportInput['filters']; order_by?: { field: string; kind: 'metric' | 'dimension'; desc?: boolean }; limit?: number; offset?: number }
    const report = await runGa4Report(accessToken, target, {
      dateRanges: args.date_ranges.map(range => ({ startDate: range.start_date, endDate: range.end_date, ...(range.name ? { name: range.name } : {}) })),
      dimensions: args.dimensions ?? [],
      metrics: args.metrics,
      filters: args.filters ?? [],
      orderBy: args.order_by ? { field: args.order_by.field, kind: args.order_by.kind, desc: args.order_by.desc ?? true } : null,
      limit: args.limit ?? 100,
      offset: args.offset ?? 0,
    })
    return { property_id: target, time_zone: report.timeZone, currency: report.currencyCode, row_count: report.rowCount, property_quota: report.propertyQuota, rows: report.rows }
  }
  if (ctx.toolName === 'query_search_console') {
    const { accessToken, target } = await googleReportAccess(ctx, 'google_search_console')
    const args = ctx.args as { start_date: string; end_date: string; dimensions?: SearchAnalyticsInput['dimensions']; filters?: SearchAnalyticsInput['filters']; search_type?: SearchAnalyticsInput['searchType']; data_state?: SearchAnalyticsInput['dataState']; aggregation_type?: SearchAnalyticsInput['aggregationType']; limit?: number; start_row?: number }
    const dataState = args.data_state ?? 'final'
    const rowLimit = args.limit ?? 1000
    const startRow = args.start_row ?? 0
    const result = await querySearchAnalytics(accessToken, target, {
      startDate: args.start_date, endDate: args.end_date, dimensions: args.dimensions ?? [], filters: args.filters ?? [],
      searchType: args.search_type ?? 'web', dataState, aggregationType: args.aggregation_type ?? 'auto', rowLimit, startRow,
    })
    return {
      site_url: target, start_date: args.start_date, end_date: args.end_date, data_state: dataState, aggregation: result.aggregationType,
      time_zone: 'America/Los_Angeles', next_start_row: result.rows.length === rowLimit ? startRow + rowLimit : null, rows: result.rows,
    }
  }
  if (ctx.toolName === 'query_organization_analytics') {
    const args = ctx.args
    try {
      const result = await queryOrganizationAnalytics(ctx.organization.db, {
        organizationId: ctx.organization.organizationId,
        mode: optionalString(args, 'mode') as AnalyticsQueryInput['mode'],
        startDate: optionalString(args, 'start_date') ?? undefined,
        endDate: optionalString(args, 'end_date') ?? undefined,
        filters: args.filters as Record<string, unknown> | undefined,
        attributionBasis: optionalString(args, 'attribution_basis') as AnalyticsQueryInput['attributionBasis'] ?? undefined,
        sort: args.sort as AnalyticsQueryInput['sort'],
        limit: args.limit as number | undefined,
        cursor: optionalString(args, 'cursor') ?? undefined,
        dimensions: args.dimensions as string[] | undefined,
        metrics: args.metrics as string[] | undefined,
        outcomeEvent: optionalString(args, 'outcome_event') ?? undefined,
        cursorSecret: ctx.organization.env.BETTER_AUTH_SECRET,
      })
      return { ...result, rows: result.rows.map(({ actor: _actor, properties: _properties, metadata: _metadata, ...facts }) => facts) }
    } catch (error) {
      if (error instanceof AnalyticsQueryError) throw mcpProtocolError(MCP_ERROR.invalidParams, error.message)
      throw error
    }
  }
  if (ctx.toolName !== 'get_organization_analytics') return NOT_HANDLED
  return await getAnalyticsReport(ctx.organization.db, {
    organizationId: ctx.organization.organizationId,
    startDate: optionalString(ctx.args, 'start_date') ?? undefined,
    endDate: optionalString(ctx.args, 'end_date') ?? undefined,
  }, ctx.organization.env)
}
