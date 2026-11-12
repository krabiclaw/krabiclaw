import type { CurrencyCode } from '~/shared/currencies'
import type { PostalAddress } from '~/utils/postal-address'
import type { OpeningHours, SpecialHours } from '~/shared/reservation-hours'
import type { OnboardingFlow, OnboardingStepId } from '~/shared/onboarding-flow'
import type { OrganizationVertical } from '~/utils/vertical-copy'
import type { DraftBrandForm } from '~/lib/components/workspace/onboarding/DraftBrandCard.vue'

export interface OnboardingProductDraft {
  name: string
  category: string
  amountMinor: number | null
}

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

export interface OnboardingDraftPreview {
  draftId: string
  organizationId: string
  previewToken: string
  draftName: string
  subdomainCandidate: string
}

export interface OnboardingFlowState {
  vertical: OrganizationVertical | null
  source: 'google_places' | 'manual' | null
  /** The Google place the owner picked; null on the manual path. */
  placeId: string | null
  details: {
    name: string
    city: string
    streetAddress: string
    addressLine2: string
    region: string
    postalCode: string
    country: string
    phone: string
    /** null until the currency step is answered. Never seeded with a product default. */
    currency: CurrencyCode | null
    sourceLocale: string | null
  }
  hours: { timezone: string; hours: OpeningHours; specialHours: SpecialHours }
  brand: DraftBrandForm
  products: OnboardingProductDraft[]
  draftId: string | null
  draftRevision: string | null
  preview: OnboardingDraftPreview | null
  created: { organization_slug: string; subdomain: string; next_url: string } | null
}

export function emptyOnboardingState(): OnboardingFlowState {
  return {
    vertical: null,
    source: null,
    placeId: null,
    details: {
      name: '', city: '', streetAddress: '', addressLine2: '', region: '', postalCode: '',
      country: '', phone: '', currency: null, sourceLocale: null,
    },
    hours: { timezone: '', hours: null, specialHours: null },
    brand: {
      paletteStarter: null, fontPreset: null, logoShape: null, logoNote: '', logoPreviewUrl: '', logoImage: null,
      heroPhotoNote: '', heroPreviewUrl: '', heroImage: null,
      heroHeadline: '', heroSubtitle: '',
    },
    products: [],
    draftId: null,
    draftRevision: null,
    preview: null,
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

export function onboardingStepPath(id: OnboardingStepId) {
  return id === 'type' ? '/dashboard/onboarding' : `/dashboard/onboarding/${id}`
}
