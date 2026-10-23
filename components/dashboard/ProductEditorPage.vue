<template>
  <DashboardIndexPanel
    id="product"
    :title="stayEditor ? 'Listing editor' : dishEditor ? 'Dish editor' : experienceEditor ? 'Experience editor' : pageTitle"
    :auto-open="autoOpenTarget"
    :create="firstStep"
    :paired-size="summaryCards ? 39 : undefined"
    :footer-class="summaryCards ? 'pointer-events-none absolute inset-x-0 bottom-6 border-0 py-0' : undefined"
  >
    <template v-if="product" #right>
      <DashboardResourceLocalization
      :organization-id="organizationId"
      resource-type="product"
      :resource-id="productId"
      :resource-label="itemLabel.toLowerCase()"
      :fields="productLocalizationFields"
      :load-values="loadProductLocalization"
      :save-values="saveProductLocalization"
      :language-settings-path="organizationLocalizationSettingsPath"
      />
    </template>

    <UAlert
      v-if="loadError"
      color="error"
      variant="soft"
      icon="i-lucide-triangle-alert"
      :title="`${itemLabel} could not be loaded`"
      :description="loadError"
    />
    <UTabs
      v-if="stayEditor && !loadError"
      :model-value="arrivalTab ? 'arrival' : 'space'"
      :items="[{ label: 'Your space', value: 'space', disabled: saving }, { label: 'Arrival guide', value: 'arrival', disabled: saving }]"
      :content="false"
      color="neutral"
      variant="pill"
      class="mx-auto mb-10 w-full max-w-82"
      :ui="{ list: 'rounded-full bg-muted', trigger: 'rounded-full data-[state=active]:text-highlighted', indicator: 'rounded-full bg-default shadow-sm' }"
      aria-label="Listing editor sections"
      @update:model-value="changeStayTab"
    />
    <UAlert v-if="arrivalTab && arrivalError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Arrival guide could not be loaded" :description="arrivalError" />
    <p v-if="arrivalTab && !arrivalHome && !arrivalError" role="status" class="mx-auto w-full max-w-82 text-base text-muted">Loading arrival guide…</p>
    <!-- What this home costs on the plan, from the quote the write is decided by: included, billed, or past what Basic includes. -->
    <UAlert v-if="homeQuoteError" class="mx-auto mb-6 w-full max-w-82" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(homeQuoteError, 'The plan could not be read')" />
    <p v-else-if="homeBilling" data-testid="home-billing-line" class="mx-auto mb-6 w-full max-w-82 text-sm text-muted">
      {{ homeBilling.text }}
      <NuxtLink v-if="homeBilling.billing" :to="homeBilling.billing" class="font-medium text-highlighted underline">Plan and billing</NuxtLink>
    </p>
    <EditorNavigationList
      v-if="!loadError && (!arrivalTab || (arrivalHome && !arrivalError))"
      :groups="navigationGroups"
      :active-item="activeNavigationItem"
      :variant="summaryCards ? 'cards' : 'rows'"
      :class="summaryCards ? 'mx-auto w-full max-w-82 pb-24' : undefined"
      :data-testid="stayEditor ? 'stay-editor-cards' : dishEditor ? 'dish-editor-cards' : experienceEditor ? 'experience-editor-cards' : undefined"
    >
      <template v-if="summaryCards" #summary="{ item }">
        <span v-if="arrivalTab && item.id === 'arrival-time'" class="grid grid-cols-2 gap-4 text-base">
          <span class="block border-r border-default pr-4"><span class="block font-medium text-highlighted">Check-in</span><span class="mt-1 block">{{ product?.stay ? stayCheckInWindow(product.stay.check_in_time, product.stay.check_in_end_time) : '' }}</span></span>
          <span class="block"><span class="block font-medium text-highlighted">Checkout</span><span class="mt-1 block">{{ product?.stay?.check_out_time }}</span></span>
        </span>
        <span v-else-if="item.id === 'name'" class="block text-xl font-medium leading-snug text-highlighted">{{ item.summary }}</span>
        <template v-else-if="stayEditor && item.id === 'photo'">
          <span class="sr-only">{{ item.summary }}</span>
          <span v-if="stayPhotos.length" class="relative mt-6 block h-44" aria-hidden="true">
            <img
              v-for="(photo, index) in stayPhotos.slice(0, 3)"
              :key="photo"
              :src="photo"
              alt=""
              class="absolute left-1/2 top-0 h-44 w-36 rounded-3xl object-cover"
              :class="index === 0 ? 'z-20 -translate-x-1/2' : index === 1 ? 'z-10 -translate-x-[90%] rotate-[-5deg] scale-90' : 'z-0 -translate-x-[10%] rotate-[5deg] scale-90'"
            >
            <span class="absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-full bg-default px-3 py-1 text-xs text-highlighted">{{ photoAssets.length }} {{ photoAssets.length === 1 ? 'photo' : 'photos' }}</span>
          </span>
          <span v-else class="mt-6 flex flex-col items-center gap-3 rounded-xl bg-muted px-4 py-8 text-sm">
            <UIcon name="i-lucide-image-plus" class="size-8 text-dimmed" aria-hidden="true" />
            Add your first photo
          </span>
        </template>
        <span v-else-if="(dishEditor || experienceEditor) && item.icon" class="flex items-start gap-3">
          <UIcon :name="item.icon" class="size-6 shrink-0" aria-hidden="true" />
          <span class="whitespace-pre-line break-words">{{ item.summary }}</span>
        </span>
        <span v-else-if="item.id === 'amenities' && stayAmenityPreview.length" class="mt-3 block space-y-2 text-sm text-highlighted">
          <span v-for="amenity in stayAmenityPreview.slice(0, 3)" :key="amenity.code" class="flex items-center gap-3">
            <UIcon :name="amenity.icon" class="size-6 shrink-0" aria-hidden="true" />
            {{ amenity.label }}
          </span>
          <span v-if="stayAmenityPreview.length > 3" class="block pt-3 text-muted">+ {{ stayAmenityPreview.length - 3 }} more</span>
        </span>
        <span v-else-if="item.id === 'cancellation'" class="block space-y-2">
          <span class="block">{{ item.summary }}{{ product?.stay?.cancellation_policy ? ' for short-term stays' : '' }}</span>
          <span v-if="product?.stay?.long_term_cancellation_policy" class="block">{{ STAY_LONG_TERM_CANCELLATION_POLICIES[product.stay.long_term_cancellation_policy].label }} for long-term stays</span>
        </span>
        <span v-else :class="arrivalTab || dishEditor || experienceEditor ? 'line-clamp-4 whitespace-pre-line break-words' : item.id === 'description' ? 'line-clamp-4' : undefined">{{ item.summary }}</span>
      </template>
    </EditorNavigationList>
    <template v-if="summaryCards && canPreview" #footer>
      <div class="flex justify-center">
        <UButton ref="previewButton" :to="arrivalTab ? sectionPath('arrival-guide') : previewPath" :target="arrivalTab ? '_blank' : undefined" label="View" icon="i-lucide-eye" color="neutral" class="pointer-events-auto h-12 rounded-full px-6 shadow-lg" :disabled="saving" />
      </div>
    </template>
  </DashboardIndexPanel>
  <UModal
    v-model:open="previewOpen"
    :title="previewTitle"
    fullscreen
    :close="{ color: 'neutral', variant: 'soft' }"
    :ui="{ header: 'grid grid-cols-[1fr_auto_1fr] gap-3', wrapper: 'sr-only', close: 'static col-start-1 row-start-1 size-10 justify-self-start rounded-full', body: 'min-h-0 p-0 sm:p-0' }"
    @after:leave="restorePreviewFocus"
  >
    <template #actions>
      <UTabs
        :model-value="previewViewport ?? undefined"
        :items="[{ label: 'Desktop view', value: 'desktop' }, { label: 'Mobile view', value: 'mobile' }]"
        :content="false"
        size="sm"
        color="neutral"
        variant="pill"
        aria-label="Preview device"
        class="hidden col-start-2 row-start-1 lg:block"
        @update:model-value="changePreviewViewport"
      />
    </template>
    <template #body>
      <div v-if="previewNeedsLocation" class="mx-auto w-full max-w-2xl p-6">
        <h2 class="mb-8 text-2xl font-semibold text-highlighted">Choose a location to preview</h2>
        <UAlert v-if="locationsError" color="error" :description="getErrorMessage(locationsError, 'Locations could not be loaded')" />
        <p v-else-if="locationsPending" role="status">Loading locations…</p>
        <EditorNavigationList v-else-if="previewLocationChoices[0]?.items.length" :groups="previewLocationChoices" />
        <UEmpty v-else title="This dish has no locations" description="Add the dish to a location to preview its menu page." :actions="[{ label: 'Locations', to: sectionPath('locations'), color: 'neutral' }]" />
      </div>
      <UAlert v-else-if="previewFailure" color="error" variant="soft" :title="`${previewTitle} could not be opened`" :description="previewFailure" class="m-6" />
      <div v-else class="flex h-full min-h-0 justify-center overflow-auto bg-muted">
        <iframe
          v-if="previewRequested && productPreviewUrl"
          :src="productPreviewUrl"
          :title="previewTitle"
          sandbox="allow-same-origin allow-scripts allow-forms"
          class="h-full min-h-0 w-full border-0 bg-default"
          :class="previewViewport === 'mobile' ? 'max-w-[390px]' : undefined"
        />
      </div>
    </template>
  </UModal>
</template>

<script lang="ts">
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { Collection, Product } from '~/server/types/products'
import type { StayAmenity, StayAmenityAnswer, StayCancellationPolicy, StayListingType, StayLongTermCancellationPolicy, StayPropertySizeUnit, StayPropertyType, StayPropertyTypeGroup } from '~/shared/stay-listing'
import type { DashboardLocation } from '~/composables/useDashboardOrganization'
import type { GalleryMediaItem } from '~/components/dashboard/DashboardMediaGalleryField.vue'
import type { StayArrivalGuide, StayArrivalField } from '~/shared/stay-arrival'
import type { StaySafetySection } from '~/shared/stay-safety'
import type { StayPhotoRoom, StayPhotoRoomType } from '~/shared/stay-photos'
import type { StayRoomAccessibility, StayHomeAccessibility } from '~/shared/stay-accessibility'

export const SECTION_KEYS = [
  'photo', 'kind', 'name', 'price', 'description', 'page', 'options', 'order-url', 'attributes', 'publication', 'booking', 'locations', 'collections',
  'stay', 'guests', 'availability', 'arrival-time', 'directions', 'check-in-method', 'wifi', 'house-manual', 'house-rules', 'checkout-instructions', 'arrival-guide', 'property-type', 'rooms', 'amenities', 'accessibility', 'cancellation', 'team', 'guest-safety', 'location',
] as const
export type SectionKey = typeof SECTION_KEYS[number]
export type BookingConcern = 'enabled' | 'duration' | 'capacity' | 'confirmation' | 'payment' | 'location' | 'assignment' | number
export type ProductConcern = BookingConcern | 'publication-visibility' | 'publication-availability' | 'house-rules' | 'additional-rules' | 'arrival-time' | StaySafetySection

/** Where the product is offered and shown, per location, as its Locations leaf edits it. */
export interface ProductLocationDraft { active: boolean; published: boolean }

export interface ScheduleSlotDraft { weekday: number; start_time: string }

export interface OptionValueDraft { id: string | null; value: string }
export interface OptionDraft { id: string; name: string; values: OptionValueDraft[] }
export interface VariantDraft {
  /**
   * The combination of option values this variant selects, not its row id.
   *
   * A rebuild after an option edit looks a variant up by the combination it
   * describes; keying by id here made every surviving combination look new,
   * which took its id and its prices with it.
   */
  key: string
  id: string | null
  name: string
  selections: Record<string, string>
  /** Restated on save: a submitted variant is its complete state. */
  sku: string | null
  active: boolean
  price_major: string
  /** The amount this box held when the product was loaded. */
  loaded_price_major: string
  /** Every offer this variant already has, kept whole so an edit here cannot retire the others. */
  prices: Price[]
}

/** The editable shape of one product, as its leaves bind to it. */
export interface ProductForm {
  kind: ProductKind | ''
  name: string
  description: string
  order_url: string
  options: OptionDraft[]
  variants: VariantDraft[]
  details: Record<string, ProductDetailValue>
  active: boolean
  published: boolean
  /** Keyed by location id; a location the product is not offered at has no entry. */
  locations: Record<string, ProductLocationDraft>
  collection_ids: string[]
  bookable: boolean
  booking_duration: string
  booking_capacity: string
  confirmation_mode: 'instant' | 'review'
  scheduling_mode: 'legacy' | 'provider'
  /** null: the business schedule rather than a member or team. */
  assigned_member_id: string | null
  assigned_team_id: string | null
  online_payment_required: boolean
  /** Held online: booked in the provider's working hours rather than weekly times at a location. */
  held_online: boolean
  image_asset_id: string | null
  /** A place to stay's one location, fixed once it is created, and its stay settings. */
  stay_location_id: string
  check_in_time: string
  /** The end of the check-in window; empty is a flexible end. */
  check_in_end_time: string
  check_out_time: string
  max_guests: string
  min_nights: string
  /** Null is the home looked after by owners and admins only: no team is assigned. */
  stay_team_id: string | null
  /** Kept as loaded: this editor assigns a team, and saving never clears a member set elsewhere. */
  stay_member_id: string | null
  stay_property_type_group: StayPropertyTypeGroup | null
  stay_property_type: StayPropertyType | null
  stay_listing_type: StayListingType | null
  stay_total_floors: string
  stay_listing_floor: string
  stay_year_built: string
  stay_property_size: string
  stay_property_size_unit: StayPropertySizeUnit | null
  stay_bedrooms: string
  stay_beds: string
  stay_bathrooms: string
  stay_amenities: StayAmenity[]
  stay_amenity_answers: StayAmenityAnswer[]
  stay_cancellation_policy: StayCancellationPolicy | null
  stay_long_term_cancellation_policy: StayLongTermCancellationPolicy | null
}

