import { z } from 'zod'
import type { OnboardingFlow, OnboardingStep, OnboardingStepId } from '~/shared/onboarding-flow'
import { platformLocale } from '~/shared/platform-locales'
import { isCurrencyCode } from '~/shared/currencies'
import { isValidTimezone } from '~/utils/timezone'
import { toE164 } from '~/utils/phone'
import { ALL_VERTICALS, type OrganizationVertical } from '~/utils/vertical-copy'

const presentation: Record<OrganizationVertical, Omit<OnboardingFlow['businessTypes'][number], 'value'>> = {
  restaurant: {
    label: 'Restaurant, café or bar',
    icon: 'i-lucide-utensils',
    example: { name: 'Kikuzuki', image: '/images/products/kikuzuki.png' },
  },
  experience: {
    label: 'Experience or activity',
    icon: 'i-lucide-ticket',
    example: { name: 'Pottery House Krabi', image: '/images/products/pottery-house-website.webp' },
  },
  service: {
    label: 'Law firm or legal practice',
    icon: 'i-lucide-briefcase',
    example: { name: 'North Carolina Legal Services', image: '/images/products/ncls.jpg' },
  },
  lodging: {
    label: 'Lodging or vacation rentals',
    icon: 'i-lucide-house',
    example: { name: 'Saltleaf Stays', image: '/images/products/saltleaf-stays-website.webp' },
  },
}

export const onboardingAnswers = z.object({
  vertical: z.enum(ALL_VERTICALS).nullable(),
  source: z.enum(['google_places', 'manual']).nullable(),
  placeId: z.string().nullable(),
  name: z.string(),
  sourceLocale: z.string().nullable(),
  streetAddress: z.string(),
  city: z.string(),
  country: z.string(),
  timezone: z.string(),
  currency: z.string().nullable(),
  phone: z.string(),
  productCount: z.number().int().nonnegative(),
  heroHeadline: z.string(),
})

export function onboardingOffersProducts(vertical: OrganizationVertical | null) {
  return vertical === 'restaurant' || vertical === 'experience'
}

export function onboardingFlow(answers: z.infer<typeof onboardingAnswers>): OnboardingFlow {
  const steps: OnboardingStep[] = []
  function add(
    id: OnboardingStepId,
    title: string,
    complete: boolean,
    options: { optional?: true; nextLabel?: string; save?: true; action?: 'commit' } = {},
  ) {
    const { optional, nextLabel = optional && !complete ? 'Skip for now' : 'Next', ...actions } = options
    steps.push({ id, title, nextLabel, canAdvance: complete || Boolean(optional), ...actions })
  }

  add('type', 'What kind of business do you run?', answers.vertical !== null, { nextLabel: 'Continue' })
  add('language', 'Website language', answers.sourceLocale !== null && Boolean(platformLocale(answers.sourceLocale)))
  add('business', 'Business name', Boolean(answers.name.trim()) && (answers.source === 'manual' || (
    answers.source === 'google_places' && Boolean(answers.placeId)
  )))
  add('location', 'Business address', Boolean(answers.streetAddress.trim() || answers.city.trim() || answers.country.trim()), { optional: true })
  add('hours', 'Hours and time zone', isValidTimezone(answers.timezone.trim()), { nextLabel: 'Save hours' })
  add('currency', 'Pricing currency', isCurrencyCode(answers.currency), { save: true })
  add('contact', 'Business phone', toE164(answers.phone) !== null, { optional: true, save: true })
  if (onboardingOffersProducts(answers.vertical)) {
    add('products', answers.vertical === 'restaurant' ? 'Menu' : 'Experiences', answers.productCount > 0, { optional: true, save: true })
  }
  add('look', 'Website design', Boolean(answers.heroHeadline.trim()), { optional: true, save: true })
  add('review', 'Review your website', true, { save: true, action: 'commit', nextLabel: 'Create my site' })

  const incomplete = steps.find(step => !step.canAdvance)
  return {
    steps,
    resumeStep: incomplete?.id ?? 'review',
    canSave: !incomplete,
    businessTypes: ALL_VERTICALS.map(value => ({ value, ...presentation[value] })),
  }
}
