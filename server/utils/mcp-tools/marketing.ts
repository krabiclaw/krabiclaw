import type { McpToolDefinition } from './shared'
import { organizationTool } from './shared'
import type { McpExecutorContext } from './execution'
import { NOT_HANDLED, optionalString, requiredString } from './execution'
import { resolveGoogleAdsCredentials } from './google-ads'
import {
  cloneGoogleAdsCampaign,
  createGoogleAdsSearchCampaign,
} from '~/server/utils/google-ads'
import { createPost } from '~/server/utils/post-management'
import { getSocialConnections, publishPost, type PublishTarget, type SocialChannel } from '~/server/utils/social-publication'
import { updateOrganizationSettingsFields } from '~/server/utils/organization-settings'
import { findOrganizationById } from '~/server/utils/member-access'
import { dashboardOrigin } from '~/server/utils/dashboard-notification-links'
import type { CloudflareEnv } from '~/server/utils/auth'

export const MARKETING_TOOLS: McpToolDefinition[] = [
  organizationTool({
    name: 'launch_omnichannel_campaign',
    description: 'Launch and coordinate an omnichannel marketing campaign across Google Ads (search campaign create or clone), social channels (Instagram, Facebook, Discord), and on-site visitor announcements.',
    domain: 'marketing',
    minimumRole: 'admin',
    requiredEntitlement: 'marketing',
    required: ['campaign_title', 'target_url'],
    inputSchema: {
      campaign_title: {
        type: 'string',
        description: 'Human-readable name or theme for the marketing campaign.',
      },
      target_url: {
        type: 'string',
        description: 'Destination URL (e.g. newly published blog post, product, or landing page).',
      },
      google_ads: {
        type: 'object',
        description: 'Optional Google Ads Search campaign creation or cloning configuration.',
        properties: {
          mode: {
            type: 'string',
            enum: ['clone', 'create'],
            description: 'Whether to clone an existing high-performing campaign or create a new search campaign.',
          },
          source_campaign_id: {
            type: 'string',
            description: 'Numeric campaign ID of the template campaign to clone (required when mode is "clone").',
          },
          new_campaign_name: {
            type: 'string',
            description: 'Optional campaign name. Defaults to "<campaign_title> - Search".',
          },
          daily_budget_micros: {
            type: 'integer',
            minimum: 1000000,
            description: 'Daily budget in micros (e.g. 10000000 for 10 units in account currency).',
          },
          headline_replacements: {
            type: 'object',
            description: 'Optional keyword/phrase replacements for ad copy headlines when cloning.',
          },
          additional_keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional additional keywords to include.',
          },
          keywords: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                match_type: { type: 'string', enum: ['EXACT', 'PHRASE', 'BROAD'] },
              },
              required: ['text'],
            },
            description: 'Keywords to target when mode is "create".',
          },
          headlines: {
            type: 'array',
            items: { type: 'string', maxLength: 30 },
            description: 'Responsive Search Ad headlines (min 3) when mode is "create".',
          },
          descriptions: {
            type: 'array',
            items: { type: 'string', maxLength: 90 },
            description: 'Responsive Search Ad descriptions (min 2) when mode is "create".',
          },
          status: {
            type: 'string',
            enum: ['ENABLED', 'PAUSED'],
            description: 'Initial campaign status (defaults to PAUSED).',
          },
        },
        required: ['mode'],
      },
      social_post: {
        type: 'object',
        description: 'Optional social media broadcast across Facebook, Instagram, or Discord.',
        properties: {
          channels: {
            type: 'array',
            items: { type: 'string', enum: ['facebook', 'instagram', 'discord'] },
            description: 'Target social channels. Defaults to all currently connected channels.',
          },
          caption: {
            type: 'string',
            description: 'Post text / caption for social channels.',
          },
          media_asset_id: {
            type: 'string',
            description: 'Optional media asset ID to attach as post image or video.',
          },
        },
        required: ['caption'],
      },
      website_announcement: {
        type: 'object',
        description: 'Optional on-site visitor announcement banner/popup.',
        properties: {
          headline: { type: 'string', description: 'Announcement modal title.' },
          description: { type: 'string', description: 'Optional announcement message details.' },
          cta_label: { type: 'string', description: 'Call-to-action button text.' },
          cta_url: { type: 'string', description: 'Call-to-action link destination (defaults to target_url).' },
          dismissible: { type: 'boolean', description: 'Whether the announcement can be dismissed by visitors (default true).' },
          enabled: { type: 'boolean', description: 'Whether the announcement is active immediately (default true).' },
          format: { type: 'string', enum: ['modal', 'banner'], description: 'Whether to present as a top banner or a popup modal (default modal).' },
        },
        required: ['headline'],
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        campaign_title: { type: 'string' },
        target_url: { type: 'string' },
        google_ads: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            campaign_id: { type: 'string' },
            resource_name: { type: 'string' },
            error: { type: 'string' },
          },
        },
        social: {
          type: 'object',
          properties: {
            post_id: { type: 'string' },
            published: { type: 'boolean' },
            outcomes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  channel: { type: 'string' },
                  status: { type: 'string' },
                  public_url: { type: ['string', 'null'] },
                  message: { type: 'string' },
                },
                required: ['channel', 'status'],
              },
            },
            error: { type: 'string' },
          },
        },
        website_announcement: {
          type: 'object',
          properties: {
            headline: { type: 'string' },
            enabled: { type: 'boolean' },
            cta_url: { type: ['string', 'null'] },
            error: { type: 'string' },
          },
        },
      },
      required: ['ok', 'campaign_title', 'target_url'],
    },
  }),
]