/** The product's draft and what its leaves show or do beside their one field. */
export interface ProductEditor {
  form: ProductForm
  /** The host by its loaded name, or what is missing. */
  assignmentSummary: ComputedRef<string>
  product: ComputedRef<Product | null>
  /** Saved publication state, separate from the visibility leaf's draft. */
  published: ComputedRef<boolean>
  bookingOffering: ComputedRef<boolean>
  itemLabel: ComputedRef<string>
  currency: string
  organizationId: string
  /** The physical location this editor targets, or null for organization and online scopes. */
  locationId: ComputedRef<string | null>
  /** The location the scope names, once the organization's locations have loaded. */
  location: ComputedRef<DashboardLocation | null>
  /** The home's saved location, independent of the catalog's URL scope. */
  stayLocation: ComputedRef<DashboardLocation | null>
  stayLocationError: ComputedRef<string | null>
  organizationLocations: ComputedRef<DashboardLocation[]>
  /** Saved location facts, including inactive places that still own product relationships. */
  allOrganizationLocations: ComputedRef<DashboardLocation[]>
  organizationLocationsError: ComputedRef<string | null>
  /** Every collection the organization has, site-wide and per location. */
  collections: ComputedRef<Collection[]>
  /** A URL beneath this record that keeps its scope. */
  sectionPath: (section: string) => string
  definitions: Ref<ProductDetailField[]>
  isNew: ComputedRef<boolean>
  /** Why the product this route names could not be read; a leaf shows it and offers nothing to edit. */
  loadError: ComputedRef<string | null>
  sectionLabels: Record<SectionKey, string>
  saving: Ref<boolean>
  reload: () => Promise<void>
  saveError: Ref<string | null>
  photoError: Ref<string | null>
  saveLabel: Ref<string>
  saveDisabled: Ref<boolean>
  propertyTypeErrors: ComputedRef<Record<string, string>>
  setPrimaryImage: (assetId: string | null) => Promise<void>
  /** The photos after the cover, in order, and an empty row while one is being chosen. */
  galleryRows: ComputedRef<GalleryMediaItem[]>
  addGalleryRow: () => void
  setGalleryAsset: (index: number, asset: { asset_id: string } | null) => Promise<void>
  removeGalleryPhoto: (index: number) => Promise<void>
  moveGalleryPhoto: (from: number, to: number) => Promise<void>
  /** The Product's cover and gallery, in the same order guests see them. */
  photoAssets: ComputedRef<Product['gallery']>
  photoRooms: ComputedRef<StayPhotoRoom[]>
  createStayPhotoRoom: (type: StayPhotoRoomType) => Promise<StayPhotoRoom | null>
  updateStayPhotoRoom: (roomId: string, patch: Pick<StayPhotoRoom, 'details_version'> & Partial<Pick<StayPhotoRoom, 'sleeping_arrangements' | 'private_attached_bathroom' | 'amenities'>> & { accessibility?: StayRoomAccessibility }) => Promise<boolean>
  updateStayAccessibility: (answer: StayHomeAccessibility, expectedUpdatedAt: string) => Promise<boolean>
  deleteStayPhotoRoom: (roomId: string) => Promise<boolean>
  moveStayPhotos: (photos: Array<{ photo_id: string; expected_room_id: string | null }>, target: { room_id: string | null } | { new_room_type: StayPhotoRoomType }) => Promise<boolean>
  addStayPhoto: (assetId: string, roomId?: string) => Promise<boolean>
  reorderStayPhotos: (photoIds: string[]) => Promise<boolean>
  describeStayPhoto: (photoId: string, text: string) => Promise<boolean>
  removeStayPhotos: (photoIds: string[]) => Promise<boolean>
  /** Make the page this product owns, when it has none; opening Page content never does. */
  createPage: () => Promise<void>
  addOption: () => void
  removeOption: (index: number) => void
  setOptionValues: (index: number, values: string[]) => void
  setDetail: (definition: ProductDetailField, value: ProductDetailValue) => void
  listValue: (definition: ProductDetailField) => string[]
  textValue: (definition: ProductDetailField) => string
  weekdays: ReadonlyArray<{ value: number; label: string }>
  scheduleError: ComputedRef<string | null>
  reloadSchedule: () => Promise<void>
  savedSlotsFor: (weekday: number) => ScheduleSlotDraft[]
  slotsFor: (weekday: number) => ScheduleSlotDraft[]
  addSlot: (weekday: number) => void
  removeSlot: (slot: ScheduleSlotDraft) => void
  revert: (concern?: 'additional-rules' | 'arrival-time' | StaySafetySection) => void
  /**
   * Commit the draft, then close the open leaf. A leaf nested below a section
   * (one option, one combination's price) names its own parent, so the save
   * lands where its Close would rather than back on the product.
   */
  save: (closeTo?: string, concern?: ProductConcern) => Promise<void>
  /** Private StayHome fields remain outside the public Product and its draft. */
  arrivalHome: ComputedRef<StayArrivalGuide | null>
  arrivalDraft: Ref<StayArrivalGuide | null>
  arrivalError: ComputedRef<string | null>
  arrivalManage: ComputedRef<boolean>
  arrivalChanged: (fields: readonly StayArrivalField[]) => boolean
  saveArrival: (fields: readonly StayArrivalField[], closeTo?: string) => Promise<void>
}

export const productEditorKey = Symbol('product-editor') as InjectionKey<ProductEditor>
</script>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import type { ProductDetailField, ProductDetailKey, ProductDetailValue, ProductKind } from '~/shared/product-details'
import { productDetailFields, PRODUCT_KINDS, PRODUCT_KIND_LABELS, assertProductKind, productDetailKey, PRICING_NOTE_HANDLE, STAY_DESCRIPTION_DETAIL_KEYS, STAY_HOUSE_RULE_DETAIL_KEYS, STAY_LOCATION_DETAIL_KEYS, isStayFocusedDetail, stayHouseRuleLines } from '~/shared/product-details'
import { STAY_SAFETY_DETAIL_KEYS, STAY_SAFETY_SECTIONS, staySafetyLines, staySafetySectionKeys, stayAlarmLines } from '~/shared/stay-safety'
import { isCurrencyCode } from '~/shared/currencies'
import { majorAmountToMinor, minorAmountToMajor, selectPrice, type Price } from '~/shared/prices'
import { formatProductMoney } from '~/utils/product-money'
import { formatPlanPrice } from '~/shared/billing-model'
import { useHomesQuote } from '~/composables/usePaymentsSettings'
import { formatPostalAddress } from '~/utils/postal-address'
import { isSuccessfulChannelPush, type SuccessfulChannelPush } from '~/shared/channel-push'
import { ApiClientError } from '~/utils/api-clients'
import { isStayArrivalGuide, stayCheckInWindow } from '~/shared/stay-arrival'
import type { ProductMutation } from '~/server/utils/product-management'
import { presentationForProduct } from '~/utils/product-presentation'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'
import { mediaStillUrl, uniqueMediaAssets } from '~/shared/media-placement-contract'
import { formatTime, MINUTE_TIME_PATTERN } from '~/utils/timezone'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'
import { isNavigationFailure } from 'vue-router'
import { dashboardOverlayOpenKey } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
import { STAY_HOME_ACCESSIBILITY_FEATURES, isStayHomeAccessibility } from '~/shared/stay-accessibility'
import {
  STAY_PROPERTY_TYPES,
  STAY_LISTING_TYPES,
  STAY_AMENITIES,
  STAY_ALARM_AMENITIES,
  stayAmenityAvailability,
  isStayAmenityAnswers,
  STAY_PROPERTY_TYPE_GROUPS,
  STAY_CANCELLATION_POLICIES,
  STAY_LONG_TERM_CANCELLATION_POLICIES,
  STAY_CHECK_IN_METHODS,
  isStayPropertyType,
} from '~/shared/stay-listing'

const route = useRoute()
const { locale } = useI18n()
const { formatExactDateTime } = useHumanTime()
const router = useRouter()
const dashboardApi = useDashboardApi()
const productId = computed(() => String(route.params.productId ?? ''))
// Catalog's explicit scope. No location is the whole organization: its own
// prices and settings, not whichever location was visited last.
const locationScope = useLocationScope()
// Online is an explicit booking scope, never a physical location or a Price location id.
const locationId = computed(() => locationScope.value === 'online' ? null : locationScope.value)
// A product created from a collection joins it; the URL that opened the walk names it.
const createCollectionId = computed(() => typeof route.query.collection_id === 'string' && route.query.collection_id ? route.query.collection_id : null)
const level = useRouteLevel()
/** The record's own URL. It is the route level's, never rebuilt from params. */
const itemPath = level.path
const catalogPath = computed(() => `/dashboard/${String(route.params.orgSlug)}/products`)
/**
 * A URL beneath this record. An existing product's sections keep its location
 * scope and nothing else; a product being created keeps the whole walk's query,
 * which names its kind and the collection it will join.
 */
function sectionPath(section: string) {
  const query = isNew.value ? route.query : { location_id: locationScope.value ?? undefined, ...(arrivalTab.value ? { guide: 'arrival' } : {}) }
  return router.resolve({ path: `${itemPath.value}/${section}`, query }).fullPath
}

const organizationId = await useDashboardOrganizationId()
const { refresh: refreshCatalog, collectionProductIds, setCollectionProducts } = useProductCatalog(organizationId, ref(null))
const dashboard = useDashboardOrganization()
// The context mints a site-wide preview token. Assigned Product access alone
// does not authorize unpublished content elsewhere in the organization.
const canPreview = computed(() => {
  const role = dashboard.organization.value?.role
  return Boolean(role) && authClient.organization.checkRolePermission({ role: role as keyof typeof organizationRoles, permissions: { content: ['read'] } })
})
const { locations: allOrganizationLocations, error: locationsError, pending: locationsPending } = await useOrganizationLocations({ includeInactive: true })
const organizationLocations = computed(() => allOrganizationLocations.value.filter(entry => entry.status === 'active'))
const location = computed(() => allOrganizationLocations.value.find(entry => entry.id === locationId.value) ?? null)

const vertical = dashboard.organization.value?.vertical
if (!vertical) throw createError({ statusCode: 500, statusMessage: 'Organization vertical is not configured' })
// The words follow the product's kind: a class is an experience whatever the
// site sells otherwise. Until a kind is loaded or chosen there are no words for
// it, and the screen says only that it is a product.
const presentation = computed(() => {
  const kind = product.value?.kind ?? form.kind
  return kind ? presentationForProduct(vertical, { kind: assertProductKind(kind) }, dashboard.organization.value?.theme_id) : null
})
const itemLabel = computed(() => presentation.value?.itemLabel ?? 'Product')
const rawCurrency = dashboard.organization.value?.default_currency
if (!isCurrencyCode(rawCurrency)) throw createError({ statusCode: 500, statusMessage: 'Unsupported organization currency' })
const currency = rawCurrency

// ── Which leaf is open ──────────────────────────────────

const sectionLabels: Record<SectionKey, string> = {
  'kind': 'Type',
  'photo': 'Photos',
  'name': 'Name',
  'price': 'Price',
  get description() { return product.value?.kind === 'experience' ? 'What you’ll do' : 'Description' },
  'page': 'Page content',
  'options': 'Variants',
  get 'order-url'() { return product.value?.kind === 'experience' ? 'External booking link' : 'External link' },
  get attributes() { return product.value?.kind === 'dish' ? 'Food information' : 'Details' },
  'publication': 'Status',
  get booking() { return product.value?.kind === 'experience' ? 'Bookings' : 'Scheduling' },
  'locations': 'Locations',
  'stay': 'Stay settings',
  'guests': 'Number of guests',
  'availability': 'Availability',
  'arrival-time': 'Check-in & checkout',
  'directions': 'Directions',
  'check-in-method': 'Check-in method',
  'wifi': 'Wifi details',
  'house-manual': 'House manual',
  'house-rules': 'House rules',
  'guest-safety': 'Guest safety',
  'location': 'Location',
  'checkout-instructions': 'Checkout instructions',
  'arrival-guide': 'Arrival guide',
  'property-type': 'Property type',
  'rooms': 'Rooms and beds',
  'amenities': 'Amenities',
  'accessibility': 'Accessibility features',
  'cancellation': 'Cancellation policy',
  'team': 'Looked after by',
  // Only a product with a kind has collections to choose.
  get collections() {
    if (!presentation.value) throw new Error('A product has no collections before its kind is chosen')
    return product.value?.kind === 'dish' ? 'Menu sections' : presentation.value.collectionGroupLabelPlural
  },
}

const detailKey = computed(() => level.child.value)
const editorKey = computed<SectionKey>(() => (detailKey.value ?? 'photo') as SectionKey)

const isNew = computed(() => productId.value === 'new')


// ── Load ────────────────────────────────────────────────
const definitions = computed(() => form.kind ? productDetailFields(form.kind) : [])
const mainHouseRuleKeys = STAY_HOUSE_RULE_DETAIL_KEYS.filter(key => key !== 'house_rules')
const saveError = ref<string | null>(null)
const photoError = ref<string | null>(null)
const saving = ref(false)

watch(editorKey, () => {
  if (!stayEditor.value && product.value) loadForm(product.value)
  saveError.value = null
  photoError.value = null
})

const isCollectionList = (value: unknown): value is { collections: Collection[] } =>
  isRecord(value) && Array.isArray(value.collections)
const isOne = (value: unknown): value is { success: true, product: Product } =>
  isRecord(value) && isRecord(value.product)
const isMutation = (value: unknown): value is { success: true; product: ProductMutation } =>
  isOne(value) && value.success === true && 'channel_push' in value.product && isSuccessfulChannelPush(value.product.channel_push)


// The product in this scope, read before the level renders. Keyed by location
// and product, so a scope change reads that location's prices and settings.
const { data: loaded, error: loadFailure, refresh } = await useAsyncData(
  () => `dashboard-product:${organizationId}:${locationScope.value ?? 'organization'}:${productId.value}`,
  async () => {
    if (isNew.value) return null
    const id = locationId.value
    const [collectionResponse, productResponse] = await Promise.all([
      // Every collection, site-wide and per location: membership is the
      // product's, wherever the grouping lives.
      dashboardApi(`/api/editor/organizations/${organizationId}/collections`, { validate: isCollectionList }),
      dashboardApi(id ? `/api/editor/organizations/${organizationId}/locations/${encodeURIComponent(id)}/products/${encodeURIComponent(productId.value)}` : `/api/editor/organizations/${organizationId}/products/${encodeURIComponent(productId.value)}`, { validate: isOne }),
    ])
    if (locationScope.value === 'online' && !productResponse.product.booking?.held_online) throw createError({ statusCode: 404, statusMessage: 'This product is not held online' })
    let previewToken: string | null = null
    if (canPreview.value && ['stay', 'dish', 'experience'].includes(productResponse.product.kind)) {
      const response = await dashboardApi(`/api/editor/organizations/${organizationId}/context`, { validate: isRecord })
      if (!isRecord(response.context) || typeof response.context.previewToken !== 'string' || !response.context.previewToken) throw new Error('The product preview could not be loaded.')
      previewToken = response.context.previewToken
    }
    return { collections: collectionResponse.collections, product: productResponse.product, previewToken }
  },
)
const product = computed(() => loaded.value?.product ?? null)
const stayLocation = computed(() => allOrganizationLocations.value.find(entry => entry.id === product.value?.stay?.location_id) ?? null)
const stayLocationError = computed(() => {
  if (!product.value?.stay) return null
  if (locationsError.value) return getErrorMessage(locationsError.value, 'The listing’s location could not be loaded')
  return !locationsPending.value && !stayLocation.value ? 'The listing’s saved location could not be found.' : null
})
const published = computed(() => product.value?.publications.some(entry => entry.organization_id === organizationId && entry.published) === true)
const bookingOffering = computed(() => Boolean(product.value?.booking) || ['stay', 'experience', 'service'].includes(product.value?.kind ?? ''))
const collections = computed(() => loaded.value?.collections ?? [])
const stayEditor = computed(() => product.value?.kind === 'stay')
const dishEditor = computed(() => product.value?.kind === 'dish')
const experienceEditor = computed(() => product.value?.kind === 'experience')
const summaryCards = computed(() => stayEditor.value || dishEditor.value || experienceEditor.value)
const ARRIVAL_SECTIONS = ['arrival-time', 'directions', 'check-in-method', 'wifi', 'house-manual', 'checkout-instructions', 'arrival-guide']
const arrivalTab = computed(() => stayEditor.value && (route.query.guide === 'arrival' || ARRIVAL_SECTIONS.includes(detailKey.value ?? '')))
async function changeStayTab(value: string | number) {
  if (saving.value || value === (arrivalTab.value ? 'arrival' : 'space')) return
  revert()
  await navigateTo(router.resolve({ path: itemPath.value, query: { location_id: locationId.value ?? undefined, ...(value === 'arrival' ? { guide: 'arrival' } : {}) } }).fullPath)
}

// The home's private arrival guide is read only inside its authenticated editor.
// A role without operations access can continue editing the public Product.
const arrivalUrl = () => `/api/dashboard/stay-homes/${encodeURIComponent(productId.value)}`
const isArrivalResponse = (value: unknown): value is { home: StayArrivalGuide; manage: boolean } =>
  isRecord(value) && isStayArrivalGuide(value.home) && typeof value.manage === 'boolean' && value.home.product_id === productId.value
const isArrivalMutation = (value: unknown): value is { home: StayArrivalGuide; channel_push: SuccessfulChannelPush | null } =>
  isRecord(value) && isStayArrivalGuide(value.home) && value.home.product_id === productId.value && isSuccessfulChannelPush(value.channel_push)
