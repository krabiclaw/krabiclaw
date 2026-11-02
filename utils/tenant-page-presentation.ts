// Which component draws a block.
//
// A page is an ordered list of typed blocks. The block says what the content
// *is* — a hero, a feature grid, a question set. KrabiClaw's own marketing site
// draws them one way; every customer site draws them the same other way, and
// its look comes from its site settings, not from its vertical.
//
// Absence of an entry means the renderer's generic markup.

import { defineAsyncComponent, type Component } from 'vue'
import type { TenantPageBlock, TenantPageBlockType } from '~/utils/tenant-page-blocks'
import type { PublicTemplateSlug } from '~/utils/template-registry'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'

type BlockPresentation = Component<{ block: TenantPageBlock, page: PublicTenantPage }>

const feedOrBlock = (component: unknown) => component as BlockPresentation

const PRESENTATIONS: Readonly<Record<string, BlockPresentation>> = {
  // KrabiClaw's own platform marketing template.
  'platform:hero': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformMarketingHero.vue')),
  'platform:button_group': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformProductNavigation.vue')),
  'platform:feature_grid': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformFeatureCards.vue')),
  'platform:comparison': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformComparison.vue')),
  'platform:stat_grid': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformProofBand.vue')),
  'platform:workflow_grid': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformWorkflows.vue')),
  'platform:showcase': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformShowcase.vue')),
  'platform:media_text': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformMediaFeature.vue')),
  'platform:callout': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformSeoBand.vue')),
  'platform:how_to': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformPluginSections.vue')),
  'platform:markdown': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformProseCard.vue')),
  'platform:faq': defineAsyncComponent(() => import('~/components/tenant/TenantFaqBlock.vue')),
  'platform:cta': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformBottomCta.vue')),
  'platform:social_posts': feedOrBlock(defineAsyncComponent(() => import('~/components/social/SocialPosts.vue'))),
  'platform:language_reach': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformLanguageReach.vue')),
  'platform:steps': defineAsyncComponent(() => import('~/components/platform/marketing/PlatformSteps.vue')),

  // Every customer site draws its blocks the same way, whatever its vertical.
  'tenant:hero': defineAsyncComponent(() => import('~/components/tenant/TenantHeroBlock.vue')),
  'tenant:product_grid': defineAsyncComponent(() => import('~/components/tenant/TenantProductGridBlock.vue')),
  'tenant:location_grid': defineAsyncComponent(() => import('~/components/tenant/TenantLocationsGridBlock.vue')),
  'tenant:feature_grid': defineAsyncComponent(() => import('~/components/tenant/TenantFeatureGridBlock.vue')),
  'tenant:team_grid': defineAsyncComponent(() => import('~/components/tenant/TenantTeamBlock.vue')),
  'tenant:stat_grid': defineAsyncComponent(() => import('~/components/tenant/TenantStatGridBlock.vue')),
  'tenant:page_grid': defineAsyncComponent(() => import('~/components/tenant/TenantServicesBlock.vue')),
  'tenant:media_text': defineAsyncComponent(() => import('~/components/tenant/TenantMediaTextBlock.vue')),
  'tenant:faq': defineAsyncComponent(() => import('~/components/tenant/TenantFaqBlock.vue')),
  'tenant:testimonial_grid': defineAsyncComponent(() => import('~/components/tenant/TenantReviewsBlock.vue')),
  'tenant:cta': defineAsyncComponent(() => import('~/components/tenant/TenantCtaBlock.vue')),
  'tenant:booking_cta': defineAsyncComponent(() => import('~/components/tenant/TenantCtaBlock.vue')),
  'tenant:contact_cta': defineAsyncComponent(() => import('~/components/tenant/TenantCtaBlock.vue')),
  'tenant:donation_choices': defineAsyncComponent(() => import('~/components/tenant/TenantDonationChoicesBlock.vue')),
  'tenant:video_feature': defineAsyncComponent(() => import('~/components/tenant/TenantMediaTextBlock.vue')),
  'tenant:button_group': defineAsyncComponent(() => import('~/components/tenant/TenantButtonGroupBlock.vue')),
  'tenant:contact_form': defineAsyncComponent(() => import('~/components/tenant/TenantContactFormBlock.vue')),
  'tenant:social_posts': feedOrBlock(defineAsyncComponent(() => import('~/components/social/SocialPosts.vue'))),
}

/** The component this template draws this block with, or null for the default. */
export function tenantPageBlockPresentation(
  template: PublicTemplateSlug,
  type: TenantPageBlockType,
): BlockPresentation | null {
  return PRESENTATIONS[`${template === 'platform' ? 'platform' : 'tenant'}:${type}`] ?? null
}