export async function handleMarketingTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  if (toolName !== 'launch_omnichannel_campaign') return NOT_HANDLED

  const campaignTitle = requiredString(args, 'campaign_title')
  const targetUrl = requiredString(args, 'target_url')
  const googleAdsInput = args.google_ads as Record<string, unknown> | undefined
  const socialInput = args.social_post as Record<string, unknown> | undefined
  const announcementInput = args.website_announcement as Record<string, unknown> | undefined

  let adsResult: Record<string, unknown> | undefined
  let socialResult: Record<string, unknown> | undefined
  let announcementResult: Record<string, unknown> | undefined

  // 1. Google Ads Search Campaign
  if (googleAdsInput) {
    try {
      const { accessToken, developerToken, customerId } = await resolveGoogleAdsCredentials(ctx)
      const mode = String(googleAdsInput.mode)
      const campaignName = (googleAdsInput.new_campaign_name as string) || `${campaignTitle} - Search`
      const status = (googleAdsInput.status as 'ENABLED' | 'PAUSED') ?? 'PAUSED'

      if (mode === 'clone') {
        const sourceCampaignId = String(googleAdsInput.source_campaign_id)
        if (!sourceCampaignId) throw new Error('source_campaign_id is required when mode is "clone"')
        const res = await cloneGoogleAdsCampaign(accessToken, developerToken, customerId, {
          sourceCampaignId,
          newCampaignName: campaignName,
          targetUrl,
          dailyBudgetAmountMicros: googleAdsInput.daily_budget_micros !== undefined ? Number(googleAdsInput.daily_budget_micros) : undefined,
          headlineReplacements: googleAdsInput.headline_replacements as Record<string, string> | undefined,
          additionalKeywords: googleAdsInput.additional_keywords as string[] | undefined,
          status,
        })
        adsResult = {
          status: res.status,
          campaign_id: res.campaignId,
          resource_name: res.resourceName,
        }
      } else if (mode === 'create') {
        const keywordsInput = (googleAdsInput.keywords as Array<{ text: string; match_type?: 'EXACT' | 'PHRASE' | 'BROAD' }>) ?? []
        const keywords = keywordsInput.map(k => ({
          text: k.text,
          matchType: k.match_type ?? 'PHRASE',
        }))
        const headlines = (googleAdsInput.headlines as string[]) ?? [
          campaignTitle.slice(0, 30),
          'Official Website',
          'Explore Our Latest Updates',
        ]
        const descriptions = (googleAdsInput.descriptions as string[]) ?? [
          'Discover our latest story and updates online today.',
          'Experience quality service and book directly with us.',
        ]
        const dailyBudgetAmountMicros = Number(googleAdsInput.daily_budget_micros || 10_000_000)

        const res = await createGoogleAdsSearchCampaign(accessToken, developerToken, customerId, {
          name: campaignName,
          dailyBudgetAmountMicros,
          targetUrl,
          keywords,
          headlines,
          descriptions,
          status,
        })
        adsResult = {
          status: res.status,
          campaign_id: res.campaignId,
          resource_name: res.resourceName,
        }
      }
    } catch (error) {
      adsResult = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // 2. Social Media Publication
  if (socialInput) {
    try {
      const caption = requiredString(socialInput, 'caption')
      const idempotencyKey = `marketing-${organization.organizationId}-${Date.now()}`
      const env = organization.env as CloudflareEnv
      const { post } = await createPost(
        organization.db,
        env,
        organization.organizationId,
        {
          idempotencyKey,
          post: {
            body: caption,
            ...(socialInput.media_asset_id ? {
              media: [{
                asset_id: String(socialInput.media_asset_id),
                slot: 'cover' as const,
                sort_order: 0,
              }],
            } : {}),
          },
        },
        organization.userId,
      )

      // Determine destinations
      const orgRecord = await findOrganizationById(env, organization.organizationId)
      const dashboardBase = orgRecord ? dashboardOrigin(env, { orgSlug: orgRecord.slug, locationSlug: null }) : ''
      const connections = await getSocialConnections(env, organization.organizationId, { dashboardBase })
      const requestedChannels = socialInput.channels as SocialChannel[] | undefined
      const targets: PublishTarget[] = []

      for (const conn of connections.channels) {
        if (!conn.connected || !conn.target_id || !conn.connection_revision) continue
        if (requestedChannels && !requestedChannels.includes(conn.channel)) continue
        targets.push({
          channel: conn.channel,
          target_id: conn.target_id,
          connection_revision: conn.connection_revision,
        })
      }

      if (targets.length > 0) {
        const pubResult = await publishPost(
          env,
          organization.organizationId,
          post.id,
          {
            expectedUpdatedAt: post.updated_at,
            targets,
          },
          organization.userId,
        )
        socialResult = {
          post_id: post.id,
          published: pubResult.ok,
          outcomes: pubResult.outcomes.map(o => ({
            channel: o.channel,
            status: o.status,
            public_url: o.public_url ?? null,
            message: o.message,
          })),
        }
      } else {
        socialResult = {
          post_id: post.id,
          published: false,
          outcomes: [],
          message: 'No connected social channels found to publish to. Connect Facebook, Instagram, or Discord in Settings -> Integrations.',
        }
      }
    } catch (error) {
      socialResult = {
        published: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // 3. Website Announcement Modal
  if (announcementInput) {
    try {
      const headline = requiredString(announcementInput, 'headline')
      const announcement = {
        headline,
        description: optionalString(announcementInput, 'description') ?? null,
        cta_label: optionalString(announcementInput, 'cta_label') ?? 'Learn More',
        cta_url: optionalString(announcementInput, 'cta_url') ?? targetUrl,
        dismissible: announcementInput.dismissible !== false,
        enabled: announcementInput.enabled !== false,
        format: (optionalString(announcementInput, 'format') === 'banner' ? 'banner' : 'modal') as 'modal' | 'banner',
      }

      await updateOrganizationSettingsFields(
        organization.db,
        organization.env,
        organization.organizationId,
        { announcement },
        organization.userId,
      )

      announcementResult = {
        headline: announcement.headline,
        enabled: announcement.enabled,
        cta_url: announcement.cta_url,
      }
    } catch (error) {
      announcementResult = {
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return {
    ok: true,
    campaign_title: campaignTitle,
    target_url: targetUrl,
    ...(adsResult ? { google_ads: adsResult } : {}),
    ...(socialResult ? { social: socialResult } : {}),
    ...(announcementResult ? { website_announcement: announcementResult } : {}),
  }
}
