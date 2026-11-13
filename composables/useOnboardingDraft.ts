import { applicationFetch } from '~/composables/dashboardFetch'
import { ApiClientError, isRecord } from '~/utils/api-clients'
import { ONBOARDING_STEP_IDS, type OnboardingFlow, type OnboardingStepId } from '~/shared/onboarding-flow'
import { isCurrencyCode } from '~/shared/currencies'
import { emptyOnboardingState, useOnboardingState, type OnboardingPlacePreview } from '~/composables/useOnboardingFlow'
import { ALL_VERTICALS, type OrganizationVertical } from '~/utils/vertical-copy'

export async function readActiveWebsiteDraft() {
  const response = await applicationFetch<{ success: true; draft: Record<string, unknown> | null }>('/api/dashboard/onboarding/drafts/active', {
    validate: (value): value is { success: true; draft: Record<string, unknown> | null } => isRecord(value)
      && value.success === true && (value.draft === null || isRecord(value.draft)),
  })
  return response.draft
}

/**
 * Every server call the flow makes, and the shapes they answer with. The step
 * screens own presentation and nothing else; this owns the draft.
 */
export function useOnboardingDraft() {
  const state = useOnboardingState()
  const busy = ref(false)
  const error = ref<string | null>(null)
  const subdomainConflict = ref(false)
  const { trackOrganizationCreated } = useAnalytics()

  const flowAnswers = computed(() => {
    const { vertical, source, placeId, subdomain, savedSubdomain, details, timezone, timezoneStepVisited } = state.value
    const { name, sourceLocale, country, currency } = details
    return { vertical, source, placeId, subdomain, savedSubdomain, name, sourceLocale, country, currency, timezone, timezoneStepVisited }
  })

  function readFlow(answers: typeof flowAnswers.value & { pausedStep?: OnboardingStepId } = flowAnswers.value, signal?: AbortSignal) {
    return applicationFetch<OnboardingFlow>('/api/dashboard/onboarding/flow', {
      method: 'POST',
      body: answers,
      signal,
      validate: (value): value is OnboardingFlow => isRecord(value)
        && Array.isArray(value.steps) && typeof value.resumeStep === 'string'
        && typeof value.canSave === 'boolean' && typeof value.canFinish === 'boolean' && typeof value.exitLabel === 'string'
        && typeof value.backLabel === 'string' && Array.isArray(value.businessTypes) && Array.isArray(value.languages)
        && Array.isArray(value.countries) && Array.isArray(value.currencies) && Array.isArray(value.timezones),
    })
  }

  /** Save the answers, provisioning a pending website only at the last question. */
  async function save(flow: OnboardingFlow, pausedStep?: OnboardingStepId): Promise<boolean> {
    busy.value = true
    error.value = null
    subdomainConflict.value = false
    try {
      const { details, timezone } = state.value
      const complete = flow.canFinish && (!pausedStep || pausedStep === 'currency')
      const res = await applicationFetch<Record<string, unknown>>('/api/dashboard/onboarding/drafts/active', {
        method: 'POST',
        body: {
          draft_id: state.value.draftId ?? undefined,
          updated_at: state.value.draftRevision,
          source_type: state.value.source ?? 'manual',
          google_place_id: state.value.placeId,
          name: state.value.details.name.trim(),
          subdomain: complete ? state.value.subdomain?.trim() || undefined : state.value.subdomain,
          vertical: state.value.vertical,
          partial: !complete || undefined,
          paused_step: complete ? undefined : pausedStep,
          timezone_step_visited: state.value.timezoneStepVisited,
          details: {
            name: details.name.trim(),
            country: details.country.trim().toUpperCase(),
            city: details.city.trim() || null,
            street_address: details.streetAddress.trim() || null,
            address_line_2: details.addressLine2.trim() || null,
            region: details.region.trim() || null,
            postal_code: details.postalCode.trim() || null,
            timezone: timezone.trim() || (complete ? flow.proposedTimezone : null),
            currency: details.currency ?? (complete ? flow.proposedCurrency : null),
            source_locale: details.sourceLocale,
          },
        },
        validate: (value): value is Record<string, unknown> => isRecord(value),
      })
      if (res.success !== true || typeof res.draft_id !== 'string' || typeof res.updated_at !== 'string'
        || (complete && (typeof res.organization_id !== 'string' || typeof res.subdomain_candidate !== 'string'))) {
        throw new Error(typeof res.error === 'string' ? res.error : 'Could not save your answers. Please try again.')
      }
      state.value.draftId = res.draft_id
      state.value.draftRevision = res.updated_at
      if (complete && typeof res.subdomain_candidate === 'string') {
        state.value.savedSubdomain = res.subdomain_candidate
        state.value.languageLocked = true
        state.value.subdomain = undefined
      }
      clearNuxtData('personal-website-setup')
      return true
    } catch (cause) {
      subdomainConflict.value = cause instanceof ApiClientError && cause.code === 'SUBDOMAIN_TAKEN'
      if (subdomainConflict.value) {
        const response = await readActiveWebsiteDraft()
        if (!response || typeof response.draft_id !== 'string' || typeof response.updated_at !== 'string') throw cause
        state.value.draftId = response.draft_id
        state.value.draftRevision = response.updated_at
      }
      error.value = cause instanceof Error ? cause.message : 'Something went wrong. Please try again.'
      return false
    } finally {
      busy.value = false
    }
  }

  /**
   * The owner picked this place in the business picker. Its Place Details seed
   * the screens after it, which stay editable; only the placeId is sent on, and
   * the server fetches the place itself when it saves or adds the location.
   */
  function seedFromPlace(preview: OnboardingPlacePreview) {
    state.value.source = 'google_places'
    state.value.placeId = preview.google_place_id
    const details = state.value.details
    details.name = preview.name ?? ''
    // Places answers with the address already split, so every field seeds from
    // its own part instead of the whole formatted line landing in the street.
    const address = preview.address
    details.streetAddress = address?.addressLines?.[0] ?? ''
    details.addressLine2 = address?.addressLines?.slice(1).join(', ') ?? ''
    details.city = address?.locality ?? ''
    details.region = address?.administrativeArea ?? ''
    details.postalCode = address?.postalCode ?? ''
    details.country = address?.regionCode ?? ''
    state.value.timezone = preview.timezone ?? ''
    state.value.timezoneStepVisited = false
  }

  /** Activate the organization with its website private. */
  async function activate(): Promise<boolean> {
    const draftId = state.value.draftId
    if (!draftId) {
      error.value = 'No draft is ready yet.'
      return false
    }
    busy.value = true
    error.value = null
    try {
      const res = await applicationFetch<Record<string, unknown>>(
        `/api/dashboard/onboarding/drafts/${draftId}/activate`,
        { method: 'POST', body: { updated_at: state.value.draftRevision }, validate: (value): value is Record<string, unknown> => isRecord(value) },
      )
      if (res.success !== true || typeof res.organization_slug !== 'string' || !res.organization_slug
        || typeof res.next_url !== 'string' || !res.next_url.startsWith('/dashboard/')
        || typeof res.subdomain !== 'string' || !res.subdomain || typeof res.organization_id !== 'string' || !res.organization_id) {
        throw new Error(typeof res.error === 'string' ? res.error : 'The private website could not be read.')
      }
      state.value.created = { organization_slug: res.organization_slug, subdomain: res.subdomain, next_url: res.next_url }
      clearNuxtData('personal-website-setup')
      trackOrganizationCreated(res.organization_id)
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Something went wrong. Please try again.'
      return false
    } finally {
      busy.value = false
    }
  }

  /** Read the unfinished draft back into the flow. Returns false when there is none. */
  async function restore(): Promise<boolean> {
    const draft = await readActiveWebsiteDraft()
    if (!draft) {
      state.value = emptyOnboardingState()
      return false
    }
    if (typeof draft.draft_id !== 'string' || typeof draft.updated_at !== 'string') throw new Error('Saved website draft identity and revision are unavailable')
    const details = isRecord(draft.details) ? draft.details : {}
    const text = (value: unknown) => typeof value === 'string' ? value : ''
    if (!ALL_VERTICALS.includes(draft.vertical as OrganizationVertical)) throw new Error(`Saved website draft has an unknown business type: ${String(draft.vertical)}`)
    state.value = emptyOnboardingState()
    state.value.draftId = draft.draft_id
    state.value.draftRevision = draft.updated_at
    state.value.languageLocked = typeof draft.organization_id === 'string'
    if (typeof draft.subdomain_candidate === 'string') {
      if (draft.organization_id) state.value.savedSubdomain = draft.subdomain_candidate
      else state.value.subdomain = draft.subdomain_candidate
    }
    state.value.vertical = draft.vertical as OrganizationVertical
    state.value.source = draft.source_type === 'google_places' ? 'google_places' : 'manual'
    state.value.placeId = typeof draft.google_place_id === 'string' && draft.google_place_id ? draft.google_place_id : null
    state.value.details.sourceLocale = typeof details.source_locale === 'string' ? details.source_locale : null
    state.value.details.name = text(details.name)
    state.value.details.city = text(details.city)
    state.value.details.streetAddress = text(details.street_address)
    state.value.details.addressLine2 = text(details.address_line_2)
    state.value.details.region = text(details.region)
    state.value.details.postalCode = text(details.postal_code)
    if (typeof details.country === 'string' && details.country) state.value.details.country = details.country
    if (isCurrencyCode(details.currency)) state.value.details.currency = details.currency
    state.value.timezone = text(details.timezone)
    state.value.timezoneStepVisited = draft.timezone_step_visited === true
    state.value.pausedStep = ONBOARDING_STEP_IDS.find(step => step === draft.paused_step)
    return true
  }

  return { busy, error, subdomainConflict, flowAnswers, readFlow, save, seedFromPlace, activate, restore }
}
