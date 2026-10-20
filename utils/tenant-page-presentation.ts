// Which component draws a block.
//
// A page is an ordered list of typed blocks. The block says what the content
// *is* — a hero, a feature grid, a question set. KrabiClaw's own marketing site
// draws them one way; every customer site draws them the same other way, and
// its look comes from its site settings, not from its vertical.
//
// Absence of an entry means the renderer's generic markup.

import type { Component } from 'vue'
import type { TenantPageBlock, TenantPageBlockType } from '~/utils/tenant-page-blocks'
import type { PublicTemplateSlug } from '~/utils/template-registry'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import PlatformMarketingHero from '~/components/platform/marketing/PlatformMarketingHero.vue'
import PlatformFeatureCards from '~/components/platform/marketing/PlatformFeatureCards.vue'
import PlatformShowcase from '~/components/platform/marketing/PlatformShowcase.vue'
import PlatformMediaFeature from '~/components/platform/marketing/PlatformMediaFeature.vue'
import PlatformLanguageReach from '~/components/platform/marketing/PlatformLanguageReach.vue'
import PlatformSteps from '~/components/platform/marketing/PlatformSteps.vue'
import PlatformProductNavigation from '~/components/platform/marketing/PlatformProductNavigation.vue'
import PlatformComparison from '~/components/platform/marketing/PlatformComparison.vue'
import PlatformProofBand from '~/components/platform/marketing/PlatformProofBand.vue'
import PlatformWorkflows from '~/components/platform/marketing/PlatformWorkflows.vue'
import PlatformSeoBand from '~/components/platform/marketing/PlatformSeoBand.vue'
import PlatformPluginSections from '~/components/platform/marketing/PlatformPluginSections.vue'
import PlatformProseCard from '~/components/platform/marketing/PlatformProseCard.vue'
import PlatformBottomCta from '~/components/platform/marketing/PlatformBottomCta.vue'
import SocialPosts from '~/components/social/SocialPosts.vue'
import TenantHeroBlock from '~/components/tenant/TenantHeroBlock.vue'
import TenantFeatureGridBlock from '~/components/tenant/TenantFeatureGridBlock.vue'
import TenantTeamBlock from '~/components/tenant/TenantTeamBlock.vue'
import TenantStatGridBlock from '~/components/tenant/TenantStatGridBlock.vue'
import TenantServicesBlock from '~/components/tenant/TenantServicesBlock.vue'
import TenantProductGridBlock from '~/components/tenant/TenantProductGridBlock.vue'
import TenantLocationsGridBlock from '~/components/tenant/TenantLocationsGridBlock.vue'
import TenantFaqBlock from '~/components/tenant/TenantFaqBlock.vue'
import TenantReviewsBlock from '~/components/tenant/TenantReviewsBlock.vue'
import TenantCtaBlock from '~/components/tenant/TenantCtaBlock.vue'
import TenantDonationChoicesBlock from '~/components/tenant/TenantDonationChoicesBlock.vue'
import TenantMediaTextBlock from '~/components/tenant/TenantMediaTextBlock.vue'
import TenantButtonGroupBlock from '~/components/tenant/TenantButtonGroupBlock.vue'
import TenantContactFormBlock from '~/components/tenant/TenantContactFormBlock.vue'

type BlockPresentation = Component<{ block: TenantPageBlock, page: PublicTenantPage }>

const feedOrBlock = (component: unknown) => component as BlockPresentation

const PRESENTATIONS: Readonly<Record<string, BlockPresentation>> = {
  // KrabiClaw's own platform marketing template.
  'platform:hero': PlatformMarketingHero,
  'platform:button_group': PlatformProductNavigation,
  'platform:feature_grid': PlatformFeatureCards,
  'platform:comparison': PlatformComparison,
  'platform:stat_grid': PlatformProofBand,
  'platform:workflow_grid': PlatformWorkflows,
  'platform:showcase': PlatformShowcase,
  'platform:media_text': PlatformMediaFeature,
  'platform:callout': PlatformSeoBand,
  'platform:how_to': PlatformPluginSections,
  'platform:markdown': PlatformProseCard,
  'platform:faq': TenantFaqBlock,
  'platform:cta': PlatformBottomCta,
  'platform:social_posts': feedOrBlock(SocialPosts),
  'platform:language_reach': PlatformLanguageReach,
  'platform:steps': PlatformSteps,

  // Every customer site draws its blocks the same way, whatever its vertical.
  'tenant:hero': TenantHeroBlock,
  'tenant:product_grid': TenantProductGridBlock,
  'tenant:location_grid': TenantLocationsGridBlock,
  'tenant:feature_grid': TenantFeatureGridBlock,
  'tenant:team_grid': TenantTeamBlock,
  'tenant:stat_grid': TenantStatGridBlock,
  'tenant:page_grid': TenantServicesBlock,
  'tenant:media_text': TenantMediaTextBlock,
  'tenant:faq': TenantFaqBlock,
  'tenant:testimonial_grid': TenantReviewsBlock,
  'tenant:cta': TenantCtaBlock,
  'tenant:booking_cta': TenantCtaBlock,
  'tenant:contact_cta': TenantCtaBlock,
  'tenant:donation_choices': TenantDonationChoicesBlock,
  'tenant:video_feature': TenantMediaTextBlock,
  'tenant:button_group': TenantButtonGroupBlock,
  'tenant:contact_form': TenantContactFormBlock,
  'tenant:social_posts': feedOrBlock(SocialPosts),
}

/** The component this template draws this block with, or null for the default. */
export function tenantPageBlockPresentation(
  template: PublicTemplateSlug,
  type: TenantPageBlockType,
): BlockPresentation | null {
  return PRESENTATIONS[`${template === 'platform' ? 'platform' : 'tenant'}:${type}`] ?? null
}