const { data: arrivalLoaded, error: arrivalFailure, refresh: refreshArrival } = await useAsyncData(
  () => `dashboard-product-arrival:${organizationId}:${productId.value}:${arrivalTab.value ? 'open' : 'closed'}`,
  async () => arrivalTab.value ? await dashboardApi(arrivalUrl(), { validate: isArrivalResponse }) : null,
)
const arrivalHome = computed(() => arrivalLoaded.value?.home ?? null)
const arrivalManage = computed(() => arrivalLoaded.value?.manage === true)
const arrivalError = computed(() => arrivalFailure.value ? getErrorMessage(arrivalFailure.value, 'The arrival guide could not be loaded') : null)
const arrivalDraft = ref<StayArrivalGuide | null>(null)
function revertArrival() {
  const home = arrivalHome.value
  arrivalDraft.value = home ? { product_id: home.product_id, check_in_method: home.check_in_method, check_in_instructions: home.check_in_instructions, wifi_network: home.wifi_network, wifi_password: home.wifi_password, directions: home.directions, house_manual: home.house_manual, checkout_instructions: home.checkout_instructions.map(instruction => ({ ...instruction })) } : null
}
// A read after a failed write updates saved state without erasing the edits
// being submitted. A confirmed save below, or Cancel, resets the draft.
watch(arrivalHome, () => { if (!saving.value) revertArrival() }, { immediate: true, flush: 'sync' })
function arrivalChanged(fields: readonly StayArrivalField[]) {
  return Boolean(arrivalHome.value && arrivalDraft.value && fields.some(field => JSON.stringify(arrivalHome.value![field]) !== JSON.stringify(arrivalDraft.value![field])))
}
async function saveArrival(fields: readonly StayArrivalField[], target?: string) {
  if (saving.value) return
  saving.value = true
  saveError.value = null
  try {
    const draft = arrivalDraft.value
    if (!draft || arrivalError.value) throw new Error('Load the arrival guide before saving it.')
    if (!arrivalManage.value) throw new Error('Your role cannot edit this arrival guide.')
    const body: Record<string, unknown> = {}
    for (const field of fields) {
      const value = draft[field]
      body[field] = typeof value === 'string' ? (value.trim() ? (field === 'wifi_password' ? value : value.trim()) : null) : value
    }
    try {
      await dashboardApi(arrivalUrl(), { method: 'PATCH', body, validate: isArrivalMutation })
    } catch (error) {
      saveError.value = getErrorMessage(error, 'The arrival guide could not be saved')
      // A failed response may follow a committed write. Show the persisted
      // state again, and retain both failures if that read cannot complete.
      try {
        await refreshArrival()
        if (arrivalFailure.value) throw arrivalFailure.value
      } catch (readError) {
        saveError.value += ` The arrival guide could not be read again: ${getErrorMessage(readError, 'Read failed')}`
      }
      return
    }
    await refreshArrival()
    if (arrivalFailure.value) throw arrivalFailure.value
    revertArrival()
    await (target ? navigateTo(target) : level.close())
  } catch (error) {
    saveError.value = getErrorMessage(error, 'The arrival guide could not be saved')
  } finally {
    saving.value = false
  }
}
const runtimeConfig = useRuntimeConfig()
const previewTitle = computed(() => dishEditor.value ? 'Dish preview' : experienceEditor.value ? 'Experience preview' : 'Listing preview')
const previewLocationId = computed(() => typeof route.query.preview_location_id === 'string' ? route.query.preview_location_id : locationId.value)
const previewNeedsLocation = computed(() => canPreview.value && dishEditor.value && !previewLocationId.value)
const previewLocationChoices = computed<EditorNavigationGroup[]>(() => [{ id: 'preview-locations', items: allOrganizationLocations.value
  .filter(entry => product.value?.locations.some(placement => placement.location_id === entry.id))
  .map(entry => ({ id: entry.id, label: entry.title, summary: entry.status === 'active' ? 'View the saved dish at this location' : 'Location inactive',
    ...(entry.status === 'active' ? { to: router.resolve({ path: route.path, query: { ...route.query, preview_location_id: entry.id } }).fullPath } : {}),
  })),
}])
const productPreviewUrl = computed(() => {
  const row = product.value
  const subdomain = dashboard.organization.value?.subdomain
  const token = loaded.value?.previewToken
  if (!row || !summaryCards.value || !subdomain || !token) return null
  const origin = tenantOrganizationOrigin({
    platformDomain: String(runtimeConfig.public.platformDomain),
    freeOrganizationDomain: String(runtimeConfig.public.freeOrganizationDomain),
    subdomain,
  })
  if (!origin) return null
  const target = dishEditor.value ? allOrganizationLocations.value.find(entry => entry.id === previewLocationId.value && entry.status === 'active'
    && row.locations.some(placement => placement.location_id === entry.id)) : null
  if (dishEditor.value && !target) return null
  const path = presentation.value?.productPath(target?.slug ?? '', row.slug)
  if (!path) return null
  const url = new URL(path, origin)
  url.searchParams.set('preview_token', token)
  if (experienceEditor.value && locationScope.value) url.searchParams.set('location_id', locationScope.value)
  return url.toString()
})
// Preview is a mode of the editor currently open, so its URL reconstructs the
// same concern and closing never needs a second return-path model.
const previewButton = useTemplateRef('previewButton')
const previewRequested = computed(() => route.query.editMode === 'preview')
provide(dashboardOverlayOpenKey, previewRequested)
const previewViewport = computed(() => route.query.previewViewport === undefined ? 'desktop'
  : route.query.previewViewport === 'desktop' || route.query.previewViewport === 'mobile' ? route.query.previewViewport : null)
const previewNavigationError = ref('')
const previewPath = computed(() => router.resolve({ path: route.path, query: { ...route.query, editMode: 'preview', previewViewport: 'desktop' }, hash: route.hash }).fullPath)
const previewFailure = computed(() => previewNavigationError.value || loadError.value || (!canPreview.value ? 'Your role does not have access to website previews.'
  : !summaryCards.value ? 'This product does not have a preview here.'
  : !productPreviewUrl.value ? 'The saved page or its selected location could not be loaded for preview.'
    : !previewViewport.value ? 'Choose Desktop view or Mobile view to open this preview.' : ''))
const previewOpen = computed({
  get: () => previewRequested.value,
  set: (open: boolean) => { if (!open) void closePreview() },
})
watch(() => route.fullPath, () => { previewNavigationError.value = '' })
async function closePreview() {
  try {
    const result = await navigateTo({ path: route.path, query: { ...route.query, editMode: undefined, previewViewport: undefined, preview_location_id: undefined }, hash: route.hash })
    if (isNavigationFailure(result)) throw result
  } catch (error) {
    previewNavigationError.value = getErrorMessage(error, 'The preview could not be closed')
  }
}
async function changePreviewViewport(value: string | number) {
  if (value !== 'desktop' && value !== 'mobile') return
  try {
    const result = await navigateTo({ path: route.path, query: { ...route.query, previewViewport: value }, hash: route.hash }, { replace: true })
    if (isNavigationFailure(result)) throw result
  } catch (error) {
    previewNavigationError.value = getErrorMessage(error, 'The preview device could not be changed')
  }
}
function restorePreviewFocus() {
  if (previewButton.value?.$el instanceof HTMLElement && previewButton.value.$el.isConnected) previewButton.value.$el.focus({ preventScroll: true })
}
const photoAssets = computed(() => product.value ? uniqueMediaAssets([...(product.value.image ? [product.value.image] : []), ...product.value.gallery]) : [])
const photoRooms = computed(() => product.value?.stay?.photo_rooms ?? [])
const stayPhotos = computed(() => photoAssets.value.map(mediaStillUrl).filter((url): url is string => Boolean(url)))
const stayAmenityPreview = computed(() => (product.value?.stay?.amenities ?? []).map(code => ({ code, ...STAY_AMENITIES[code] })).sort((left, right) => left.label.localeCompare(right.label)))
const savedHouseRules = computed(() => product.value?.kind === 'stay' ? stayHouseRuleLines(product.value.details, value => formatTime(value, locale.value)) : [])
const savedSafety = computed(() => product.value?.kind === 'stay' ? [
  ...staySafetyLines(product.value.details, { includeNo: true }),
  ...stayAlarmLines(product.value.stay!.amenity_answers, product.value.details),
] : [])
// A product that is not there is not a page. A request that failed is a state
// this level shows, because the product may well still exist.
watchEffect(() => {
  if (loadFailure.value && isNotFoundError(loadFailure.value)) showError(createError({ statusCode: 404, statusMessage: `${itemLabel.value} not found` }))
})
/**
 * A place to stay always has its stay settings. Missing or malformed ones are a
 * read that failed, never times and nights to make up.
 */
const stayConfigError = computed(() => {
  const row = product.value
  if (!row || row.kind !== 'stay') return null
  const stay = row.stay
  if (!stay) return 'This place to stay has no stay settings.'
  const invalid = [
    !stay.location_id && 'location',
    !MINUTE_TIME_PATTERN.test(stay.check_in_time) && 'check-in time',
    !MINUTE_TIME_PATTERN.test(stay.check_out_time) && 'checkout time',
    !(Number.isInteger(stay.max_guests) && stay.max_guests >= 1 && stay.max_guests <= 99) && 'sleeps',
    !(Number.isInteger(stay.min_nights) && stay.min_nights >= 1 && stay.min_nights <= 365) && 'minimum nights',
    !Array.isArray(stay.photo_rooms) && 'photo tour',
    !isStayAmenityAnswers(stay.amenity_answers) && 'amenity answers',
    !(Array.isArray(stay.accessibility) && stay.accessibility.length === Object.keys(STAY_HOME_ACCESSIBILITY_FEATURES).length && stay.accessibility.every((answer, index) => isStayHomeAccessibility(answer) && answer.feature === Object.keys(STAY_HOME_ACCESSIBILITY_FEATURES)[index])) && 'accessibility details',
  ].filter(Boolean)
  return invalid.length ? `This place to stay has invalid stay settings: ${invalid.join(', ')}.` : null
})
const loadError = computed(() => (loadFailure.value && !isNotFoundError(loadFailure.value)
  ? getErrorMessage(loadFailure.value, `Failed to load this ${itemLabel.value.toLowerCase()}`)
  : stayConfigError.value))

/**
 * A writer's re-read. A save or a photo change has just made this row different
 * from what was loaded; the photo preview and every index summary read
 * `product`, not the form. A failed re-read fails the write that asked for it.
 */
async function reload() {
  await refresh()
  if (loadFailure.value) throw loadFailure.value
  await Promise.all([refreshCatalog(), refreshHomeQuote()])
}

// ── The weekly schedule ─────────────────────────────────
const isRuleList = (value: unknown): value is { success: true; rules: Array<{ weekday: number; start_time: string }> } =>
  isRecord(value) && Array.isArray(value.rules)
const scheduleUrl = () => `/api/editor/organizations/${organizationId}/products/${productId.value}/availability`
/** Weekly times belong to a location. Online, the provider's working hours are the schedule, so there are none to read. */
const scheduleUnplaced = computed(() => Boolean(product.value?.booking) && !locationId.value && !product.value?.booking?.held_online)
const scheduleReadable = computed(() => Boolean(product.value?.booking) && Boolean(locationId.value))
// The start times in this scope, read before the level renders, beside the
// product they belong to. A product without a booking calendar, or an online
// one without a time zone, has none; the key says which, so the read follows
// the product into a new scope. Every booking write re-reads it.
const { data: scheduleData, error: scheduleFailure, refresh: refreshSchedule } = await useAsyncData(
  () => `dashboard-product-schedule:${organizationId}:${locationId.value ?? 'online'}:${productId.value}:${scheduleReadable.value ? 'readable' : 'none'}`,
  async () => {
    if (!scheduleReadable.value) return null
    const { rules } = await dashboardApi(`${scheduleUrl()}?location_id=${encodeURIComponent(locationId.value!)}`, { validate: isRuleList })
    return rules.map(rule => ({ weekday: rule.weekday, start_time: rule.start_time.slice(0, 5) }))
  },
)
const savedSchedule = computed<ScheduleSlotDraft[]>(() => scheduleData.value ?? [])
const scheduleError = computed(() => scheduleUnplaced.value
  ? 'Choose a location for the weekly schedule before adding start times.'
  : scheduleFailure.value ? getErrorMessage(scheduleFailure.value, 'Could not load the weekly schedule') : null)
function savedSlotsFor(weekday: number) { return savedSchedule.value.filter(slot => slot.weekday === weekday) }
// The draft the weekday leaves edit, seeded from every read of the schedule.
const schedule = ref<ScheduleSlotDraft[]>([])
watch([scheduleData, scheduleFailure], ([rows, error]) => {
  if (!error) schedule.value = (rows ?? []).map(slot => ({ ...slot }))
}, { immediate: true })
async function reloadSchedule() {
  await refreshSchedule()
  if (scheduleFailure.value) throw scheduleFailure.value
}

// ── The form ────────────────────────────────────────────

const draftKey = `product-draft:${organizationId}:${productId.value}`
const draft = useState<ProductForm>(draftKey, () => ({
  kind: '',
  name: '',
  description: '',
  order_url: '',
  options: [] as OptionDraft[],
  variants: [] as VariantDraft[],
  details: {} as Record<string, ProductDetailValue>,
  active: true,
  published: false,
  locations: {} as Record<string, ProductLocationDraft>,
  collection_ids: [] as string[],
  bookable: false,
  booking_duration: '',
  booking_capacity: '', scheduling_mode: 'legacy', assigned_member_id: null, assigned_team_id: null, confirmation_mode: 'instant', online_payment_required: false, held_online: false,
  image_asset_id: null as string | null,
  // A new place to stay starts from these settings; an existing one is loaded from its own.
  stay_location_id: '', check_in_time: '15:00', check_in_end_time: '', check_out_time: '11:00', max_guests: '', min_nights: '1', stay_team_id: null, stay_member_id: null,
  stay_property_type_group: null, stay_property_type: null,
  stay_listing_type: null, stay_total_floors: '', stay_listing_floor: '', stay_year_built: '', stay_property_size: '', stay_property_size_unit: null,
  stay_bedrooms: '', stay_beds: '', stay_bathrooms: '',
  stay_amenities: [] as StayAmenity[], stay_amenity_answers: [] as StayAmenityAnswer[], stay_cancellation_policy: null, stay_long_term_cancellation_policy: null,
}))
const form = reactive(draft.value)

// A home's cost on the plan. A new home is a free draft; a draft's line is what
// publishing it would cost, from the quote the publish is decided by; a live
// home's is its share of the homes billed now.
const homeQuoted = computed(() => !isNew.value && product.value?.kind === 'stay')
const homeLive = computed(() => product.value?.stay?.live === true)
const { quote: homeQuote, quoteError: homeQuoteError, refreshQuote: refreshHomeQuote } = await useHomesQuote(organizationId, () => homeLive.value ? 0 : 1, () => homeQuoted.value && !arrivalTab.value)
const homeBilling = computed<{ text: string; billing?: string } | null>(() => {
  if (isNew.value && form.kind === 'stay') return { text: 'A new home is a free draft until it is published or synced with Airbnb.' }
  const quote = homeQuote.value
  if (!quote) return null
  if (!quote.adding.allowed) return { text: `Basic includes ${quote.homes.included} live homes. Choose Growth or Business to publish this one.`, billing: `/dashboard/${String(route.params.orgSlug)}/billing` }
  const billed = homeLive.value ? quote.homes.used > quote.homes.included : quote.adding.additional_homes > 0
  if (!billed) return { text: homeLive.value ? `This home is one of your ${quote.homes.included} included homes.` : `Published, this home is one of your ${quote.homes.included} included homes.` }
  if (!quote.homes.additional_price_minor) return { text: 'This home is not billed on your current subscription.' }
  if (!quote.billing.period_end) throw new Error('A billed home has no billing period')
  return { text: `${homeLive.value ? 'This home adds' : 'Published, this home adds'} ${formatPlanPrice(quote.homes.additional_price_minor)} per month to your plan, billed on your next invoice on ${formatExactDateTime(quote.billing.period_end)}.` }
})
// One key per product being created, kept across the walk's leaves and retries.
const createKeyName = `product-create-key:${organizationId}`
const createKey = useState(createKeyName, () => crypto.randomUUID())
// A walk opened from a filtered Catalog already knows the kind it is creating.
if (isNew.value && !form.kind && PRODUCT_KINDS.includes(route.query.kind as ProductKind)) form.kind = route.query.kind as ProductKind

/**
 * The location a price is read and written for: a place to stay is priced at
 * its own location; anything else at the catalog's scope.
 */
function priceLocationId(): string | null {
  return form.kind === 'stay' ? form.stay_location_id || null : locationId.value
}

/** What this location and currency pays for one variant, as a major-unit string. */
function variantPriceMajor(variant: Product['variants'][number]): string {
  const price = selectPrice(variant.prices, { currency, location_id: priceLocationId(), at: new Date().toISOString() })
  return price ? minorAmountToMajor(price.unit_amount, price.currency) : ''
}

/** The options, variants and prices as loaded, so a save can tell what changed. */
const loadedCatalogShape = ref('')
const editVersion = ref<string | null>(null)
// The draft is seeded from every read of the row, the first and each writer's re-read.
watch(product, (row) => { if (row) loadForm(row) }, { immediate: true })

