import { z } from 'zod'
import type { OnboardingFlow, OnboardingStep, OnboardingStepField } from '~/shared/onboarding-flow'
import { PLATFORM_LOCALES, platformLocale } from '~/shared/platform-locales'
import { currencyForCountry, isCurrencyCode } from '~/shared/currencies'
import { isValidTimezone, singleTimezoneForCountry } from '~/utils/timezone'
import { getPhoneCountry } from '~/utils/phone'
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
  country: z.string(),
  timezone: z.string(),
  timezoneStepVisited: z.boolean().optional(),
  currency: z.string().nullable(),
})

const locationFields: OnboardingStepField[] = [
  { key: 'country', label: 'Country' },
  { key: 'streetAddress', label: 'Street address' },
  { key: 'addressLine2', label: 'Unit, floor, or neighborhood' },
  { key: 'city', label: 'City or town' },
  { key: 'region', label: 'Province or region' },
  { key: 'postalCode', label: 'Postal code' },
]
const timezoneField: OnboardingStepField = { key: 'timezone', label: 'Time zone' }

export function onboardingFlow(answers: z.infer<typeof onboardingAnswers>): OnboardingFlow {
  const country = getPhoneCountry(answers.country)?.code ?? ''
  const proposedTimezone = singleTimezoneForCountry(country)
  const proposedCurrency = currencyForCountry(country)
  const timezoneKnown = isValidTimezone(answers.timezone || proposedTimezone)
  const askTimezone = !timezoneKnown || answers.timezoneStepVisited === true

  const steps: OnboardingStep[] = [
    {
      id: 'type', title: 'What kind of business do you run?', fields: [],
      nextLabel: 'Continue', canAdvance: answers.vertical !== null,
    },
    {
      id: 'business', title: 'What’s your business called?', fields: [{ key: 'name', label: 'Business name' }],
      nextLabel: 'Next', canAdvance: Boolean(answers.name.trim()) && (answers.source === 'manual' || (
        answers.source === 'google_places' && Boolean(answers.placeId)
      )),
    },
    {
      id: 'location', title: 'Where is your business based?',
      fields: timezoneKnown ? [...locationFields, timezoneField] : locationFields,
      nextLabel: 'Next', canAdvance: Boolean(country),
    },
  ]
  if (askTimezone) {
    steps.push({
      id: 'timezone', title: 'What time zone do you use?', fields: [timezoneField],
      nextLabel: 'Next', canAdvance: timezoneKnown,
    })
  }
  steps.push(
    {
      id: 'language', title: 'What language is your website in?', fields: [{ key: 'sourceLocale', label: 'Website language' }],
      nextLabel: 'Next', canAdvance: answers.sourceLocale !== null && Boolean(platformLocale(answers.sourceLocale)),
    },
    {
      id: 'currency', title: 'What currency do you price in?', fields: [{ key: 'currency', label: 'Pricing currency' }],
      nextLabel: 'Finish', canAdvance: isCurrencyCode(answers.currency ?? proposedCurrency), action: 'commit',
    },
  )

  const incomplete = steps.find(step => !step.canAdvance)
  return {
    steps,
    resumeStep: incomplete?.id ?? 'currency',
    canSave: !incomplete,
    exitLabel: incomplete ? 'Exit' : 'Save & exit',
    backLabel: 'Back',
    proposedTimezone,
    proposedCurrency,
    languages: PLATFORM_LOCALES.map(({ locale, label }) => ({ value: locale, label, icon: 'i-lucide-languages' })),
    businessTypes: ALL_VERTICALS.map(value => ({ value, ...presentation[value] })),
  }
}
