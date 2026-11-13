import type { CurrencyCode } from '~/shared/currencies'
import type { PostalAddress } from '~/utils/postal-address'
import type { OpeningHours } from '~/shared/reservation-hours'
import { WEBSITE_ONBOARDING_PATH, type OnboardingFlow, type OnboardingStepId } from '~/shared/onboarding-flow'
import { validatedInternalPath } from '~/shared/auth/return-target'
import type { OrganizationVertical } from '~/utils/vertical-copy'

/** The place the business picker hands back: Place Details for the chosen prediction. */
export interface OnboardingPlacePreview {
  google_place_id: string
  name: string
  address: PostalAddress | null
  phone?: string | null
  maps_url?: string | null
  timezone?: string | null
  opening_hours?: OpeningHours
}

export interface OnboardingFlowState {
  vertical: OrganizationVertical | null
  source: 'google_places' | 'manual' | null
  /** The Google place the owner picked; null on the manual path. */
  placeId: string | null
  subdomain: string | undefined
  savedSubdomain: string | null
  languageLocked: boolean
  details: {
    name: string
    city: string
    streetAddress: string
    addressLine2: string
    region: string
    postalCode: string
    country: string
    currency: CurrencyCode | null
    sourceLocale: string | null
  }
  timezone: string
  timezoneStepVisited: boolean
  pausedStep: OnboardingStepId | undefined
  draftId: string | null
  draftRevision: string | null
  created: { organization_slug: string; subdomain: string; next_url: string } | null
}

export function emptyOnboardingState(): OnboardingFlowState {
  return {
    vertical: null,
    source: null,
    placeId: null,
    subdomain: undefined,
    savedSubdomain: null,
    languageLocked: false,
    details: {
      name: '', city: '', streetAddress: '', addressLine2: '', region: '', postalCode: '',
      country: '', currency: null, sourceLocale: null,
    },
    timezone: '',
    timezoneStepVisited: false,
    pausedStep: undefined,
    draftId: null,
    draftRevision: null,
    created: null,
  }
}

/** The answers, shared by every step screen and by the shell around them. */
export function useOnboardingState() {
  return useState<OnboardingFlowState>('onboarding-flow', emptyOnboardingState)
}

export function useOnboardingPlan() {
  return useState<OnboardingFlow | null>('onboarding-plan', () => null)
}

export function onboardingReturnTarget(value: unknown) {
  const target = validatedInternalPath(value)
  const pathname = target?.split(/[?#]/, 1)[0]
  if (!pathname?.startsWith('/dashboard/') || /^\/dashboard\/(?:onboarding|app)(?:\/|$)/i.test(pathname)) return undefined
  return target
}

export function onboardingLink(to: string, origin: unknown) {
  const returnTo = onboardingReturnTarget(origin)
  return returnTo ? `${to}?${new URLSearchParams({ returnTo })}` : to
}

export function onboardingStepPath(id: OnboardingStepId, origin?: string) {
  return onboardingLink(id === 'type' ? WEBSITE_ONBOARDING_PATH : `${WEBSITE_ONBOARDING_PATH}/${id}`, origin)
}
