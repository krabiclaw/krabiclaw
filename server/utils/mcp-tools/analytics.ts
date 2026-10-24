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
]

export async function handleAnalyticsTools(ctx: McpExecutorContext): Promise<unknown> {
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
