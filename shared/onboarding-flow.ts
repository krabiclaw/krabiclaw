import type { OrganizationVertical } from '~/utils/vertical-copy'

export type OnboardingStepId =
  | 'type' | 'language' | 'business'
  | 'location' | 'hours' | 'currency'
  | 'contact' | 'products' | 'look'
  | 'review'

export interface OnboardingStep {
  id: OnboardingStepId
  title: string
  nextLabel: string
  canAdvance: boolean
  save?: true
  action?: 'commit'
}

export interface OnboardingFlow {
  steps: OnboardingStep[]
  resumeStep: OnboardingStepId
  canSave: boolean
  businessTypes: Array<{
    value: OrganizationVertical
    label: string
    icon: string
    example: { name: string; image: string }
  }>
}