function loadForm(row: Product) {
  editVersion.value = row.updated_at
  form.kind = row.kind
  // Stay settings belong to a place to stay alone; on any other product they do not apply.
  const stay = row.stay
  form.stay_location_id = stay ? stay.location_id : ''
  form.name = row.name
  form.description = row.description
  form.order_url = row.order_url ?? ''
  form.options = row.options.map(option => ({
    id: option.id,
    name: option.name,
    values: option.values.map(value => ({ id: value.id, value: value.value })),
  }))
  form.variants = row.variants.map(variant => ({
    key: form.options.length ? combinationKey(variant.option_values) : 'default',
    id: variant.id,
    name: variant.name,
    selections: { ...variant.option_values },
    sku: variant.sku,
    active: variant.active,
    price_major: variantPriceMajor(variant),
    loaded_price_major: variantPriceMajor(variant),
    prices: variant.prices.map(price => ({ ...price })),
  }))
  form.details = { ...row.details }
  form.active = row.active
  form.published = row.publications.find(entry => entry.organization_id === organizationId)?.published ?? false
  form.locations = Object.fromEntries(row.locations.map(entry => [entry.location_id, { active: entry.active, published: entry.published }]))
  form.collection_ids = row.collections.map(entry => entry.collection_id)
  form.image_asset_id = row.image?.asset_id ?? null
  // The configuration row is the capability, so the checkbox is its existence
  // and the fields are its values. The form used to open every product as "Not
  // bookable" with empty defaults, whatever was stored.
  form.bookable = row.booking !== null
  form.booking_duration = row.booking?.duration_minutes === null || row.booking === null ? '' : String(row.booking.duration_minutes)
  form.confirmation_mode = row.booking?.confirmation_mode ?? 'instant'
  form.scheduling_mode = row.booking?.scheduling_mode ?? 'legacy'
  form.assigned_member_id = row.booking ? row.booking.assigned_member_id : null
  form.assigned_team_id = row.booking ? row.booking.assigned_team_id : null
  form.online_payment_required = row.booking?.online_payment_required ?? false
  form.held_online = row.booking?.held_online ?? false
  form.booking_capacity = row.booking?.default_capacity === null || row.booking === null ? '' : String(row.booking.default_capacity)
  form.check_in_time = stay ? stay.check_in_time : ''
  form.check_in_end_time = stay?.check_in_end_time ?? ''
  form.check_out_time = stay ? stay.check_out_time : ''
  form.max_guests = stay ? String(stay.max_guests) : ''
  form.min_nights = stay ? String(stay.min_nights) : ''
  form.stay_team_id = stay ? stay.assigned_team_id : null
  form.stay_member_id = stay ? stay.assigned_member_id : null
  form.stay_property_type_group = stay ? stay.property_type_group : null
  form.stay_property_type = stay ? stay.property_type : null
  form.stay_listing_type = stay ? stay.listing_type : null
  form.stay_total_floors = stay && stay.total_floors !== null ? String(stay.total_floors) : ''
  form.stay_listing_floor = stay && stay.listing_floor !== null ? String(stay.listing_floor) : ''
  form.stay_year_built = stay && stay.year_built !== null ? String(stay.year_built) : ''
  form.stay_property_size = stay && stay.property_size !== null ? String(stay.property_size) : ''
  form.stay_property_size_unit = stay ? stay.property_size_unit : null
  form.stay_bedrooms = stay && stay.bedrooms !== null ? String(stay.bedrooms) : ''
  form.stay_beds = stay && stay.beds !== null ? String(stay.beds) : ''
  form.stay_bathrooms = stay && stay.bathrooms !== null ? String(stay.bathrooms) : ''
  form.stay_amenities = stay ? [...stay.amenities] : []
  form.stay_amenity_answers = stay ? stay.amenity_answers.map(answer => ({ ...answer })) : []
  form.stay_cancellation_policy = stay ? stay.cancellation_policy : null
  form.stay_long_term_cancellation_policy = stay ? stay.long_term_cancellation_policy : null
  loadedCatalogShape.value = catalogShapeOf()
}

/**
 * The label combination a set of selections names, in option order.
 *
 * Both the loaded variants and the rebuilt ones are keyed by this, so a
 * combination that survives an option edit is recognised as the same one.
 */
function combinationKey(selections: Record<string, string>): string {
  return form.options
    .filter(option => option.name.trim() && option.values.length)
    .map(option => option.values.find(value => (value.id ?? value.value) === selections[option.id])?.value ?? '')
    .join(' / ')
}

function setDetail(definition: ProductDetailField, value: ProductDetailValue) {
  const key = productDetailKey(definition)
  if ((typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)) Reflect.deleteProperty(form.details, key)
  else form.details[key] = value
}
function listValue(definition: ProductDetailField): string[] {
  const value = form.details[productDetailKey(definition)]
  return Array.isArray(value) ? value : []
}
function textValue(definition: ProductDetailField): string {
  const value = form.details[productDetailKey(definition)]
  return typeof value === 'string' ? value : ''
}
// ── Options and the combinations they produce ───────────
function addOption() {
  form.options.push({ id: `new-option-${form.options.length + 1}`, name: '', values: [] })
  rebuildVariants()
}
function removeOption(index: number) {
  form.options.splice(index, 1)
  rebuildVariants()
}
function setOptionValues(index: number, values: string[]) {
  const option = form.options[index]
  if (!option) return
  // Keep the ids of values that survived the edit, so the variants selecting
  // them keep pointing at the same rows.
  const existing = new Map(option.values.map(value => [value.value, value.id]))
  option.values = values.map(value => ({ id: existing.get(value) ?? null, value }))
  rebuildVariants()
}

/**
 * Every combination of option values, once each.
 *
 * Prices already typed survive by combination, not by position: reordering an
 * option's values must not move a price onto a different thing.
 */
function rebuildVariants() {
  const options = form.options.filter(option => option.name.trim() && option.values.length)
  if (!options.length) {
    const first = form.variants[0]
    form.variants = [{
      key: 'default', id: first?.id ?? null, name: form.name || 'Default', selections: {},
      sku: first?.sku ?? null, active: first?.active ?? true,
      price_major: first?.price_major ?? '', loaded_price_major: first?.loaded_price_major ?? '', prices: first?.prices ?? [],
    }]
    return
  }
  const draftByKey = new Map(form.variants.map(variant => [variant.key, variant]))
  let combinations: Array<{ selections: Record<string, string>; labels: string[] }> = [{ selections: {}, labels: [] }]
  for (const option of options) {
    combinations = combinations.flatMap(combination => option.values.map(value => ({
      selections: { ...combination.selections, [option.id]: value.id ?? value.value },
      labels: [...combination.labels, value.value],
    })))
  }
  form.variants = combinations.map((combination) => {
    const key = combination.labels.join(' / ')
    const prior = draftByKey.get(key)
    return {
      key,
      id: prior?.id ?? null,
      name: key,
      selections: combination.selections,
      sku: prior?.sku ?? null,
      active: prior?.active ?? true,
      price_major: prior?.price_major ?? '',
      loaded_price_major: prior?.loaded_price_major ?? '',
      prices: prior?.prices ?? [],
    }
  })
}

const propertyTypeErrors = computed(() => {
  const errors: Record<string, string> = {}
  if ((form.stay_property_type_group || form.stay_property_type) && !(form.stay_property_type_group && form.stay_property_type && isStayPropertyType(form.stay_property_type_group, form.stay_property_type))) errors.property_type = 'Choose a property type in this group, or clear both.'
  for (const [field, value] of [['total_floors', form.stay_total_floors], ['listing_floor', form.stay_listing_floor], ['year_built', form.stay_year_built]] as const) {
    if (value.trim() && (!Number.isSafeInteger(Number(value)) || Number(value) < 1)) errors[field] = 'Enter a positive whole number.'
  }
  if (form.stay_total_floors.trim() && form.stay_listing_floor.trim() && Number(form.stay_listing_floor) > Number(form.stay_total_floors)) errors.listing_floor = 'The listing floor cannot exceed the number of floors in the building.'
  const size = form.stay_property_size.trim()
  if (size && (!Number.isFinite(Number(size)) || Number(size) <= 0)) errors.property_size = 'Enter a positive property size.'
  if (size && !form.stay_property_size_unit) errors.property_size_unit = 'Choose a unit for the property size.'
  if (!size && form.stay_property_size_unit) errors.property_size = 'Enter the property size, or clear its unit.'
  return errors
})

const sectionValid = computed(() => {
  if (editorKey.value === 'kind') return PRODUCT_KINDS.includes(form.kind as ProductKind)
  if (editorKey.value === 'name') return Boolean(form.name.trim())
  if (editorKey.value === 'stay') return !stayIncomplete()
  if (editorKey.value === 'guests') return Number.isInteger(Number(form.max_guests)) && Number(form.max_guests) >= 1 && Number(form.max_guests) <= 99
  if (editorKey.value === 'availability') return Number.isInteger(Number(form.min_nights)) && Number(form.min_nights) >= 1 && Number(form.min_nights) <= 365
  if (editorKey.value === 'arrival-time') return checkInWindowValid()
  if (editorKey.value === 'property-type') {
    return !Object.keys(propertyTypeErrors.value).length
  }
  if (editorKey.value === 'rooms') {
    const bedroomsStr = String(form.stay_bedrooms ?? '').trim()
    const bedsStr = String(form.stay_beds ?? '').trim()
    const bathroomsStr = String(form.stay_bathrooms ?? '').trim()
    const b = bedroomsStr ? Number(bedroomsStr) : null
    const beds = bedsStr ? Number(bedsStr) : null
    const ba = bathroomsStr ? Number(bathroomsStr) : null
    const invalidBedrooms = b !== null && (!Number.isInteger(b) || b < 0 || b > 50)
    const invalidBeds = beds !== null && (!Number.isInteger(beds) || beds < 1 || beds > 50)
    const invalidBaths = ba !== null && (ba < 0 || ba > 50 || (ba * 2) % 1 !== 0)
    return !invalidBedrooms && !invalidBeds && !invalidBaths
  }
  if (editorKey.value === 'team') return true
  if (editorKey.value === 'options') {
    return form.options.every(option => option.name.trim() && option.values.length > 0)
  }
  return true
})

/** A place to stay is created at a location, with arrival and departure times and how many it sleeps. */
function stayIncomplete(): boolean {
  const guests = Number(form.max_guests)
  const nights = Number(form.min_nights)
  return !form.stay_location_id || !checkInWindowValid()
    || !Number.isInteger(guests) || guests < 1 || guests > 99 || !Number.isInteger(nights) || nights < 1 || nights > 365
}
/** Start and checkout are times; the end is a time other than the start, or empty for a flexible end. */
function checkInWindowValid(): boolean {
  return MINUTE_TIME_PATTERN.test(form.check_in_time) && MINUTE_TIME_PATTERN.test(form.check_out_time)
    && (form.check_in_end_time === '' || (MINUTE_TIME_PATTERN.test(form.check_in_end_time) && form.check_in_end_time !== form.check_in_time))
}
function staySummary(): string {
  const place = organizationLocations.value.find(entry => entry.id === form.stay_location_id)?.title
  if (!place) return 'Choose where it is'
  return `${place} · Check-in ${stayCheckInWindow(form.check_in_time, form.check_in_end_time || null)}, checkout ${form.check_out_time} · Sleeps ${form.max_guests}`
}
function stayTeamSummary(): string {
  if (schedulingMembersError.value) return 'Teams could not be loaded'
  if (!schedulingMembers.value) return 'Loading team…'
  if (form.stay_member_id) {
    const member = schedulingMembers.value.members.find(candidate => candidate.id === form.stay_member_id)
    return member?.name?.trim() || 'Assigned team member'
  }
  if (!form.stay_team_id) return 'Owners and admins only'
  return schedulingMembers.value.teams.find(candidate => candidate.id === form.stay_team_id)?.name ?? 'Assigned team not found in this business'
}
function roomsSummary(): string {
  const parts: string[] = []
  const bedroomsStr = String(form.stay_bedrooms ?? '').trim()
  const bedsStr = String(form.stay_beds ?? '').trim()
  const bathroomsStr = String(form.stay_bathrooms ?? '').trim()
  if (bedroomsStr) parts.push(bedroomsStr === '0' ? 'Studio' : `${bedroomsStr} ${Number(bedroomsStr) === 1 ? 'bedroom' : 'bedrooms'}`)
  if (bedsStr) parts.push(`${bedsStr} ${Number(bedsStr) === 1 ? 'bed' : 'beds'}`)
  if (bathroomsStr) parts.push(`${bathroomsStr} ${Number(bathroomsStr) === 1 ? 'bath' : 'baths'}`)
  return parts.length ? parts.join(' · ') : 'None set'
}
// A walk opened from a location's catalog creates the place to stay there.
if (isNew.value && !form.stay_location_id && locationId.value) form.stay_location_id = locationId.value

// ── The index ─────────────────────────────────────────────
function listSummary(values: readonly string[], empty: string) {
  return values.length ? values.join(', ') : empty
}

// Who handles a bookable service's consultations, by name: the same list the
// assignment concern reads, so it is one request shared by both.
const { data: schedulingMembers, error: schedulingMembersError } = await useMemberSchedulingList(() => dashboard.organization.value?.id)
/** The assignee by its loaded name; a read failure, a pending read or an unknown id says so. */
function assignmentSummary(): string {
  const assignment = isNew.value ? form : product.value?.booking
  if (!assignment?.assigned_team_id && !assignment?.assigned_member_id) return experienceEditor.value ? 'No host assigned' : 'Choose a host'
  if (schedulingMembersError.value) return 'Team members could not be loaded'
  if (!schedulingMembers.value) return 'Loading team members…'
  if (assignment.assigned_team_id) return schedulingMembers.value.teams.find(team => team.id === assignment.assigned_team_id)?.name ?? 'Assigned team not found in this business'
  const member = schedulingMembers.value.members.find(member => member.id === assignment.assigned_member_id)
  return member ? `${member.name}${experienceEditor.value && member.scheduling?.public_approved !== 1 ? ' · Profile not published' : ''}` : 'Assigned member not found in this business'
}

/**
 * A price opens the editor of the one price it names. One variant has one
 * price, edited directly; several each have their own, so the row opens the
 * list of variants rather than choosing one of them.
 */
const pricePath = computed(() => product.value && product.value.variants.length > 1 ? sectionPath('options') : sectionPath('price'))

function priceSummary(): string {
  const row = product.value
  if (!row) return ''
  if (row.variants.length > 1) return `${row.variants.length} variants`
  const variant = row.variants[0]
  if (!variant) return 'No price set'
  const price = selectPrice(variant.prices, { currency, location_id: priceLocationId(), at: new Date().toISOString() })
  const amount = formatProductMoney(price)
  if (amount) return amount
  // Priced in words — "Contact us for group pricing" — is a price the merchant
  // set, and the public page shows it; "No price set" would call it missing.
  const note = row.details[PRICING_NOTE_HANDLE]
  return typeof note === 'string' && note.trim() ? note : 'No price set'
}

function bookingSummary(): string {
  const config = product.value?.booking
  // A duration not chosen yet says so; it is never shown as a number.
  const duration = isNew.value ? form.booking_duration : config?.duration_minutes
  const minutes = duration ? `${duration} minutes` : 'No duration set'
  if (experienceEditor.value && config) return [
    minutes,
    config.default_capacity === null ? 'No guest limit' : config.default_capacity === 0 ? 'Closed to new guests' : `Up to ${config.default_capacity} ${config.default_capacity === 1 ? 'guest' : 'guests'} per session`,
    config.scheduling_mode === 'provider' ? 'Host’s working hours' : 'Calendar and repeating times',
    config.confirmation_mode === 'instant' ? 'Confirm automatically' : 'Review each request',
    config.online_payment_required ? 'Online payment required for paid sessions' : 'No payment collected at booking',
  ].join('\n')
  if (!scheduleData.value) return minutes
  const count = savedSchedule.value.filter(slot => slot.start_time.trim()).length
  return count ? `${minutes} · ${count === 1 ? '1 start time' : `${count} start times`} a week` : `${minutes} · No weekly availability set`
}

function publicationSummary(): string {
  const parts = [published.value ? 'Published' : 'Draft']
  if (!product.value?.active) parts.push(bookingOffering.value ? 'Bookings paused' : 'Orders paused')
  return parts.join(' · ')
}

