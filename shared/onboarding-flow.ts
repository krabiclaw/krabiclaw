import type { OrganizationVertical } from '~/utils/vertical-copy'
import type { PhoneCountry } from '~/utils/phone'
import type { CurrencyCode } from '~/shared/currencies'

export const WEBSITE_ONBOARDING_PATH = '/dashboard/onboarding'
export const WEBSITE_ONBOARDING_EXIT_PATH = '/dashboard/account/profile/organizations'

export interface WebsiteOnboardingResumeAction {
  label: string
  to: typeof WEBSITE_ONBOARDING_PATH
}

export const ONBOARDING_STEP_IDS = ['type', 'business', 'location', 'timezone', 'language', 'currency'] as const
export type OnboardingStepId = typeof ONBOARDING_STEP_IDS[number]

export interface OnboardingStepField {
  key: 'name' | 'subdomain' | 'country' | 'streetAddress' | 'addressLine2' | 'city' | 'region' | 'postalCode' | 'timezone' | 'sourceLocale' | 'currency'
  label: string
  description?: string
}

export interface OnboardingStep {
  id: OnboardingStepId
  title: string
  fields: OnboardingStepField[]
  nextLabel: string
  canAdvance: boolean
  action?: 'commit'
}

interface OnboardingChoice {
  value: string
  label: string
  icon: string
}

export interface OnboardingFlow {
  steps: OnboardingStep[]
  resumeStep: OnboardingStepId
  canSave: boolean
  canFinish: boolean
  exitLabel: string
  backLabel: string
  proposedTimezone: string | null
  proposedCurrency: CurrencyCode | null
  includedDomain?: string
  subdomainError?: string
  neutralWebsiteExample: { name: string; image: string }
  businessLookup: { importLabel: string; manualLabel: string; searchPlaceholder: string }
  countries: PhoneCountry[]
  currencies: Array<{ value: CurrencyCode; label: string }>
  timezones: Array<{ value: string; label: string }>
  languages: OnboardingChoice[]
  businessTypes: Array<OnboardingChoice & {
    value: OrganizationVertical
    example: { name: string; image: string }
  }>
}
