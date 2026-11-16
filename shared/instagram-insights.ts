import { z } from 'zod'

const metric = z.number().int().nonnegative().nullable()

/**
 * The connected Instagram professional account's insights for a date range,
 * read live from Instagram. A metric Instagram did not return is null; zero is
 * a zero Instagram reported. Any other state names why there is no report.
 */
export const instagramInsightsSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('connected'),
    username: z.string(),
    period: z.object({ startDate: z.string(), endDate: z.string(), timezone: z.string() }),
    account: z.object({
      views: metric, reach: metric, accounts_engaged: metric, total_interactions: metric,
      likes: metric, comments: metric, shares: metric, saves: metric, replies: metric, profile_links_taps: metric,
    }),
    media: z.array(z.object({
      id: z.string(),
      permalink: z.string().nullable(),
      caption: z.string().nullable(),
      mediaType: z.string(),
      productType: z.string().nullable(),
      postedAt: z.string(),
      thumbnailUrl: z.string().nullable(),
      insights: z.object({ views: metric, reach: metric, likes: metric, comments: metric, shares: metric, saved: metric, total_interactions: metric }).nullable(),
      unavailableReason: z.string().nullable(),
    })),
    moreMedia: z.boolean(),
  }),
  z.object({
    status: z.enum(['growth_plan_required', 'not_connected', 'account_unlinked', 'permission_missing']),
    message: z.string(),
  }),
])
export type InstagramInsights = z.infer<typeof instagramInsightsSchema>