function locationsSummary(): string {
  const offered = organizationLocations.value.filter(entry => form.locations[entry.id])
  return offered.length ? offered.map(entry => entry.title).join(', ') : 'Not offered at a location'
}

function collectionsSummary(): string {
  const names = collections.value.filter(row => form.collection_ids.includes(row.id)).map(row => row.name)
  return names.length ? names.join(', ') : 'Not in a collection'
}

function detailSummary(key: string): string {
  const value = product.value?.details[key as ProductDetailKey]
  return Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : value === true ? 'On' : value === false ? 'Off' : 'Not provided'
}

function productLocationSummary(): string {
  if (locationsError.value) return getErrorMessage(locationsError.value, 'Locations could not be loaded')
  if (locationsPending.value) return 'Loading locations…'
  const places = product.value?.locations.map(entry => {
    const place = allOrganizationLocations.value.find(candidate => candidate.id === entry.location_id)
    if (!place) throw new Error('The product references a location that could not be loaded')
    if (experienceEditor.value) return [place.title, ...(place.status === 'active' ? [] : ['Location inactive']), ...(entry.active ? [] : ['Bookings paused']), ...(entry.published ? [] : ['Hidden at this location'])].join(' · ')
    return `${place.title}${place.status !== 'active' ? ' · Location inactive' : !entry.active ? ' · Orders paused' : !entry.published ? ' · Hidden from this menu' : ''}`
  }) ?? []
  if (experienceEditor.value && product.value?.booking?.held_online) places.push('Online')
  return places.join('\n') || 'Not offered at a location'
}

const navigationGroups = computed<EditorNavigationGroup[]>(() => {
  const image = product.value?.image
  if (isNew.value) return [{
    id: 'item',
    items: [
      { id: 'kind', label: 'Type', summary: form.kind ? PRODUCT_KIND_LABELS[form.kind] : 'Choose a type', to: sectionPath('kind') },
      { id: 'name', label: 'Name', summary: form.name || 'Not named yet', placeholder: !form.name, to: sectionPath('name') },
      ...(form.kind === 'stay' ? [{ id: 'stay', label: 'Stay settings', summary: staySummary(), placeholder: stayIncomplete(), to: sectionPath('stay') }] : []),
    ],
  }]
  // A product that failed to load has nothing to summarize; the level shows the failure.
  if (!product.value || loadError.value) return []
  if (dishEditor.value || experienceEditor.value) {
    const row = product.value
    const prices = row.variants.map(variant => {
      const amount = formatProductMoney(selectPrice(variant.prices, { currency, location_id: locationId.value, at: new Date().toISOString() }))
      const price = row.variants.length > 1 ? `${variant.name}: ${amount || 'No price set'}` : amount || (typeof row.details.pricing_note === 'string' ? row.details.pricing_note : 'No price set')
      return `${price}${experienceEditor.value && !variant.active ? ' · Unavailable' : ''}`
    }).join('\n') || 'No price set'
    if (experienceEditor.value) {
      const detailKeys = ['meeting_point', 'included_items', 'what_to_bring', 'preparation', 'cancellation_policy']
      const fields = productDetailFields(row.kind)
      const details = fields.filter(field => detailKeys.includes(field.key)).map(field => ({
        id: field.key, label: field.name, icon: field.icon, summary: detailSummary(field.key), placeholder: row.details[field.key] === undefined, to: sectionPath(`attributes/${field.id}`),
      }))
      const detailNames = fields.filter(field => ![...detailKeys, PRICING_NOTE_HANDLE].includes(field.key)
        && row.details[field.key] !== undefined && row.details[field.key] !== false).map(field => field.name)
      const sections = row.collections.map(membership => {
        const collection = collections.value.find(entry => entry.id === membership.collection_id)
        if (!collection) throw new Error('The experience references a collection that could not be loaded')
        return collection.name
      })
      const cover = photoAssets.value[0]
      return [{ id: 'experience', items: [
        { id: 'photo', label: 'Photos', image: cover ? mediaStillUrl(cover) || undefined : undefined, summary: photoAssets.value.length ? `${photoAssets.value.length} ${photoAssets.value.length === 1 ? 'photo' : 'photos'}` : 'No photo', placeholder: !photoAssets.value.length, to: sectionPath('photo') },
        { id: 'name', label: 'Name', summary: row.name, to: sectionPath('name') },
        { id: 'description', label: sectionLabels.description, summary: row.description || 'Nothing written yet', placeholder: !row.description, to: sectionPath('description') },
        { id: 'price', label: location.value ? `Price at ${location.value.title}` : 'Price', summary: prices, placeholder: prices === 'No price set', to: pricePath.value },
        { id: 'options', label: 'Options', summary: row.options.map(option => `${option.name}: ${option.values.map(value => value.value).join(', ')}`).join('\n') || (row.variants.length > 1 ? `${row.variants.length} variants` : 'One version'), to: sectionPath('options') },
        { id: 'assignment', label: 'Host', icon: 'i-lucide-user-round', summary: row.booking ? assignmentSummary() : 'Set up bookings first', placeholder: !row.booking || !row.booking.assigned_team_id && !row.booking.assigned_member_id, to: sectionPath(row.booking ? 'booking/assignment' : 'booking') },
        { id: 'booking', label: 'Bookings', icon: 'i-lucide-calendar-check', summary: row.booking ? bookingSummary() : 'No booking calendar', placeholder: !row.booking, to: sectionPath('booking') },
        { id: 'locations', label: 'Locations', icon: 'i-lucide-map-pin', summary: productLocationSummary(), placeholder: !row.locations.length && !row.booking?.held_online, to: sectionPath('locations') },
        ...details,
        { id: 'publication', label: 'Website visibility', summary: publicationSummary(), status: published.value && row.active ? 'success' as const : 'neutral' as const, to: sectionPath('publication') },
        { id: 'order-url', label: sectionLabels['order-url'], summary: row.order_url || 'No external booking link', placeholder: !row.order_url, to: sectionPath('order-url') },
        ...(row.page ? [{ id: 'page', label: 'Page content', summary: row.page.path, to: `/dashboard/${String(route.params.orgSlug)}/website/pages/${encodeURIComponent(row.page.id)}` }] : []),
        { id: 'attributes', label: 'More details', summary: detailNames.join(', ') || 'No other details provided', placeholder: !detailNames.length, to: sectionPath('attributes') },
        { id: 'collections', label: sectionLabels.collections, summary: sections.join('\n') || 'Not in a collection', placeholder: !sections.length, to: sectionPath('collections') },
        { id: 'kind', label: 'Type', summary: PRODUCT_KIND_LABELS[row.kind], to: sectionPath('kind') },
      ] }]
    }
    const food = ['dietary_notes', 'allergens', 'ingredients'].map(key => {
      const field = definitions.value.find(entry => entry.key === key)!
      return { id: key, label: field.name, icon: field.icon, summary: detailSummary(key), placeholder: row.details[field.key] === undefined, to: sectionPath(`attributes/${field.id}`) }
    })
    const detailNames = definitions.value.filter(field => !['dietary_notes', 'allergens', 'ingredients', PRICING_NOTE_HANDLE].includes(field.key)
      && row.details[field.key] !== undefined && row.details[field.key] !== false).map(field => field.name)
    const sections = row.collections.map(membership => {
      const section = collections.value.find(entry => entry.id === membership.collection_id)
      if (!section) throw new Error('The dish references a menu section that could not be loaded')
      return section.name
    })
    return [{ id: 'dish', items: [
      { id: 'photo', label: 'Photos', image: image ? mediaStillUrl(image) || undefined : undefined, summary: photoAssets.value.length ? `${photoAssets.value.length} ${photoAssets.value.length === 1 ? 'photo' : 'photos'}` : 'Add your first photo', placeholder: !image, to: sectionPath('photo') },
      { id: 'name', label: 'Name', summary: row.name, to: sectionPath('name') },
      { id: 'price', label: location.value ? `Price at ${location.value.title}` : 'Price', summary: prices, placeholder: prices === 'No price set', to: pricePath.value },
      { id: 'description', label: 'Description', summary: row.description || 'Nothing written yet', placeholder: !row.description, to: sectionPath('description') },
      ...food,
      { id: 'options', label: 'Options and portions', summary: row.options.map(option => `${option.name}: ${option.values.map(value => value.value).join(', ')}`).join('\n') || 'One version', to: sectionPath('options') },
      { id: 'collections', label: 'Menu sections', summary: sections.join('\n') || 'Not in a menu section', placeholder: !sections.length, to: sectionPath('collections') },
      { id: 'locations', label: 'Locations', summary: productLocationSummary(), placeholder: !row.locations.length, to: sectionPath('locations') },
      { id: 'publication', label: 'Website visibility', summary: publicationSummary(), status: published.value && row.active ? 'success' as const : 'neutral' as const, to: sectionPath('publication') },
      { id: 'order-url', label: 'Ordering link', summary: row.order_url || 'No external ordering link', placeholder: !row.order_url, to: sectionPath('order-url') },
      { id: 'attributes', label: 'More food information', summary: detailNames.join(', ') || 'Add details', placeholder: !detailNames.length, to: sectionPath('attributes') },
      { id: 'kind', label: 'Type', summary: PRODUCT_KIND_LABELS[row.kind], to: sectionPath('kind') },
      { id: 'booking', label: 'Scheduling', summary: row.booking ? bookingSummary() : 'Not bookable', placeholder: !row.booking, to: sectionPath('booking') },
    ] }]
  }
  if (arrivalTab.value) {
    const home = arrivalHome.value
    if (!home || arrivalError.value) return []
    return [{ id: 'arrival', items: [
      { id: 'arrival-time', label: '', summary: `${stayCheckInWindow(product.value.stay!.check_in_time, product.value.stay!.check_in_end_time)} · ${product.value.stay!.check_out_time}`, to: sectionPath('arrival-time') },
      { id: 'directions', label: 'Directions', summary: home.directions || 'Add details', placeholder: !home.directions, to: sectionPath('directions') },
      { id: 'check-in-method', label: 'Check-in method', summary: home.check_in_method ? STAY_CHECK_IN_METHODS[home.check_in_method].label : 'Add details', placeholder: !home.check_in_method, to: sectionPath('check-in-method') },
      { id: 'wifi', label: 'Wifi details', summary: home.wifi_network || 'Add details', placeholder: !home.wifi_network, to: sectionPath('wifi') },
      { id: 'house-manual', label: 'House manual', summary: home.house_manual || 'Add details', placeholder: !home.house_manual, to: sectionPath('house-manual') },
      { id: 'house-rules', label: 'House rules', summary: savedHouseRules.value.join('\n') || 'Add details', placeholder: !savedHouseRules.value.length, to: sectionPath('house-rules') },
      { id: 'checkout-instructions', label: 'Checkout instructions', summary: home.checkout_instructions.length ? `${home.checkout_instructions.length} ${home.checkout_instructions.length === 1 ? 'instruction' : 'instructions'}` : 'Add details', placeholder: !home.checkout_instructions.length, to: sectionPath('checkout-instructions') },
    ] }]
  }
  const authoredDetails = definitions.value.filter(definition => form.details[productDetailKey(definition)] !== undefined && !isStayFocusedDetail(definition.key))
  // Other Product kinds retain their existing concern order until their own
  // vertical's editor has been verified.
  return [{
    id: 'item',
    items: [
      { id: 'photo', label: 'Photos', summary: stayEditor.value ? (photoAssets.value.length ? `${photoAssets.value.length} ${photoAssets.value.length === 1 ? 'photo' : 'photos'}` : 'No photos yet') : image ? (product.value.gallery.length ? `${product.value.gallery.length + 1} photos` : '') : 'No photo yet', placeholder: stayEditor.value ? !photoAssets.value.length : !image, to: sectionPath('photo') },
      { id: 'name', label: stayEditor.value ? 'Title' : 'Name', summary: form.name || 'Not named yet', placeholder: !form.name, to: sectionPath('name') },
      { id: 'description', label: 'Description', summary: form.description || 'Nothing written yet', placeholder: !form.description, to: sectionPath('description') },
      // A service is shown by a page of its own. The page has one editor, in
      // Pages; this row is a way into it, and a page not made yet is made here.
      ...(product.value.page || form.kind === 'service'
        ? [{ id: 'page', label: 'Page content', summary: product.value.page ? product.value.page.path : 'No page', placeholder: !product.value.page, to: product.value.page ? `/dashboard/${String(route.params.orgSlug)}/website/pages/${encodeURIComponent(product.value.page.id)}` : sectionPath('page') }]
        : []),
      { id: 'price', label: form.kind === 'service' ? 'Consultation pricing' : form.kind === 'stay' ? 'Nightly price' : 'Price', summary: priceSummary(), placeholder: priceSummary() === 'No price set', to: pricePath.value },
      // A place to stay is at its one location under its stay settings; nights and
      // stays are on the Calendar, not scheduled sessions.
      ...(form.kind === 'stay'
        ? [
            {
              id: 'property-type',
              label: 'Property type',
              summary: product.value.stay?.listing_type
                ? `${STAY_LISTING_TYPES[product.value.stay.listing_type].label}${product.value.stay.property_type_group ? ` · ${STAY_PROPERTY_TYPE_GROUPS[product.value.stay.property_type_group].label}` : ''}`
                : product.value.stay?.property_type
                  ? `${STAY_PROPERTY_TYPES[product.value.stay.property_type].label}${product.value.stay.property_type_group ? ` · ${STAY_PROPERTY_TYPE_GROUPS[product.value.stay.property_type_group].label}` : ''}`
                  : 'Choose property type',
              placeholder: !product.value.stay?.listing_type && !product.value.stay?.property_type,
              to: sectionPath('property-type'),
            },
            {
              id: 'rooms',
              label: 'Rooms and beds',
              summary: roomsSummary(),
              placeholder: !form.stay_bedrooms && !form.stay_beds && !form.stay_bathrooms,
              to: sectionPath('rooms'),
            },
            {
              id: 'amenities',
              label: 'Amenities',
              summary: product.value.stay!.amenities.length
                ? `${product.value.stay!.amenities.length} ${product.value.stay!.amenities.length === 1 ? 'amenity' : 'amenities'}`
                : 'No amenities selected',
              placeholder: !product.value.stay!.amenities.length,
              to: sectionPath('amenities'),
            },
            {
              id: 'accessibility', label: 'Accessibility features',
              summary: product.value.stay!.accessibility.filter(answer => answer.available !== null).map(answer => `${STAY_HOME_ACCESSIBILITY_FEATURES[answer.feature].label}${answer.available === false ? ': Not available' : ''}`).join(', ') || 'Add details',
              placeholder: !product.value.stay!.accessibility.some(answer => answer.available !== null),
              to: sectionPath('accessibility'),
            },
            {
              id: 'cancellation',
              label: 'Cancellation policy',
              summary: product.value.stay!.cancellation_policy
                ? STAY_CANCELLATION_POLICIES[product.value.stay!.cancellation_policy].label
                : 'No policy set',
              placeholder: !product.value.stay!.cancellation_policy,
              to: sectionPath('cancellation'),
            },
            { id: 'availability', label: 'Availability', summary: `${product.value.stay!.min_nights} ${product.value.stay!.min_nights === 1 ? 'night' : 'nights'} minimum`, to: sectionPath('availability') },
            { id: 'guests', label: 'Number of guests', summary: `${product.value.stay!.max_guests} ${product.value.stay!.max_guests === 1 ? 'guest' : 'guests'}`, to: sectionPath('guests') },
            { id: 'house-rules', label: 'House rules', summary: savedHouseRules.value.join('\n') || 'Add details', placeholder: !savedHouseRules.value.length, to: sectionPath('house-rules') },
            { id: 'guest-safety', label: 'Guest safety', summary: savedSafety.value.join('\n') || 'Add details', placeholder: !savedSafety.value.length, to: sectionPath('guest-safety') },
            { id: 'location', label: 'Location', summary: stayLocationError.value || (stayLocation.value ? formatPostalAddress(stayLocation.value.address) || 'Add address' : 'Loading location…'), placeholder: !stayLocation.value?.address, to: sectionPath('location') },
            { id: 'team', label: 'Looked after by', summary: stayTeamSummary(), to: sectionPath('team') },
          ]
        : []),
      // Who hosts an experience or consultation: the bookings' host concern,
      // reached from the overview. Until it takes bookings the row leads there first.
      ...(form.kind === 'service' || form.kind === 'experience'
        ? [product.value.booking
            ? { id: 'assignment', label: 'Host', summary: assignmentSummary(), placeholder: !form.assigned_team_id && !form.assigned_member_id, to: sectionPath('booking/assignment') }
            : { id: 'assignment', label: 'Host', summary: 'Set up bookings first', placeholder: true, to: sectionPath('booking') }]
        : []),
      { id: 'options', label: 'Variants', summary: product.value.variants.length > 1 ? `${product.value.variants.length} variants` : 'One version', to: sectionPath('options') },
      {
        id: 'attributes',
        label: 'Details',
        summary: listSummary(authoredDetails.map(definition => definition.name), 'None set'),
        placeholder: !authoredDetails.length,
        to: sectionPath('attributes'),
      },
      { id: 'kind', label: 'Type', summary: form.kind ? PRODUCT_KIND_LABELS[form.kind] : 'Choose a type', to: sectionPath('kind') },
      ...(form.kind === 'stay' ? [] : [{ id: 'booking', label: form.kind === 'service' ? 'Bookings' : 'Scheduling', summary: form.bookable ? bookingSummary() : 'Not bookable', placeholder: !form.bookable, to: sectionPath('booking') }]),
      // Guests book a place to stay on this site; it has no external link.
      ...(form.kind === 'stay' ? [] : [{ id: 'order-url', label: 'External link', summary: form.order_url || 'No external link', placeholder: !form.order_url, to: sectionPath('order-url') }]),
      ...(form.kind === 'stay' ? [] : [{ id: 'locations', label: 'Locations', summary: locationsSummary(), placeholder: !Object.keys(form.locations).length, to: sectionPath('locations') }]),
      { id: 'collections', label: sectionLabels.collections, summary: collectionsSummary(), placeholder: !form.collection_ids.length, to: sectionPath('collections') },
      {
        id: 'publication',
        label: stayEditor.value ? (published.value ? 'Listed' : 'Unlisted') : 'Status',
        summary: stayEditor.value
          ? (published.value ? (product.value?.active ? 'Your listing is visible on your website.' : 'Your listing is visible. Bookings are paused.') : 'Your listing is hidden from your website. Publish it when you’re ready.')
          : publicationSummary(),
        status: stayEditor.value ? (published.value ? 'success' as const : 'neutral' as const) : undefined,
        to: sectionPath('publication'),
      },
    ].sort((left, right) => rowRank(left.id) - rowRank(right.id)),
  }]
})

