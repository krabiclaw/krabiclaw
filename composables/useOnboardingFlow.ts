import { currencyForCountry, type CurrencyCode } from '~/shared/currencies'
import type { PostalAddress } from '~/utils/postal-address'
import { isValidTimezone } from '~/utils/timezone'
import { toE164 } from '~/utils/phone'
import type { OpeningHours, SpecialHours } from '~/shared/reservation-hours'
import type { OrganizationVertical } from '~/utils/vertical-copy'
import type { DraftBrandForm } from '~/lib/components/workspace/onboarding/DraftBrandCard.vue'

export type OnboardingStepId =
  | 'type' | 'language' | 'business'
  | 'location' | 'hours' | 'currency'
  | 'contact' | 'products' | 'look'
  | 'review'

export type OnboardingSectionId = 'business' | 'place' | 'offer' | 'review'

export interface OnboardingProductDraft {
  name: string
  category: string
  amountMinor: number | null
}

/** The place the business picker hands back: Place Details for the chosen prediction. */
export interface OnboardingPlacePreview {
  placeId: string
  name: string
  address: PostalAddress | null
  phone?: string | null
  mapsUrl?: string | null
  timezone?: string | null
  openingHours?: OpeningHours
}

export interface OnboardingDraftPreview {
  draftId: string
  organizationId: string
  previewToken: string
  draftName: string
  subdomainCandidate: string
}

export interface OnboardingFlowState {
  vertical: OrganizationVertical
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
  created: { orgSlug: string | null; organizationSlug: string | null; locationSlug: string | null } | null
}

/**
 * One step of the flow. `section` drives the progress bar; `complete` decides
 * whether Next is enabled and where a resumed draft lands. Order in STEPS is
 * the only place the sequence is written down — Back, Next, the progress bar
 * and resume all read it.
 */
export interface OnboardingStep {
  id: OnboardingStepId
  section: OnboardingSectionId
  /** Intro screens carry no control and are always passable. */
  intro?: boolean
  title: (_state: OnboardingFlowState) => string
  lede?: (_state: OnboardingFlowState) => string
  complete: (_state: OnboardingFlowState) => boolean
  /** A step that does not apply to the current answers is skipped in both directions. */
  applies?: (_state: OnboardingFlowState) => boolean
  nextLabel?: (_state: OnboardingFlowState) => string
  /** Optional steps advance without an answer. */
  optional?: boolean
  /** A single-choice step advances on the click rather than waiting for Next. */
  advanceOnChoice?: boolean
  /**
   * What Next does beyond saving. The shell owns navigation, so a step that
   * needs a server call before moving on names it here rather than reaching
   * into the footer.
   */
  action?: 'commit'
}

export const ONBOARDING_SECTIONS: Array<{ id: OnboardingSectionId; label: string }> = [
  { id: 'business', label: 'Your business' },
  { id: 'place', label: 'Where and when' },
  { id: 'offer', label: 'What you offer' },
  { id: 'review', label: 'Review' },
]

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'type', section: 'business',
    advanceOnChoice: true,
    title: () => 'What kind of business is this?',
    complete: state => Boolean(state.vertical),
  },
  {
    id: 'language', section: 'business',
    advanceOnChoice: true,
    title: () => 'What language is your website in?',
    complete: state => state.details.sourceLocale !== null,
  },
  {
    id: 'business', section: 'business',
    title: () => 'What is your business called?',
    complete: state => state.details.name.trim().length > 0 && (
      state.source === 'google_places' ? state.placeId !== null : state.source === 'manual'),
  },
  {
    id: 'location', section: 'place',
    title: () => 'Where should guests find you?',
    complete: state => Boolean(state.details.streetAddress.trim() || state.details.city.trim() || state.details.country.trim()),
    optional: true,
  },
  {
    // The location's clock, and the site's: required before the first save,
    // which creates the site. The hours themselves stay optional.
    id: 'hours', section: 'place',
    title: () => 'When are you open?',
    complete: state => isValidTimezone(state.hours.timezone.trim()),
    nextLabel: () => 'Save hours',
  },
  {
    // Before the first save, because a site cannot exist without the currency
    // it sells in. A location added later prices in the currency its site has.
    id: 'currency', section: 'place',
    advanceOnChoice: true,
    title: () => 'What currency do you price in?',
    lede: state => currencyForCountry(state.details.country)
      ? 'Taken from the country you gave. Change it if that is not what you charge in.'
      : 'We could not tell from the country you gave, so pick the one you charge in.',
    complete: state => state.details.currency !== null,
  },
  {
    id: 'contact', section: 'place',
    title: () => 'What is your business contact number?',
    complete: state => toE164(state.details.phone) !== null,
    optional: true,
  },
  {
    id: 'products', section: 'offer',
    applies: state => state.vertical === 'restaurant' || state.vertical === 'experience',
    title: state => state.vertical === 'restaurant'
      ? 'What is on the menu?'
      : state.vertical === 'experience' ? 'What can guests book?' : 'What do you offer?',
    complete: state => state.products.length > 0,
    optional: true,
  },
  {
    id: 'look', section: 'offer',
    title: () => 'Last look at the front of house',
    complete: state => state.brand.heroHeadline.trim().length > 0,
    optional: true,
  },
  {
    id: 'review', section: 'review',
    title: () => 'Here is your site so far',
    complete: () => true,
    action: 'commit',
    nextLabel: () => 'Create my site',
  },
]

export function onboardingStep(id: string | undefined): OnboardingStep | null {
  return ONBOARDING_STEPS.find(step => step.id === id) ?? null
}

function emptyState(): OnboardingFlowState {
  return {
    // 'restaurant' is the first choice on the type step, which the owner answers
    // before anything is saved. The country and the currency have no such
    // default: seeding them with the United States and USD is how a Krabi
    // restaurant ended up priced in dollars without being asked.
    vertical: 'restaurant',
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
  return useState<OnboardingFlowState>('onboarding-flow', emptyState)
}

export function useOnboardingSteps() {
  const state = useOnboardingState()
  const steps = computed(() => ONBOARDING_STEPS.filter(step => step.applies?.(state.value) ?? true))

  const indexOf = (id: OnboardingStepId) => steps.value.findIndex(step => step.id === id)
  const nextOf = (id: OnboardingStepId) => steps.value[indexOf(id) + 1] ?? null
  const previousOf = (id: OnboardingStepId) => (indexOf(id) > 0 ? steps.value[indexOf(id) - 1] ?? null : null)

  /**
   * Where a resumed draft belongs: the first step that still has no answer.
   * Optional steps do not hold the owner, so they never become the landing
   * point on their own.
   */
  const resumeStep = computed(() => {
    const unanswered = steps.value.find(step => !step.intro && !step.optional && !step.complete(state.value))
    // Every required answer is in, so the draft belongs at the end of the flow.
    // Landing on 'hours' put a finished draft back on an optional step it had
    // already passed, and contradicted the rule above.
    return unanswered ?? steps.value[steps.value.length - 1]!
  })

  return { steps, indexOf, nextOf, previousOf, resumeStep }
}

export function onboardingStepPath(id: OnboardingStepId) {
  return `/dashboard/onboarding/${id}`
}
