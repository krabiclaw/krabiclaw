import { applicationFetch } from '~/composables/dashboardFetch'
import { isRecord } from '~/utils/api-clients'
import { parseOpeningHours, parseSpecialHours, type OpeningHours } from '~/shared/reservation-hours'
import { parsePhone } from '~/utils/phone'
import { useOnboardingState, type OnboardingPlacePreview } from '~/composables/useOnboardingFlow'
import { formatPostalAddress, postalAddressFromAnswers } from '~/utils/postal-address'
import { isOrganizationFontPreset } from '~/shared/organization-fonts'
import { LOGO_SHAPES, type LogoShape } from '~/shared/media-placement-contract'

/**
 * Every server call the flow makes, and the shapes they answer with. The step
 * screens own presentation and nothing else; this owns the draft.
 */
export function useOnboardingDraft() {
  const state = useOnboardingState()
  const busy = ref(false)
  const error = ref<string | null>(null)
  const { trackOrganizationCreated } = useAnalytics()

  /** The address as the review step shows it, on one line. */
  function addressSummary() {
    return formatPostalAddress(postalAddressFromAnswers(addressParts()))
  }

  /** The address one field per answer, which is how a location stores it. */
  function addressParts() {
    const details = state.value.details
    return {
      streetAddress: details.streetAddress,
      addressLine2: details.addressLine2,
      city: details.city,
      region: details.region,
      postalCode: details.postalCode,
      country: details.country,
    }
  }

  function serializeDetails() {
    const details = state.value.details
    return {
      name: details.name.trim(),
      country: details.country.trim().toUpperCase() || null,
      city: details.city.trim() || null,
      streetAddress: details.streetAddress.trim() || null,
      addressLine2: details.addressLine2.trim() || null,
      region: details.region.trim() || null,
      postalCode: details.postalCode.trim() || null,
      phone: details.phone.trim() || null,
      openingHours: parseOpeningHours(state.value.hours.hours),
      specialHours: parseSpecialHours(state.value.hours.specialHours),
      timezone: state.value.hours.timezone.trim() || null,
      currency: details.currency ?? null,
      sourceLocale: details.sourceLocale,
    }
  }

  function serializeBrandDraft() {
    const brand = state.value.brand
    return {
      paletteStarter: brand.paletteStarter,
      fontPreset: brand.fontPreset,
      logoShape: brand.logoShape,
      logoNote: brand.logoNote.trim() || null,
      logoPreviewUrl: brand.logoPreviewUrl.trim() || null,
      heroPhotoNote: brand.heroPhotoNote.trim() || null,
      heroPreviewUrl: brand.heroPreviewUrl.trim() || null,
      logoImage: brand.logoImage,
      heroImage: brand.heroImage,
      heroHeadline: brand.heroHeadline.trim() || null,
      heroSubtitle: brand.heroSubtitle.trim() || null,
    }
  }

  function serializeProducts() {
    return state.value.products
      .filter(product => product.name.trim())
      .map(product => ({
        name: product.name.trim(),
        category: product.category.trim(),
        amountMinor: product.amountMinor,
      }))
  }

  /** Save the answers so far. Every step calls this; the site follows the draft. */
  async function save(): Promise<boolean> {
    busy.value = true
    error.value = null
    try {
      const res = await applicationFetch<Record<string, unknown>>('/api/dashboard/onboarding/drafts/active', {
        method: 'POST',
        body: {
          draftId: state.value.draftId ?? undefined,
          expectedUpdatedAt: state.value.draftRevision,
          sourceType: state.value.source ?? 'manual',
          placeId: state.value.placeId,
          name: state.value.details.name.trim(),
          vertical: state.value.vertical,
          details: serializeDetails(),
          brandDraft: serializeBrandDraft(),
          products: serializeProducts(),
        },
        validate: (value): value is Record<string, unknown> => isRecord(value),
      })
      if (res.success !== true || typeof res.draftId !== 'string' || typeof res.updatedAt !== 'string' || typeof res.organizationId !== 'string'
        || typeof res.previewToken !== 'string' || typeof res.draftName !== 'string'
        || typeof res.subdomainCandidate !== 'string') {
        throw new Error(typeof res.error === 'string' ? res.error : 'Could not save your answers. Please try again.')
      }
      state.value.draftId = res.draftId
      state.value.draftRevision = res.updatedAt
      state.value.preview = {
        draftId: res.draftId, organizationId: res.organizationId, previewToken: res.previewToken,
        draftName: res.draftName, subdomainCandidate: res.subdomainCandidate,
      }
      return true
    } catch (cause) {
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
    state.value.placeId = preview.placeId
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
    // The server hands the place's number over in E.164.
    details.phone = parsePhone(preview.phone ?? '').e164 ?? ''
    state.value.hours.hours = parseOpeningHours((preview.openingHours ?? null) as OpeningHours)
    state.value.hours.specialHours = null
    state.value.hours.timezone = preview.timezone ?? ''
  }

  /** Make the pending site public. */
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
        { method: 'POST', body: { expectedUpdatedAt: state.value.draftRevision }, validate: (value): value is Record<string, unknown> => isRecord(value) },
      )
      if (res.success !== true) {
        throw new Error(typeof res.error === 'string' ? res.error : 'Failed to create your organization. Please try again.')
      }
      state.value.created = {
        orgSlug: typeof res.orgSlug === 'string' ? res.orgSlug : null,
        organizationSlug: typeof res.organizationSlug === 'string' ? res.organizationSlug : null,
        locationSlug: typeof res.locationSlug === 'string' ? res.locationSlug : null,
      }
      if (typeof res.organizationId === 'string') trackOrganizationCreated(res.organizationId)
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Something went wrong. Please try again.'
      return false
    } finally {
      busy.value = false
    }
  }

  /**
   * The pending site the caller's own active draft owns, or null when they have
   * no draft.
   *
   * DELETE /api/dashboard/onboarding/drafts/active acts on the caller's draft,
   * not on a site named in the request, so a surface that offers Discard has to
   * know which site that is. Offering it on a pending site belonging to someone
   * else's draft would delete the caller's own draft somewhere else — the same
   * shape of bug as resolving an ambiguous target instead of refusing it.
   *
   * Deliberately unguarded: a caller that cannot read this does not know what
   * Discard would delete, and has to say so rather than offer the control
   * anyway or hide it without a reason.
   */
  async function activeDraftOrganizationId(): Promise<string | null> {
    const res = await applicationFetch<Record<string, unknown>>('/api/dashboard/onboarding/drafts/active', {
      validate: (value): value is Record<string, unknown> => isRecord(value),
    })
    const draft = isRecord(res.draft) ? res.draft : null
    return draft && typeof draft.organizationId === 'string' ? draft.organizationId : null
  }

  /**
   * Abandon the draft and delete the pending site it created.
   *
   * The endpoint refuses rather than half-deleting: 409 when the site is
   * already live, 403 when the caller is not an owner of its organization, 500
   * when the delete left the site standing — and it leaves the draft open on
   * every refusal. Its message is the one the caller shows, because the
   * previous client swallowed the response and cleared local state regardless,
   * which is exactly what made those refusals invisible.
   */
  async function discard(): Promise<boolean> {
    busy.value = true
    error.value = null
    try {
      const res = await applicationFetch<Record<string, unknown>>('/api/dashboard/onboarding/drafts/active', {
        method: 'DELETE',
        validate: (value): value is Record<string, unknown> => isRecord(value),
      })
      if (res.success !== true) {
        throw new Error(typeof res.error === 'string' ? res.error : 'Could not discard your unfinished organization. Please try again.')
      }
      // The endpoint answers `deleted: false` when the caller has no active
      // draft any more — it activated, or another tab discarded it. Nothing was
      // removed, so reporting this as done would close the dialog over a site
      // that is still there. Say what actually happened.
      if (res.deleted !== true) {
        throw new Error('Nothing was discarded: you no longer have an unfinished organization. Reload this page to see its current state.')
      }
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Something went wrong. Please try again.'
      return false
    } finally {
      busy.value = false
    }
  }

  function restoredImage(value: unknown): typeof state.value.brand.logoImage {
    if (value === null) return null
    if (!isRecord(value) || typeof value.draftAssetId !== 'string' || typeof value.cloudflareImageId !== 'string' || typeof value.publicUrl !== 'string') throw new Error('Saved website image is unavailable')
    return value as NonNullable<typeof state.value.brand.logoImage>
  }

  /** Read the unfinished draft back into the flow. Returns false when there is none. */
  async function restore(): Promise<boolean> {
    const res = await applicationFetch<Record<string, unknown>>('/api/dashboard/onboarding/drafts/active', {
      validate: (value): value is Record<string, unknown> => isRecord(value),
    })
    const draft = isRecord(res.draft) ? res.draft : null
    if (!draft) return false
    if (typeof draft.draftId !== 'string' || typeof draft.updatedAt !== 'string') throw new Error('Saved website draft identity and revision are unavailable')
    const details = isRecord(draft.details) ? draft.details : {}
    const config = isRecord(draft.config) ? draft.config : {}
    const text = (value: unknown) => typeof value === 'string' ? value : ''
    // Parse before touching state. These throw on stored hours that no longer
    // parse, and assigning as we went left the flow half-restored — name and
    // address in place, hours silently empty — which the next save would have
    // written back over the hours the owner had already given.
    const openingHours = parseOpeningHours(details.openingHours as OpeningHours)
    const specialHours = parseSpecialHours(details.specialHours)

    const logoImage = restoredImage(draft.logoImage)
    const heroImage = restoredImage(draft.heroImage)

    state.value.draftId = draft.draftId
    state.value.draftRevision = draft.updatedAt
    state.value.vertical = draft.vertical === 'experience' || draft.vertical === 'service' ? draft.vertical : 'restaurant'
    state.value.source = draft.sourceType === 'google_places' ? 'google_places' : 'manual'
    state.value.placeId = typeof draft.placeId === 'string' && draft.placeId ? draft.placeId : null
    state.value.details.sourceLocale = typeof details.sourceLocale === 'string' ? details.sourceLocale : null
    state.value.details.name = text(details.name)
    state.value.details.city = text(details.city)
    state.value.details.streetAddress = text(details.streetAddress)
    state.value.details.addressLine2 = text(details.addressLine2)
    state.value.details.region = text(details.region)
    state.value.details.postalCode = text(details.postalCode)
    state.value.details.phone = text(details.phone)
    if (typeof details.country === 'string' && details.country) state.value.details.country = details.country
    if (typeof details.currency === 'string' && details.currency) {
      state.value.details.currency = details.currency as typeof state.value.details.currency
    }
    state.value.hours.timezone = text(details.timezone)
    state.value.hours.hours = openingHours
    state.value.hours.specialHours = specialHours
    state.value.brand.paletteStarter = text(config.palette_starter) || null
    state.value.brand.fontPreset = isOrganizationFontPreset(config.font_preset) ? config.font_preset : null
    state.value.brand.logoShape = (LOGO_SHAPES as readonly unknown[]).includes(config.logo_shape) ? config.logo_shape as LogoShape : null
    state.value.brand.logoImage = logoImage
    state.value.brand.heroImage = heroImage
    state.value.brand.logoPreviewUrl = logoImage?.publicUrl ?? ''
    state.value.brand.heroPreviewUrl = heroImage?.publicUrl ?? ''
    state.value.brand.logoNote = text(config.draft_logo_note)
    state.value.brand.heroPhotoNote = text(config.draft_hero_photo_note)
    state.value.brand.heroHeadline = text(config.draft_hero_headline)
    state.value.brand.heroSubtitle = text(config.draft_hero_subtitle)
    state.value.products = Array.isArray(draft.products)
      ? draft.products.flatMap(entry => isRecord(entry) && typeof entry.name === 'string'
        ? [{
            name: entry.name,
            category: typeof entry.category === 'string' ? entry.category : '',
            amountMinor: typeof entry.amountMinor === 'number' ? entry.amountMinor : null,
          }]
        : [])
      : []

    if (typeof draft.organizationId === 'string' && typeof draft.previewToken === 'string' && typeof draft.subdomainCandidate === 'string') {
      state.value.preview = {
        draftId: draft.draftId,
        organizationId: draft.organizationId,
        previewToken: draft.previewToken,
        draftName: typeof draft.draftName === 'string' ? draft.draftName : state.value.details.name,
        subdomainCandidate: draft.subdomainCandidate,
      }
    }
    return true
  }

  return { busy, error, save, seedFromPlace, activate, restore, activeDraftOrganizationId, discard, addressSummary }
}