const activeNavigationItem = computed(() => {
  const directDetail = typeof route.params.definitionId === 'string' ? route.params.definitionId : null
  if (detailKey.value === 'attributes' && directDetail && navigationGroups.value.some(group => group.items.some(item => item.id === directDetail))) return directDetail
  return experienceEditor.value && detailKey.value === 'booking' && route.params.concern === 'assignment' ? 'assignment' : detailKey.value
})

/**
 * The row the editor opens on a wide screen: the first one that opens a leaf
 * beside this index. A row that leads into a level of its own — Bookings,
 * Variants — would open that level too and push this index off the screen.
 */
const LEAF_SECTIONS: readonly string[] = ['photo', 'name', 'description', 'price', 'kind', 'order-url', 'property-type', 'rooms', 'stay', 'guests', 'availability', 'arrival-time', 'directions', 'wifi', 'house-manual', 'house-rules', 'team']
const autoOpenTarget = computed(() => navigationGroups.value[0]?.items.find(item => LEAF_SECTIONS.includes(item.id) && !(stayEditor.value && item.id === 'description') && item.to === sectionPath(item.id))?.to ?? null)

// A service leads with what is changed most: who handles it, what it costs,
// how it is booked and what its page says. Every other kind keeps the list as written.
const SERVICE_ROW_ORDER = ['assignment', 'price', 'booking', 'description', 'page', 'locations', 'publication']
const STAY_ROW_ORDER = ['publication', 'photo', 'name', 'property-type', 'rooms', 'price', 'availability', 'guests', 'description', 'amenities', 'accessibility', 'location', 'house-rules', 'guest-safety', 'cancellation', 'team', 'options', 'attributes', 'kind', 'collections']
function rowRank(id: string) {
  if (form.kind === 'stay') {
    const at = STAY_ROW_ORDER.indexOf(id)
    return at === -1 ? STAY_ROW_ORDER.length : at
  }
  if (form.kind !== 'service') return 0
  const at = SERVICE_ROW_ORDER.indexOf(id)
  return at === -1 ? SERVICE_ROW_ORDER.length : at
}

/**
 * The sections this product actually has, read from the rows it offers rather
 * than from a list of every section a product could ever have — a product being
 * created has only its name, and the rows already say so.
 */
const openSections = computed(() => [...navigationGroups.value.flatMap(group => group.items.map(item => item.id)), ...(stayEditor.value ? ['arrival-guide'] : [])])

// A section this product does not have 404s. A watcher, not a setup-time check:
// moving between leaves reuses this component.
watchEffect(() => {
  // A product that failed to load has no rows, and every real section would
  // read as unsupported; the failure is shown instead, never a 404.
  if (!isNew.value && !product.value) return
  // Private rows exist only after their home is read. A pending or failed
  // read shows its own state rather than rejecting the concern being opened.
  if (arrivalTab.value && (!arrivalHome.value || arrivalError.value)) return
  if (detailKey.value && !openSections.value.includes(detailKey.value)) {
    showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
  }
})

// ── Save / cancel ───────────────────────────────────────
function carryPrice(price: Price) {
  return {
    id: price.id, unit_amount: price.unit_amount, currency: price.currency, location_id: price.location_id,
    active: price.active, type: price.type, recurring_interval: price.recurring_interval,
    recurring_interval_count: price.recurring_interval_count, tax_behavior: price.tax_behavior,
    compare_at_unit_amount: price.compare_at_unit_amount, valid_from_at: price.valid_from_at,
    valid_until_at: price.valid_until_at, source: price.source,
  }
}

/** The options, variants and prices this form is describing, exactly as they would be sent. */
function buildCatalog() {
  const declaredOptions = form.options.filter(option => option.name.trim() && option.values.length)
  const submittedOptionKeys = new Map(declaredOptions.map(option => [
    option.id,
    option.id.startsWith('new-option-') ? option.name.trim() : option.id,
  ]))
  // This box shows one amount: what this location pays, in this site's
  // currency. Every other offer the variant carries — another location's
  // price, another currency, a recurring term — is restated untouched, with
  // its own id, so editing the one amount on screen cannot silently retire the
  // ones that are not.
  const selection = { currency, location_id: priceLocationId(), at: new Date().toISOString() }
  const priceFor = (variant: VariantDraft) => {
    const typed = variant.price_major.trim()
    if (typed === variant.loaded_price_major.trim()) return variant.prices.map(carryPrice)
    const governing = selectPrice(variant.prices.filter(price => price.location_id === selection.location_id), selection)
    // An empty box is not a price of zero. Zero is typed, and means free.
    if (!typed) return variant.prices.filter(price => price.id !== governing?.id).map(carryPrice)
    if (!governing) {
      const displayed = selectPrice(variant.prices, selection)
      return [...variant.prices.map(carryPrice), { ...(displayed ? carryPrice(displayed) : {}), id: undefined, unit_amount: majorAmountToMinor(typed, currency), currency, location_id: priceLocationId() }]
    }
    return variant.prices.map(price => (price.id === governing.id
      ? { ...carryPrice(price), unit_amount: majorAmountToMinor(typed, price.currency) }
      : carryPrice(price)))
  }
  const options = declaredOptions.map((option, index) => ({
      id: option.id.startsWith('new-option-') ? undefined : option.id,
      name: option.name.trim(),
      sort_order: index,
      values: option.values.map((value, valueIndex) => ({ id: value.id ?? undefined, value: value.value, sort_order: valueIndex })),
  }))
  const variants = form.variants.map((variant, index) => ({
    id: variant.id ?? undefined,
    name: variant.name,
    // The form supplies the full intended variant state.
    sku: variant.sku,
    active: variant.active,
    sort_order: index,
      // A selection names its option the same way the declaration above does:
      // a saved option by id, one being created by its name.
      option_values: Object.fromEntries(Object.entries(variant.selections)
        .filter(([draftOptionId]) => submittedOptionKeys.has(draftOptionId))
        .map(([draftOptionId, valueKey]) => [submittedOptionKeys.get(draftOptionId)!, valueKey])),
    prices: priceFor(variant),
  }))
  return { options, variants }
}

function catalogShapeOf() {
  return JSON.stringify(buildCatalog())
}

function isSafetyConcern(concern: unknown): concern is StaySafetySection {
  return typeof concern === 'string' && Object.hasOwn(STAY_SAFETY_SECTIONS, concern)
}

function payload(concern?: ProductConcern) {
  if (!isNew.value && !stayEditor.value) {
    if (!editVersion.value) throw new Error('Read the saved product before editing it.')
    const version = { expected_updated_at: editVersion.value }
    if (editorKey.value === 'name') return { ...version, name: form.name.trim() }
    if (editorKey.value === 'description') return { ...version, description: form.description }
    if (editorKey.value === 'order-url') return { ...version, order_url: form.order_url || null }
    if (editorKey.value === 'kind') return { ...version, kind: assertProductKind(form.kind) }
    if (editorKey.value === 'attributes') {
      const field = definitions.value.find(entry => entry.id === route.params.definitionId)
      if (!field) throw new Error('Choose a product detail before saving.')
      return { ...version, details_mode: 'merge', details: { [field.key]: form.details[field.key] ?? null } }
    }
    if (editorKey.value === 'price' || editorKey.value === 'options' && typeof route.params.variantId === 'string') {
      const variant = typeof route.params.variantId === 'string' ? form.variants.find(entry => entry.id === route.params.variantId) : form.variants.length === 1 ? form.variants[0] : null
      if (!variant?.id) throw new Error('Choose a saved variant before editing its price.')
      const selection = { currency, location_id: priceLocationId(), at: new Date().toISOString() }
      const governing = selectPrice(variant.prices.filter(price => price.location_id === selection.location_id), selection)
      const displayed = selectPrice(variant.prices, selection)
      const typed = variant.price_major.trim()
      const prices = typed === variant.loaded_price_major.trim() ? [] : typed
        ? [governing ? { id: governing.id, unit_amount: majorAmountToMinor(typed, currency) } : { ...(displayed ? carryPrice(displayed) : {}), id: undefined, unit_amount: majorAmountToMinor(typed, currency), currency, location_id: selection.location_id }]
        : governing ? [{ id: governing.id, active: false }] : []
      return { ...version, ...(prices.length ? { variants: [{ id: variant.id, prices }] } : {}),
        ...(editorKey.value === 'price' ? { details_mode: 'merge', details: { [PRICING_NOTE_HANDLE]: form.details[PRICING_NOTE_HANDLE] || null } } : {}),
      }
    }
    if (editorKey.value === 'options') {
      const catalog = buildCatalog()
      return { ...version, options: catalog.options, variants_mode: 'replace', variants: catalog.variants.map(variant => ({ ...variant, prices_mode: 'replace' })) }
    }
    throw new Error('This product setting has its own save action.')
  }
  if (form.kind === 'stay' && !isNew.value && editorKey.value === 'amenities') return { stay: { amenities: form.stay_amenities } }
  if (form.kind === 'stay' && !isNew.value && editorKey.value === 'location' && STAY_LOCATION_DETAIL_KEYS.some(key => key === route.params.field)) {
    const key = STAY_LOCATION_DETAIL_KEYS.find(key => key === route.params.field)!
    return { details_mode: 'merge', details: { [key]: form.details[key] ?? null } }
  }
  if (isSafetyConcern(concern)) {
    if (product.value?.kind !== 'stay') throw new Error('Guest safety requires a place to stay.')
    return {
      details_mode: 'merge',
      details: Object.fromEntries(staySafetySectionKeys(concern).map(key => [key, form.details[key] ?? null])),
      ...(concern === 'devices' ? { stay: { amenity_answers: STAY_ALARM_AMENITIES.flatMap(code => {
        const available = stayAmenityAvailability(form.stay_amenity_answers, code)
        return available === stayAmenityAvailability(product.value!.stay!.amenity_answers, code) ? [] : [{ code, available }]
      }) } } : {}),
    }
  }
  if (concern === 'arrival-time') {
    if (!product.value?.stay) throw new Error('Arrival times require a place to stay.')
    return { stay: { check_in_time: form.check_in_time, check_in_end_time: form.check_in_end_time || null, check_out_time: form.check_out_time } }
  }
  if (concern === 'house-rules' || concern === 'additional-rules') {
    const stay = product.value?.stay
    if (!stay) throw new Error('House rules require a place to stay.')
    const keys = concern === 'additional-rules' ? ['house_rules'] : mainHouseRuleKeys
    return {
      details_mode: 'merge',
      details: Object.fromEntries(keys.map(key => [key, form.details[key] ?? null])),
      ...(concern === 'house-rules' && Number(form.max_guests) !== stay.max_guests ? { stay: { max_guests: Number(form.max_guests) } } : {}),
    }
  }
  if (form.kind === 'stay' && !isNew.value && editorKey.value === 'property-type') return { stay: {
    property_type_group: form.stay_property_type_group,
    property_type: form.stay_property_type,
    listing_type: form.stay_listing_type,
    total_floors: form.stay_total_floors.trim() ? Number(form.stay_total_floors) : null,
    listing_floor: form.stay_listing_floor.trim() ? Number(form.stay_listing_floor) : null,
    year_built: form.stay_year_built.trim() ? Number(form.stay_year_built) : null,
    property_size: form.stay_property_size.trim() ? Number(form.stay_property_size) : null,
    property_size_unit: form.stay_property_size_unit,
  } }
  // Options, variants and prices are restated only when they changed. A save
  // that renames a product says nothing about what it costs, and a patch that
  // omits variants leaves every offer exactly as it is.
  const catalog = buildCatalog()
  // A product being created with only a name says nothing about variants, and
  // the canonical writer gives it its one default variant. An empty list is a
  // claim that it has none, which is not a product.
  const describesCatalog = catalog.variants.length > 0
  const changed = JSON.stringify(catalog) !== loadedCatalogShape.value
  const attribute = editorKey.value === 'attributes' ? definitions.value.find(field => field.id === route.params.definitionId && !isStayFocusedDetail(field.key)) : undefined
  const detailKey = attribute ? productDetailKey(attribute)
    : editorKey.value === 'description' && form.kind === 'stay' ? STAY_DESCRIPTION_DETAIL_KEYS.find(key => key === route.params.section)
      : editorKey.value === 'price' && form.kind !== 'stay' && form.variants.length === 1 ? PRICING_NOTE_HANDLE : undefined
  return {
    kind: assertProductKind(form.kind),
    name: form.name.trim(),
    description: form.description,
    order_url: form.order_url || null,
    ...(changed && describesCatalog ? {
      ...catalog,
      ...(!isNew.value ? {
        variants_mode: 'replace',
        variants: catalog.variants.map(variant => ({ ...variant, prices_mode: 'replace' })),
      } : {}),
    } : {}),
    ...(isNew.value ? { details: form.details } : detailKey ? { details_mode: 'merge', details: { [detailKey]: form.details[detailKey] ?? null } } : {}),
    active: form.active,
    // Stay settings are restated only when they are what is being saved, so a
    // description save never writes back settings someone else changed, and
    // each leaf updates only the stay fields it owns.
    ...(form.kind === 'stay' && isNew.value ? { stay: {
      location_id: form.stay_location_id,
      check_in_time: form.check_in_time,
      check_in_end_time: form.check_in_end_time || null,
      check_out_time: form.check_out_time,
      max_guests: Number(form.max_guests),
      min_nights: Number(form.min_nights),
      assigned_member_id: form.stay_member_id,
      assigned_team_id: form.stay_team_id,
      property_type_group: form.stay_property_type_group || null,
      property_type: form.stay_property_type || null,
      listing_type: form.stay_listing_type,
      total_floors: form.stay_total_floors.trim() ? Number(form.stay_total_floors) : null,
      listing_floor: form.stay_listing_floor.trim() ? Number(form.stay_listing_floor) : null,
      year_built: form.stay_year_built.trim() ? Number(form.stay_year_built) : null,
      property_size: form.stay_property_size.trim() ? Number(form.stay_property_size) : null,
      property_size_unit: form.stay_property_size_unit,
      bedrooms: String(form.stay_bedrooms ?? '').trim() && !Number.isNaN(Number(form.stay_bedrooms)) ? Number(form.stay_bedrooms) : null,
      beds: String(form.stay_beds ?? '').trim() && !Number.isNaN(Number(form.stay_beds)) ? Number(form.stay_beds) : null,
      bathrooms: String(form.stay_bathrooms ?? '').trim() && !Number.isNaN(Number(form.stay_bathrooms)) ? Number(form.stay_bathrooms) : null,
      amenities: form.stay_amenities,
      cancellation_policy: form.stay_cancellation_policy || null,
      long_term_cancellation_policy: form.stay_long_term_cancellation_policy || null,
    } } : {}),
    ...(form.kind === 'stay' && !isNew.value && editorKey.value === 'guests' ? { stay: {
      max_guests: Number(form.max_guests),
    } } : {}),
    ...(form.kind === 'stay' && !isNew.value && editorKey.value === 'availability' ? { stay: {
      min_nights: Number(form.min_nights),
    } } : {}),
    ...(form.kind === 'stay' && !isNew.value && editorKey.value === 'team' ? { stay: {
      assigned_member_id: form.stay_member_id,
      assigned_team_id: form.stay_team_id,
    } } : {}),
    ...(form.kind === 'stay' && !isNew.value && editorKey.value === 'rooms' ? { stay: {
      bedrooms: String(form.stay_bedrooms ?? '').trim() && !Number.isNaN(Number(form.stay_bedrooms)) ? Number(form.stay_bedrooms) : null,
      beds: String(form.stay_beds ?? '').trim() && !Number.isNaN(Number(form.stay_beds)) ? Number(form.stay_beds) : null,
      bathrooms: String(form.stay_bathrooms ?? '').trim() && !Number.isNaN(Number(form.stay_bathrooms)) ? Number(form.stay_bathrooms) : null,
    } } : {}),
    ...(form.kind === 'stay' && !isNew.value && editorKey.value === 'cancellation' ? { stay: {
      cancellation_policy: form.stay_cancellation_policy || null,
      long_term_cancellation_policy: form.stay_long_term_cancellation_policy || null,
    } } : {}),
  }
}

