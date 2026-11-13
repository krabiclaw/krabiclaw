import type { OrganizationVertical } from '~/utils/vertical-copy'

export type OnboardingStepId = 'type' | 'business' | 'location' | 'timezone' | 'language' | 'currency'

export interface OnboardingStepField {
  key: 'name' | 'country' | 'streetAddress' | 'addressLine2' | 'city' | 'region' | 'postalCode' | 'timezone' | 'sourceLocale' | 'currency'
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
  proposedCurrency: string | null
  languages: OnboardingChoice[]
  businessTypes: Array<OnboardingChoice & {
    value: OrganizationVertical
    example: { name: string; image: string }
  }>
}
