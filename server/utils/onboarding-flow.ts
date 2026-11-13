import { z } from 'zod'
import { ONBOARDING_STEP_IDS, type OnboardingFlow, type OnboardingStep, type OnboardingStepField } from '~/shared/onboarding-flow'
import { PLATFORM_LOCALES, platformLocale } from '~/shared/platform-locales'
import { CURRENCY_OPTIONS, currencyForCountry, isCurrencyCode } from '~/shared/currencies'
import { TIMEZONE_OPTIONS, isValidTimezone, singleTimezoneForCountry, timezoneLabel } from '~/utils/timezone'
import { getPhoneCountry, listPhoneCountries } from '~/utils/phone'
import { ALL_VERTICALS, type OrganizationVertical } from '~/utils/vertical-copy'
import { isOnboardingSubdomain, onboardingSubdomainCandidate } from '~/server/utils/onboarding-drafts'

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
  subdomain: z.string().optional(),
  savedSubdomain: z.string().nullable().optional(),
  sourceLocale: z.string().nullable(),
  country: z.string(),
  timezone: z.string(),
  timezoneStepVisited: z.boolean().optional(),
  pausedStep: z.enum(ONBOARDING_STEP_IDS).optional(),
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

let timezoneChoices: { day: string; items: OnboardingFlow['timezones'] } | undefined

export function proposedOnboardingSubdomain(answers: z.infer<typeof onboardingAnswers>) {
  return answers.savedSubdomain ?? (answers.subdomain ?? onboardingSubdomainCandidate(answers.name.trim())).trim().toLowerCase()
}

export function onboardingFlow(answers: z.infer<typeof onboardingAnswers>, options: { includedDomain?: string; subdomainTaken?: boolean } = {}): OnboardingFlow {
  const country = getPhoneCountry(answers.country)?.code ?? ''
  const proposedTimezone = singleTimezoneForCountry(country)
  const proposedCurrency = currencyForCountry(country)
  const zone = answers.timezone || proposedTimezone
  const timezoneKnown = isValidTimezone(zone)
  const askTimezone = !timezoneKnown || answers.timezoneStepVisited === true
  const name = answers.name.trim()
  const subdomain = proposedOnboardingSubdomain(answers)
  const validSubdomain = isOnboardingSubdomain(subdomain)
  const askSubdomain = !answers.savedSubdomain && (answers.subdomain !== undefined || Boolean(name && (!validSubdomain || options.subdomainTaken)))
  const day = new Date().toISOString().slice(0, 10)
  if (timezoneChoices?.day !== day) {
    timezoneChoices = { day, items: TIMEZONE_OPTIONS.map(value => ({ value, label: timezoneLabel(value) })) }
  }
  const timezones = timezoneKnown && !TIMEZONE_OPTIONS.includes(zone)
    ? [{ value: zone, label: timezoneLabel(zone) }, ...timezoneChoices.items]
    : timezoneChoices.items

  const steps: OnboardingStep[] = [
    {
      id: 'type', title: 'What kind of business do you run?', fields: [],
      nextLabel: 'Continue', canAdvance: answers.vertical !== null,
    },
    {
      id: 'business', title: 'What’s your business called?',
      fields: [{ key: 'name', label: 'Business name' }, ...(askSubdomain ? [{ key: 'subdomain', label: 'Website address', description: 'Use letters A–Z, numbers, or hyphens.' } as const] : [])],
      nextLabel: 'Next', canAdvance: Boolean(name) && validSubdomain && !options.subdomainTaken && (answers.source === 'manual' || (
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

  const firstIncomplete = steps.findIndex(step => !step.canAdvance)
  const paused = steps.findIndex(step => step.id === answers.pausedStep)
  const furthest = firstIncomplete === -1 ? steps.length - 1 : firstIncomplete
  return {
    steps,
    resumeStep: steps[paused === -1 ? furthest : Math.min(paused, furthest)]!.id,
    canSave: answers.vertical !== null,
    canFinish: firstIncomplete === -1,
    exitLabel: answers.vertical ? 'Save & exit' : 'Exit',
    backLabel: 'Back',
    proposedTimezone,
    proposedCurrency,
    includedDomain: options.includedDomain,
    subdomainError: options.subdomainTaken
      ? 'That website address is taken. Choose another.'
      : answers.subdomain?.trim() && !validSubdomain ? 'Start and end with a letter or number.' : undefined,
    neutralWebsiteExample: { name: 'Your business website', image: '/images/website/onboarding-neutral.webp' },
    businessLookup: { importLabel: 'Import from Google Maps', manualLabel: 'Enter details manually', searchPlaceholder: 'Search for your business' },
    countries: listPhoneCountries(),
    currencies: CURRENCY_OPTIONS,
    timezones,
    languages: PLATFORM_LOCALES.map(({ locale, label }) => ({ value: locale, label, icon: 'i-lucide-languages' })),
    businessTypes: ALL_VERTICALS.map(value => ({ value, ...presentation[value] })),
  }
}