const { title: newTitle, firstStep, saveLabel: createSaveLabel, saveDisabled, save: saveCurrentEditor } = useCreateWalk({
  recordPath: itemPath,
  isNew,
  openKey: editorKey,
  labels: sectionLabels,
  order: () => form.kind === 'stay' ? ['kind', 'name', 'stay'] : ['kind', 'name'],
  missing: key => key === 'name' ? !form.name.trim() : key === 'stay' ? stayIncomplete() : !form.kind,
  noun: () => itemLabel.value.toLowerCase(),
  saving,
  // A product that could not be read has no draft worth writing over it.
  existingBlocked: () => !product.value || Boolean(loadError.value) || !sectionValid.value,
  commit,
})

const pageTitle = computed(() => isNew.value ? newTitle.value : (experienceEditor.value ? product.value?.name : form.name) || itemLabel.value)

// Saving content and publishing the listing are separate owner decisions.
const saveLabel = computed(() => createSaveLabel.value ?? 'Save')

const closeTo = ref<string | null>(null)
async function save(target?: string, concern?: ProductConcern) {
  if (saving.value || saveDisabled.value) return
  closeTo.value = target ?? null
  try { if (concern !== undefined) await commit(concern); else await saveCurrentEditor() } finally { closeTo.value = null }
}

async function commit(concern?: ProductConcern) {
  const id = locationId.value
  const removesOnlineScope = locationScope.value === 'online' && (concern === 'location' && !form.held_online || concern === 'enabled' && !form.bookable)
  let ordinaryDraft: { version: string | null; values: ProductForm } | null = null
  const bookingDraft: Partial<ProductForm> | null = concern === 'enabled' ? { bookable: form.bookable }
    : concern === 'duration' ? { booking_duration: form.booking_duration }
    : concern === 'capacity' ? { booking_capacity: form.booking_capacity }
    : concern === 'confirmation' ? { confirmation_mode: form.confirmation_mode }
    : concern === 'assignment' ? { scheduling_mode: form.scheduling_mode, assigned_member_id: form.assigned_member_id, assigned_team_id: form.assigned_team_id }
    : concern === 'payment' ? { online_payment_required: form.online_payment_required }
    : concern === 'location' ? { held_online: form.held_online }
    : null
  const scheduleDraft = typeof concern === 'number' ? schedule.value.map(slot => ({ ...slot })) : null
  const bookingVersion = bookingDraft || scheduleDraft ? editVersion.value : null
  const publicationDraft = concern === 'publication-visibility' ? form.published : concern === 'publication-availability' ? form.active : null
  const propertyDraft = !isNew.value && editorKey.value === 'property-type' ? {
    stay_property_type_group: form.stay_property_type_group,
    stay_property_type: form.stay_property_type,
    stay_listing_type: form.stay_listing_type,
    stay_total_floors: form.stay_total_floors,
    stay_listing_floor: form.stay_listing_floor,
    stay_year_built: form.stay_year_built,
    stay_property_size: form.stay_property_size,
    stay_property_size_unit: form.stay_property_size_unit,
  } : null
  const arrivalTimeDraft = concern === 'arrival-time' ? { check_in_time: form.check_in_time, check_in_end_time: form.check_in_end_time, check_out_time: form.check_out_time } : null
  const safetyDraft = isSafetyConcern(concern) ? { keys: staySafetySectionKeys(concern), details: { ...form.details }, answers: form.stay_amenity_answers.map(answer => ({ ...answer })) } : null
  const locationDetailKey = editorKey.value === 'location' ? STAY_LOCATION_DETAIL_KEYS.find(key => key === route.params.field) : undefined
  const locationDraft = locationDetailKey ? { key: locationDetailKey, value: form.details[locationDetailKey] } : null
  const houseRulesDraft = concern === 'house-rules' || concern === 'additional-rules' || concern === 'arrival-time' && editorKey.value === 'house-rules' ? {
    details: { ...form.details },
    max_guests: Number(form.max_guests) !== product.value?.stay?.max_guests ? form.max_guests : null,
  } : null
  function restoreHouseRules(includeAdditional: boolean) {
    if (!houseRulesDraft) return
    for (const key of includeAdditional ? STAY_HOUSE_RULE_DETAIL_KEYS : mainHouseRuleKeys) {
      const value = houseRulesDraft.details[key]
      if (value === undefined) Reflect.deleteProperty(form.details, key)
      else form.details[key] = value
    }
    if (houseRulesDraft.max_guests !== null) form.max_guests = houseRulesDraft.max_guests
  }
  saving.value = true
  saveError.value = null
  try {
    if (!isNew.value && !stayEditor.value && concern === undefined) ordinaryDraft = { version: editVersion.value, values: structuredClone(toRaw(form)) }
    if (isNew.value) {
      // A service is created with the page that shows it, in one write: the
      // name is the page's first title, the server gives it a free
      // /services/<slug>, and nothing else is invented for it. It starts
      // sale-inactive, the page and the offer drafted before anything is sold.
      // The key makes a retry after a lost response return this product
      // rather than a second.
      const created = await dashboardApi(`/api/editor/organizations/${organizationId}/products`, {
        method: 'POST',
        body: {
          ...payload(),
          ...(form.kind === 'service' ? { active: false } : {}),
          idempotency_key: createKey.value,
        },
        validate: isOne,
      })
      // A product created in a location's catalog is offered there, and one
      // created from a collection joins it — explicit writes, each named by the
      // URL that opened the walk, neither implied. The location relationship is
      // not collection membership.
      if (id && form.kind !== 'stay') await dashboardApi(`/api/editor/organizations/${organizationId}/products/${created.product.id}/locations/${id}`, {
        method: 'PUT', body: { active: true, published: false }, validate: isRecord,
      })
      if (createCollectionId.value) {
        await refreshCatalog()
        const members = collectionProductIds(createCollectionId.value)
        await setCollectionProducts(createCollectionId.value, members.includes(created.product.id) ? members : [...members, created.product.id], members)
      }
      await refreshCatalog()
      // The record it became, not the `new` form it was, so Back from a saved
      // product goes to Catalog and never to an empty Add screen.
      clearNuxtState([draftKey, createKeyName])
      await navigateTo(router.resolve({ path: `${catalogPath.value}/${created.product.id}`, query: { location_id: id ?? undefined } }).fullPath, { replace: true })
      return
    }
    if (concern === 'publication-visibility') {
      await savePublication()
    } else if (concern === 'publication-availability') {
      await dashboardApi(`/api/editor/organizations/${organizationId}/products/${productId.value}`, { method: 'PATCH', body: { active: form.active }, validate: isMutation })
    } else if (concern === 'house-rules' || concern === 'additional-rules' || concern === 'arrival-time' || isSafetyConcern(concern)) {
      await dashboardApi(`/api/editor/organizations/${organizationId}/products/${productId.value}`, { method: 'PATCH', body: payload(concern), validate: isMutation })
    } else if (concern !== undefined) {
      await saveBooking(concern)
    } else if (editorKey.value === 'locations') {
      await saveLocation()
    } else {
      await dashboardApi(`/api/editor/organizations/${organizationId}/products/${productId.value}`, {
        method: 'PATCH', body: payload(), validate: isMutation,
      })
    }
    if (removesOnlineScope) {
      const result = await navigateTo({ path: route.path, query: { ...route.query, location_id: undefined }, hash: route.hash }, { replace: true })
      if (isNavigationFailure(result)) throw result
      if (closeTo.value) {
        const destination = router.resolve(closeTo.value)
        closeTo.value = router.resolve({ path: destination.path, query: { ...destination.query, location_id: undefined }, hash: destination.hash }).fullPath
      }
    }
    await reload()
    if (concern === 'additional-rules' || concern === 'arrival-time') restoreHouseRules(false)
    // A booking write changes what the schedule is: its start times, whether the
    // product has a calendar at all, or the time zone an online one runs in.
    if (concern !== undefined && concern !== 'publication-visibility' && concern !== 'publication-availability' && concern !== 'house-rules' && concern !== 'additional-rules' && concern !== 'arrival-time' && !isSafetyConcern(concern)) await reloadSchedule()
    await (closeTo.value ? navigateTo(closeTo.value) : level.close())
  } catch (error) {
    saveError.value = getErrorMessage(error, `Failed to save ${itemLabel.value.toLowerCase()}`)
    if (ordinaryDraft || bookingDraft || scheduleDraft || locationDraft || safetyDraft || arrivalTimeDraft || houseRulesDraft || propertyDraft || publicationDraft !== null || error instanceof ApiClientError && (error.data.committed === true || (isRecord(error.data.data) && error.data.data.committed === true))) {
      try {
        await reload()
        if (scheduleDraft) await reloadSchedule()
      } catch (readError) { saveError.value += ` ${getErrorMessage(readError, 'The saved listing could not be read again')}` }
    }
    if (ordinaryDraft) {
      const draft = ordinaryDraft.values
      if (editorKey.value === 'attributes' || editorKey.value === 'price') form.details = draft.details
      if (editorKey.value === 'options' || editorKey.value === 'price') { form.options = draft.options; form.variants = draft.variants }
      if (editorKey.value === 'name') form.name = draft.name
      if (editorKey.value === 'description') form.description = draft.description
      if (editorKey.value === 'order-url') form.order_url = draft.order_url
      if (editorKey.value === 'kind') form.kind = draft.kind
      if (editorKey.value === 'locations') form.locations = draft.locations
      editVersion.value = ordinaryDraft.version
    }
    if (bookingDraft) Object.assign(form, bookingDraft)
    if (scheduleDraft) schedule.value = scheduleDraft
    if (bookingDraft || scheduleDraft) editVersion.value = bookingVersion
    // A failed response may follow a committed write. Saved summaries
    // re-read it, while the failed leaf retains the choice it submitted.
    if (concern === 'publication-visibility' && publicationDraft !== null) form.published = publicationDraft
    if (concern === 'publication-availability' && publicationDraft !== null) form.active = publicationDraft
    if (propertyDraft) Object.assign(form, propertyDraft)
    if (arrivalTimeDraft) Object.assign(form, arrivalTimeDraft)
    if (locationDraft) {
      if (locationDraft.value === undefined) Reflect.deleteProperty(form.details, locationDraft.key)
      else form.details[locationDraft.key] = locationDraft.value
    }
    if (safetyDraft) {
      if (concern === 'devices') form.stay_amenity_answers = safetyDraft.answers
      for (const key of safetyDraft.keys) {
        const value = safetyDraft.details[key]
        if (value === undefined) Reflect.deleteProperty(form.details, key)
        else form.details[key] = value
      }
    }
    restoreHouseRules(concern === 'additional-rules')
  } finally {
    saving.value = false
  }
}

/** Whether the website shows it. The sale and every location are their own writes. */
async function savePublication() {
  await dashboardApi(`/api/editor/organizations/${organizationId}/products/${productId.value}/publication`, {
    method: 'PUT', body: { published: form.published }, validate: isRecord,
  })
}

/** The one location the Locations leaf has open: offered there, and shown there. */
async function saveLocation() {
  const target = typeof route.params.locationId === 'string' ? route.params.locationId : null
  if (!target) throw new Error('Choose a location.')
  const entry = form.locations[target]
  if (!entry) throw new Error('This location has no settings to save.')
  await dashboardApi(`/api/editor/organizations/${organizationId}/products/${productId.value}/locations/${encodeURIComponent(target)}`, {
    method: 'PUT', body: { active: entry.active, published: entry.published }, validate: isRecord,
  })
}


/** Each focused editor writes only the setting its caller named. */
async function saveBooking(concern: BookingConcern) {
  if (typeof concern === 'number') return saveSchedule(concern)
  const url = `/api/editor/organizations/${organizationId}/products/${productId.value}/booking`
  if (concern === 'enabled' && !form.bookable) {
    await dashboardApi(url, { method: 'DELETE', validate: isRecord })
    return
  }
  const body = concern === 'duration' ? { duration_minutes: Number(form.booking_duration) }
    : concern === 'capacity' ? { default_capacity: form.booking_capacity.trim() ? Number(form.booking_capacity) : null }
    : concern === 'confirmation' ? { confirmation_mode: form.confirmation_mode }
    : concern === 'assignment' ? { scheduling_mode: form.scheduling_mode, assigned_member_id: form.assigned_member_id, assigned_team_id: form.assigned_team_id }
    : concern === 'payment' ? { online_payment_required: form.online_payment_required }
    : concern === 'location' ? { held_online: form.held_online }
    : {}
  await dashboardApi(url, { method: 'PUT', body, validate: isRecord })
}

