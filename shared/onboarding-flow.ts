import type { OrganizationVertical } from '~/utils/vertical-copy'
import type { PhoneCountry } from '~/utils/phone'
import type { CurrencyCode } from '~/shared/currencies'

export type OnboardingStepId = 'type' | 'business' | 'location' | 'timezone' | 'language' | 'currency'

export interface OnboardingStepField {
  key: 'name' | 'subdomain' | 'country' | 'streetAddress' | 'addressLine2' | 'city' | 'region' | 'postalCode' | 'timezone' | 'sourceLocale' | 'currency'
  label: string
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
  exitLabel: string
  backLabel: string
  proposedTimezone: string | null
  proposedCurrency: CurrencyCode | null
  includedDomain?: string
  subdomainError?: string
  countries: PhoneCountry[]
  currencies: Array<{ value: CurrencyCode; label: string }>
  timezones: Array<{ value: string; label: string }>
  languages: OnboardingChoice[]
  businessTypes: Array<OnboardingChoice & {
    value: OrganizationVertical
    example: { name: string; image: string }
  }>
}
