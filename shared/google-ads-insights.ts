import { z } from 'zod'

const count = z.number().int().nonnegative()

/**
 * The connected Google Ads account's results for a date range, read live from
 * Google and never stored. Money is in micros of the account's currency, as
 * Google reports it. Any other state names why there is no report.
 */
export const googleAdsInsightsSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('connected'),
    customer: z.object({ id: z.string(), name: z.string(), currency: z.string() }),
    period: z.object({ startDate: z.string(), endDate: z.string() }),
    totals: z.object({ costMicros: count, clicks: count, impressions: count, conversions: z.number().nonnegative(), averageCpcMicros: count }),
    campaigns: z.array(z.object({ id: z.string(), name: z.string(), status: z.string(), costMicros: count, clicks: count, impressions: count, conversions: z.number().nonnegative() })),
    /** Whether Chris and Julia manage these campaigns under the managed-ads agreement. */
    managed: z.boolean(),
  }),
  z.object({
    status: z.enum(['not_connected', 'account_unlinked']),
    message: z.string(),
  }),
])
export type GoogleAdsInsights = z.infer<typeof googleAdsInsightsSchema>
