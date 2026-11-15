import type { McpToolDefinition } from './shared'
import { organizationTool } from './shared'
import { z } from 'zod'
import { INSIGHTS_KINDS, INSIGHTS_STORED_PAGE_IDS, insightsPageSchema } from '~/shared/insights'
import type { McpExecutorContext } from './execution'
import { NOT_HANDLED, optionalString } from './execution'
import { readInsightsPage } from '~/server/domain/insights'
import { queryFirst } from '~/server/db'
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
    description: 'Read one Insights page, as the dashboard shows it: its headline numbers, each one by day, and its list, every number written as the page shows it. Pages: rating and reviews, occupancy or bookings, cancellations, length of stay, party size, nightly rate or average value, income by channel, booking conversion (with website clicks to book, call or order), lead time, returning guests, page views, top pages and sources.',
    domain: 'analytics',
    minimumRole: 'admin',
    required: ['page'],
    inputSchema: {
      page: { type: 'string', enum: INSIGHTS_STORED_PAGE_IDS, description: 'The page, as section/page.' },
      kind: { type: 'string', enum: ['all', ...INSIGHTS_KINDS], description: 'What is booked: stay, experience, service (consultations) or table. Default all. Not read by page views, top pages and sources.' },
      location_id: { type: 'string', description: 'One location. Read by rating, Bookings & rates, lead time and returning pages only.' },
      start_date: { type: 'string', description: 'Inclusive local start date in YYYY-MM-DD format. Defaults to 29 days before end_date.' },
      end_date: { type: 'string', description: 'Inclusive local end date in YYYY-MM-DD format. Defaults to today.' },
    },
    outputSchema: z.toJSONSchema(insightsPageSchema),
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
  if (ctx.toolName !== 'get_organization_analytics') return NOT_HANDLED
  const organization = await queryFirst<{ slug: string; timezone: string; default_currency: string }>(ctx.organization.db, 'SELECT slug, timezone, default_currency FROM organization WHERE id = ?', [ctx.organization.organizationId])
  if (!organization) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
  // The tool's minimum role reads analytics: every page, every visit.
  return await readInsightsPage(ctx.organization.db, {
    organizationId: ctx.organization.organizationId, slug: organization.slug, timezone: organization.timezone, defaultCurrency: organization.default_currency, userId: '', analytics: true,
  }, String(ctx.args.page ?? ''), {
    kind: optionalString(ctx.args, 'kind') ?? undefined,
    location_id: optionalString(ctx.args, 'location_id') ?? undefined,
    start_date: optionalString(ctx.args, 'start_date') ?? undefined,
    end_date: optionalString(ctx.args, 'end_date') ?? undefined,
  }, ctx.organization.env)
}