// ── Editing the weekly schedule ─────────────────────────
// Product owns duration and guest limits; the weekly schedule owns start times.
const WEEKDAYS = [
  { value: 1, label: 'Monday' }, { value: 2, label: 'Tuesday' }, { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' }, { value: 6, label: 'Saturday' }, { value: 0, label: 'Sunday' },
]
function slotsFor(weekday: number) {
  return schedule.value.filter(slot => slot.weekday === weekday)
}
function addSlot(weekday: number) {
  schedule.value.push({ weekday, start_time: '' })
}
function removeSlot(slot: ScheduleSlotDraft) {
  schedule.value = schedule.value.filter(entry => entry !== slot)
}

/** Replace this weekday while retaining the other days read from the canonical writer. */
async function saveSchedule(weekday: number) {
  const id = locationId.value
  if (scheduleError.value || !scheduleData.value) throw new Error('Load the schedule before saving times.')
  const times = slotsFor(weekday).map(slot => slot.start_time.trim())
  if (times.some(time => !MINUTE_TIME_PATTERN.test(time)) || new Set(times).size !== times.length) throw new Error('Choose a different, valid start time for each session.')
  const { rules } = await dashboardApi(`${scheduleUrl()}?location_id=${encodeURIComponent(id ?? 'online')}`, { validate: isRuleList })
  const slots = [...rules.filter(rule => rule.weekday !== weekday).map(rule => ({ weekday: rule.weekday, start_time: rule.start_time.slice(0, 5) })), ...times.map(start_time => ({ weekday, start_time }))]
  await dashboardApi(scheduleUrl(), { method: 'PUT', body: { location_id: id, slots }, validate: isRecord })
}

/** A cancelled leaf puts the loaded product back before it closes. */
function revert(concern?: 'additional-rules' | 'arrival-time' | StaySafetySection) {
  saveError.value = null
  if (isSafetyConcern(concern)) {
    if (concern === 'devices' && product.value?.stay) form.stay_amenity_answers = product.value.stay.amenity_answers.map(answer => ({ ...answer }))
    for (const key of staySafetySectionKeys(concern)) {
      const value = product.value?.details[key]
      if (value === undefined) Reflect.deleteProperty(form.details, key)
      else form.details[key] = value
    }
    return
  }
  if (concern === 'arrival-time') {
    form.check_in_time = product.value?.stay?.check_in_time ?? ''
    form.check_in_end_time = product.value?.stay?.check_in_end_time ?? ''
    form.check_out_time = product.value?.stay?.check_out_time ?? ''
    return
  }
  if (concern === 'additional-rules') {
    const value = product.value?.details.house_rules
    if (value === undefined) Reflect.deleteProperty(form.details, 'house_rules')
    else form.details.house_rules = value
    return
  }
  photoError.value = null
  revertArrival()
  if (product.value) loadForm(product.value)
  schedule.value = savedSchedule.value.map(slot => ({ ...slot }))
}

/**
 * A service that has no page yet gets one, bound to it in the same write: its
 * name as the first title and its slug under /services/. The page writer
 * refuses a path somebody already holds, and that refusal is shown.
 */
async function createPage() {
  const row = product.value
  if (!row || row.page) return
  saving.value = true
  saveError.value = null
  try {
    const created = await dashboardApi(`/api/editor/organizations/${organizationId}/pages`, {
      method: 'POST',
      body: { productId: row.id, path: `/services/${row.slug}`, title: row.name, pageType: 'recipe', recipe: 'service-detail', blocks: [] },
      validate: (value: unknown): value is { page: { id: string } } => isRecord(value) && isRecord(value.page) && typeof value.page.id === 'string',
    })
    await reload()
    // The page is edited where every page is.
    await navigateTo(`/dashboard/${String(route.params.orgSlug)}/website/pages/${encodeURIComponent(created.page.id)}`)
  } catch (error) {
    saveError.value = getErrorMessage(error, 'Failed to create the page')
  } finally {
    saving.value = false
  }
}

async function setPrimaryImage(assetId: string | null) {
  photoError.value = null
  try {
    await dashboardApi(`/api/editor/organizations/${organizationId}/media/placements`, {
      method: 'PUT',
      body: { placement: { owner_type: 'product', owner_id: productId.value, slot: 'image' }, asset_id: assetId },
      validate: isRecord,
    })
    form.image_asset_id = assetId
    await reload()
  } catch (error) {
    photoError.value = getErrorMessage(error, 'Failed to update the photo')
  }
}

/**
 * The photos after the cover are the product's ordered `gallery`. Each change
 * is saved as it is made, through the same placement operations every other
 * gallery uses, and the product is read again so the list is the server's.
 */
const choosingGalleryPhoto = ref(false)
const galleryRows = computed<GalleryMediaItem[]>(() => [
  ...(product.value?.gallery ?? []).map(asset => ({ _key: asset.asset_id, asset_id: asset.asset_id, url: asset.public_url, thumbnail_url: asset.thumbnail_url, kind: asset.kind })),
  ...(choosingGalleryPhoto.value ? [{ _key: 'new', asset_id: null }] : []),
])
const galleryPlacement = () => ({ owner_type: 'product', owner_id: productId.value, slot: 'gallery' })
const isPlacementResponse = (value: unknown): value is { asset_ids: string[] } => isRecord(value) && Array.isArray(value.asset_ids)

async function changeGallery(change: () => Promise<void>) {
  photoError.value = null
  try {
    await change()
  } catch (error) {
    photoError.value = getErrorMessage(error, 'Failed to update the photos')
  }
  choosingGalleryPhoto.value = false
  // Whatever the outcome: a failed change may have made part of its writes.
  try {
    await reload()
  } catch (error) {
    photoError.value ??= getErrorMessage(error, 'Failed to read the photos again')
  }
}

function galleryCall(action: 'attach' | 'remove' | 'reorder', body: Record<string, unknown>) {
  return dashboardApi(`/api/editor/organizations/${organizationId}/media/placements/${action}`, {
    method: 'POST', body: { placement: galleryPlacement(), ...body }, validate: isPlacementResponse,
  })
}

function addGalleryRow() {
  choosingGalleryPhoto.value = true
}

async function setGalleryAsset(index: number, asset: { asset_id: string } | null) {
  const rows = galleryRows.value
  const replaced = rows[index]?.asset_id ?? null
  const next = rows[index + 1]?.asset_id ?? null
  await changeGallery(async () => {
    if (replaced) await galleryCall('remove', { asset_id: replaced })
    if (!asset) return
    await galleryCall('attach', { asset_id: asset.asset_id })
    // Attaching appends; a replaced photo keeps its place.
    if (replaced && next) await galleryCall('reorder', { moves: [{ asset_id: asset.asset_id, before_asset_id: next }] })
  })
}

async function removeGalleryPhoto(index: number) {
  const assetId = galleryRows.value[index]?.asset_id ?? null
  if (!assetId) {
    choosingGalleryPhoto.value = false
    return
  }
  await changeGallery(async () => { await galleryCall('remove', { asset_id: assetId }) })
}

async function moveGalleryPhoto(from: number, to: number) {
  const ids = (product.value?.gallery ?? []).map(asset => asset.asset_id)
  const moved = ids[from]
  const anchor = ids[to]
  if (!moved || !anchor || from === to) return
  await changeGallery(async () => {
    await galleryCall('reorder', { moves: [to < from ? { asset_id: moved, before_asset_id: anchor } : { asset_id: moved, after_asset_id: anchor }] })
  })
}

// Stay photo operations own the complete cover/gallery arrangement. The
// independent Product read below is also the source for the listing summaries
// and the guest page, rather than retaining a second photo list from a write.
const stayPhotoUrl = () => `/api/dashboard/stay-homes/${encodeURIComponent(productId.value)}/photos`
const isStayPhotoMutation = (value: unknown): value is { home: { product_id: string; photos: unknown[] } } =>
  isRecord(value) && isRecord(value.home) && value.home.product_id === productId.value && Array.isArray(value.home.photos)

async function changeStayPhotos(change: () => Promise<unknown>): Promise<boolean> {
  if (saving.value) return false
  saving.value = true
  photoError.value = null
  let changed = false
  try {
    if (product.value?.kind !== 'stay' || loadError.value) throw new Error('Load this listing before changing its photos.')
    try {
      await change()
      changed = true
    } catch (error) {
      photoError.value = getErrorMessage(error, 'The photos could not be saved')
    }
    // Publication can fail after a placement committed. Re-read in either
    // case, while keeping the submitted draft and the original failure.
    try {
      await reload()
    } catch (error) {
      const reason = getErrorMessage(error, 'Read failed')
      photoError.value = photoError.value ? `${photoError.value} The photos could not be read again: ${reason}` : `The photos could not be read again: ${reason}`
    }
    return changed && !photoError.value
  } catch (error) {
    photoError.value = getErrorMessage(error, 'The photos could not be saved')
    return false
  } finally {
    saving.value = false
  }
}

async function addStayPhoto(assetId: string, roomId?: string) {
  return await changeStayPhotos(async () => {
    if (photoAssets.value.some(photo => photo.asset_id === assetId)) throw new Error('This photo is already on the listing.')
    await dashboardApi(stayPhotoUrl(), { method: 'POST', body: { asset_id: assetId, ...(roomId ? { room_id: roomId } : {}) }, validate: isStayPhotoMutation })
  })
}

async function reorderStayPhotos(photoIds: string[]) {
  return await changeStayPhotos(async () => await dashboardApi(stayPhotoUrl(), {
    method: 'PUT', body: { photo_ids: photoIds }, validate: isStayPhotoMutation,
  }))
}

async function describeStayPhoto(photoId: string, text: string) {
  return await changeStayPhotos(async () => await dashboardApi(`${stayPhotoUrl()}/${encodeURIComponent(photoId)}`, {
    method: 'PATCH', body: { alt_text: text.trim() || null }, validate: isStayPhotoMutation,
  }))
}

async function removeStayPhotos(photoIds: string[]) {
  return await changeStayPhotos(async () => {
    // Each deletion reads the remaining canonical order; concurrent deletes
    // would race their whole-list replacements against one another.
    for (const photoId of photoIds) await dashboardApi(`${stayPhotoUrl()}/${encodeURIComponent(photoId)}`, { method: 'DELETE', validate: isStayPhotoMutation })
  })
}

const stayRoomsUrl = () => `/api/dashboard/stay-homes/${encodeURIComponent(productId.value)}/rooms`

async function createStayPhotoRoom(type: StayPhotoRoomType): Promise<StayPhotoRoom | null> {
  let roomId: string | null = null
  if (!await changeStayPhotos(async () => {
    const result = await dashboardApi(stayRoomsUrl(), {
      method: 'POST', body: { type },
      validate: (value: unknown): value is { home: { product_id: string; photos: unknown[] }; room: { id: string } } =>
        isRecord(value) && isRecord(value.room) && typeof value.room.id === 'string' && isStayPhotoMutation(value),
    })
    roomId = result.room.id
  })) return null
  const room = photoRooms.value.find(entry => entry.id === roomId)
  if (!room) {
    photoError.value = 'The room was added, but it could not be read again.'
    return null
  }
  return room
}

async function deleteStayPhotoRoom(roomId: string) {
  return await changeStayPhotos(async () => await dashboardApi(`${stayRoomsUrl()}/${encodeURIComponent(roomId)}`, { method: 'DELETE', validate: isStayPhotoMutation }))
}

async function updateStayPhotoRoom(roomId: string, patch: Pick<StayPhotoRoom, 'details_version'> & Partial<Pick<StayPhotoRoom, 'sleeping_arrangements' | 'private_attached_bathroom' | 'amenities'>> & { accessibility?: StayRoomAccessibility }) {
  const { details_version, ...details } = patch
  return await changeStayPhotos(async () => await dashboardApi(`${stayRoomsUrl()}/${encodeURIComponent(roomId)}`, {
    method: 'PATCH', body: { expected_details_version: details_version, ...details }, validate: isStayPhotoMutation,
  }))
}

async function updateStayAccessibility(accessibility: StayHomeAccessibility, expectedUpdatedAt: string) {
  return await changeStayPhotos(async () => await dashboardApi(`${arrivalUrl()}/accessibility`, {
    method: 'PATCH', body: { expected_updated_at: expectedUpdatedAt, accessibility },
    validate: (value: unknown): value is { home: { product_id: string; photos: unknown[]; accessibility: StayHomeAccessibility[] } } => {
      if (!isRecord(value) || !isRecord(value.home)) return false
      const home = value.home
      return isStayPhotoMutation(value) && Array.isArray(home.accessibility)
        && home.accessibility.length === Object.keys(STAY_HOME_ACCESSIBILITY_FEATURES).length
        && home.accessibility.every((answer, index) => isStayHomeAccessibility(answer) && answer.feature === Object.keys(STAY_HOME_ACCESSIBILITY_FEATURES)[index])
    },
  }))
}

async function moveStayPhotos(photos: Array<{ photo_id: string; expected_room_id: string | null }>, target: { room_id: string | null } | { new_room_type: StayPhotoRoomType }) {
  return await changeStayPhotos(async () => await dashboardApi(`${stayPhotoUrl()}/move`, { method: 'PUT', body: { ...target, photos }, validate: isStayPhotoMutation }))
}

// ── Localization ────────────────────────────────────────
/**
 * Which fields can be translated comes from the tenant's own definitions, so
 * shared named fields supply the same types and labels as the source editor.
 */
const productLocalizationFields = computed(() => {
  const row = product.value
  const fields: Array<{ key: string, label: string, source: string | readonly string[] | null | undefined, kind?: 'string-list', multiline?: boolean, rows?: number }> = [
    { key: 'name', label: 'Name', source: row?.name },
    { key: 'description', label: 'Description', source: row?.description, multiline: true, rows: 4 },
  ]
  for (const definition of definitions.value) {
    if (!definition.localizable) continue
    const handle = productDetailKey(definition)
    const value = row?.details[handle]
    fields.push({
      key: `detail:${handle}`,
      label: definition.name,
      source: Array.isArray(value) ? value : typeof value === 'string' ? value : null,
      kind: Array.isArray(value) ? 'string-list' : undefined,
      multiline: definition.value_type === 'multi_line_text',
    })
  }
  return fields
})

const organizationLocalizationSettingsPath = computed(() => `/dashboard/${route.params.orgSlug}/website/localization`)

function isProductLocalizationResponse(value: unknown): value is { localization: { values: Record<string, unknown> } } {
  return isRecord(value) && isRecord(value.localization) && isRecord(value.localization.values)
}

async function loadProductLocalization(locale: string): Promise<Record<string, unknown>> {
  try {
    const response = await dashboardApi<{ localization: { values: Record<string, unknown> } }>(
      `/api/editor/organizations/${organizationId}/localization/product/${productId.value}/${encodeURIComponent(locale)}`,
      { validate: isProductLocalizationResponse },
    )
    const values = { ...response.localization.values }
    const details = isRecord(values.details) ? values.details : {}
    for (const [handle, value] of Object.entries(details)) values[`detail:${handle}`] = value
    delete values.details
    return values
  } catch (cause) {
    const statusCode = isRecord(cause) && typeof cause.statusCode === 'number' ? cause.statusCode : null
    if (statusCode === 404) return {}
    throw cause
  }
}

async function saveProductLocalization(locale: string, submitted: Record<string, unknown>): Promise<void> {
  const row = product.value
  if (!row) throw new Error(`The ${itemLabel.value.toLowerCase()} is unavailable.`)
  const values: Record<string, unknown> = {}
  for (const key of ['name', 'description']) {
    if (Object.hasOwn(submitted, key)) values[key] = submitted[key]
  }
  const details: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(submitted)) {
    if (key.startsWith('detail:')) details[key.slice('detail:'.length)] = value
  }
  if (Object.keys(details).length) values.details = details
  await dashboardApi(`/api/editor/organizations/${organizationId}/localization/product/${row.id}/${encodeURIComponent(locale)}`, {
    method: 'PUT',
    body: { values },
    validate: isProductLocalizationResponse,
  })
}

useSeoMeta({ title: () => `${pageTitle.value} | KrabiClaw Dashboard`, robots: 'noindex, nofollow' })
provide(productEditorKey, {
  reload,
  form,
  assignmentSummary: computed(assignmentSummary),
  product,
  published,
  bookingOffering,
  itemLabel,
  currency,
  organizationId,
  locationId,
  location,
  stayLocation,
  stayLocationError,
  organizationLocations,
  allOrganizationLocations: computed(() => allOrganizationLocations.value),
  organizationLocationsError: computed(() => locationsError.value ? getErrorMessage(locationsError.value, 'Locations could not be loaded') : null),
  collections,
  sectionPath,
  definitions: computed(() => definitions.value.filter(field => !(STAY_HOUSE_RULE_DETAIL_KEYS as readonly string[]).includes(field.key) && !(STAY_SAFETY_DETAIL_KEYS as readonly string[]).includes(field.key))),
  isNew,
  loadError,
  sectionLabels,
  saving,
  saveError,
  photoError,
  saveLabel,
  saveDisabled,
  propertyTypeErrors,
  setPrimaryImage,
  galleryRows,
  addGalleryRow,
  setGalleryAsset,
  removeGalleryPhoto,
  moveGalleryPhoto,
  photoAssets,
  photoRooms,
  createStayPhotoRoom,
  updateStayPhotoRoom,
  updateStayAccessibility,
  deleteStayPhotoRoom,
  moveStayPhotos,
  addStayPhoto,
  reorderStayPhotos,
  describeStayPhoto,
  removeStayPhotos,
  createPage,
  addOption,
  removeOption,
  setOptionValues,
  setDetail,
  listValue,
  textValue,
  weekdays: WEEKDAYS,
  scheduleError,
  reloadSchedule,
  savedSlotsFor,
  slotsFor,
  addSlot,
  removeSlot,
  revert,
  save,
  arrivalHome,
  arrivalDraft,
  arrivalError,
  arrivalManage,
  arrivalChanged,
  saveArrival,
})
</script>
