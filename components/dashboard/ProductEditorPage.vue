<template>
  <!-- One product: its rows are the things it holds, each a leaf below this level. -->
  <DashboardIndexPanel id="product" :title="form.name || presentation.itemLabel" :auto-open="autoOpenTarget">
    <template v-if="product" #right>
      <DashboardResourceLocalization
      :organization-id="organizationId"
      resource-type="product"
      :resource-id="productId"
      :resource-label="presentation.itemLabel.toLowerCase()"
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
      :title="`${presentation.itemLabel} could not be loaded`"
      :description="loadError"
    />
    <template v-else>
      <div v-if="isNew" class="mb-6 flex justify-end">
        <UButton :label="createActionLabel" :loading="saving" @click="startOrCreate" />
      </div>
      <EditorNavigationList :groups="navigationGroups" :active-item="level.child.value" />
    </template>
  </DashboardIndexPanel>
</template>

<script lang="ts">
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { Collection, Product } from '~/server/types/products'
import type { DashboardLocation } from '~/composables/useDashboardOrganization'

export const SECTION_KEYS = ['photo', 'kind', 'name', 'price', 'description', 'page', 'options', 'order-url', 'attributes', 'publication', 'booking', 'locations', 'collections', 'stay'] as const
export type SectionKey = typeof SECTION_KEYS[number]
export type BookingConcern = 'enabled' | 'duration' | 'capacity' | 'confirmation' | 'payment' | 'location' | 'assignment' | number

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
  assigned_member_id: string
  assigned_team_id: string
  online_payment_required: boolean
  /** Held online: booked in the provider's working hours rather than weekly times at a location. */
  held_online: boolean
  image_asset_id: string | null
  /** A place to stay's one location, fixed once it is created, and its stay settings. */
  stay_location_id: string
  check_in_time: string
  check_out_time: string
  max_guests: string
  min_nights: string
  stay_team_id: string
  /** Kept as loaded: this editor assigns a team, and saving never clears a member set elsewhere. */
  stay_member_id: string
}

/** The product's draft and what its leaves show or do beside their one field. */
export interface ProductEditor {
  form: ProductForm
  product: ComputedRef<Product | null>
  presentation: ComputedRef<{ itemLabel: string }>
  currency: string
  organizationId: string
  /** The location this editor is scoped to by its URL, or null for the whole organization. */
  locationId: ComputedRef<string | null>
  /** The location the scope names, once the organization's locations have loaded. */
  location: ComputedRef<DashboardLocation | null>
  organizationLocations: ComputedRef<DashboardLocation[]>
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
  saveError: Ref<string | null>
  photoError: Ref<string | null>
  saveLabel: Ref<string>
  saveDisabled: Ref<boolean>
  setPrimaryImage: (assetId: string | null) => Promise<void>
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
  savedSlotsFor: (weekday: number) => ScheduleSlotDraft[]
  slotsFor: (weekday: number) => ScheduleSlotDraft[]
  addSlot: (weekday: number) => void
  removeSlot: (slot: ScheduleSlotDraft) => void
  revert: () => void
  /**
   * Commit the draft, then close the open leaf. A leaf nested below a section
   * (one option, one combination's price) names its own parent, so the save
   * lands where its Close would rather than back on the product.
   */
  save: (closeTo?: string, bookingConcern?: BookingConcern) => Promise<void>
}

export const productEditorKey = Symbol('product-editor') as InjectionKey<ProductEditor>
</script>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import type { ProductDetailField, ProductDetailValue, ProductKind } from '~/shared/product-details'
import { productDetailFields, PRODUCT_KINDS, PRODUCT_KIND_LABELS, assertProductKind, productDetailKey, PRICING_NOTE_HANDLE } from '~/shared/product-details'
import { isCurrencyCode } from '~/shared/currencies'
import { majorAmountToMinor, minorAmountToMajor, selectPrice, type Price } from '~/shared/prices'
import { formatProductMoney } from '~/utils/product-money'
import { presentationForProduct, requireProductPresentation } from '~/utils/product-presentation'
import { MINUTE_TIME_PATTERN } from '~/utils/timezone'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'

const route = useRoute()
const router = useRouter()
const dashboardApi = useDashboardApi()
const productId = computed(() => String(route.params.productId ?? ''))
// Catalog's explicit scope. No location is the whole organization: its own
// prices and settings, not whichever location was visited last.
const locationId = useLocationScope()
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
  const query = isNew.value ? route.query : { location_id: locationId.value ?? undefined }
  return router.resolve({ path: `${itemPath.value}/${section}`, query }).fullPath
}

const organizationId = await useDashboardOrganizationId()
const { refresh: refreshCatalog } = useProductCatalog(organizationId, ref(null))
const dashboard = useDashboardOrganization()
const { locations: organizationLocations, error: locationsError } = await useOrganizationLocations()
const location = computed(() => organizationLocations.value.find(entry => entry.id === locationId.value) ?? null)

const vertical = dashboard.organization.value?.vertical
if (!vertical) throw createError({ statusCode: 500, statusMessage: 'Organization vertical is not configured' })
// The words follow the product: a class is an experience whatever the site
// sells otherwise. Until the row has loaded, and for a product being created,
// the screen speaks the vertical's own surface — it is not yet known to be
// anything else.
const presentation = computed(() => (product.value ? presentationForProduct(vertical, product.value, dashboard.organization.value?.theme_id) : requireProductPresentation(vertical, dashboard.organization.value?.theme_id)))
const rawCurrency = dashboard.organization.value?.default_currency
if (!isCurrencyCode(rawCurrency)) throw createError({ statusCode: 500, statusMessage: 'Unsupported organization currency' })
const currency = rawCurrency

// ── Which leaf is open ──────────────────────────────────

const sectionLabels: Record<SectionKey, string> = {
  'kind': 'Type',
  'photo': 'Photo',
  'name': 'Name',
  'price': 'Price',
  'description': 'Description',
  'page': 'Page content',
  'options': 'Variants',
  'order-url': 'External link',
  'attributes': 'Details',
  'publication': 'Website',
  'booking': 'Scheduling',
  'locations': 'Locations',
  'stay': 'Stay settings',
  get collections() { return product.value?.kind === 'dish' ? 'Menu sections' : presentation.value.collectionGroupLabelPlural },
}

const detailKey = computed(() => level.child.value)
const editorKey = computed<SectionKey>(() => (detailKey.value ?? 'photo') as SectionKey)

const isNew = computed(() => productId.value === 'new')

// ── Load ────────────────────────────────────────────────
const definitions = computed(() => form.kind ? productDetailFields(form.kind) : [])
const saveError = ref<string | null>(null)
const photoError = ref<string | null>(null)
const saving = ref(false)

watch(editorKey, () => {
  saveError.value = null
  photoError.value = null
})

const isCollectionList = (value: unknown): value is { collections: Collection[] } =>
  isRecord(value) && Array.isArray(value.collections)
const isProductList = (value: unknown): value is { success: true, products: Product[] } =>
  isRecord(value) && Array.isArray(value.products)
const isOne = (value: unknown): value is { success: true, product: Product } =>
  isRecord(value) && isRecord(value.product)


// The product in this scope, read before the level renders. Keyed by location
// and product, so a scope change reads that location's prices and settings.
const { data: loaded, error: loadFailure, refresh } = await useAsyncData(
  () => `dashboard-product:${organizationId}:${locationId.value ?? 'organization'}:${productId.value}`,
  async () => {
    if (isNew.value) return null
    const id = locationId.value
    const [collectionResponse, productResponse] = await Promise.all([
      // Every collection, site-wide and per location: membership is the
      // product's, wherever the grouping lives.
      dashboardApi(`/api/editor/organizations/${organizationId}/collections`, { validate: isCollectionList }),
      dashboardApi(id ? `/api/editor/organizations/${organizationId}/locations/${encodeURIComponent(id)}/products/${encodeURIComponent(productId.value)}` : `/api/editor/organizations/${organizationId}/products/${encodeURIComponent(productId.value)}`, { validate: isOne }),
    ])
    return { collections: collectionResponse.collections, product: productResponse.product }
  },
)
const product = computed(() => loaded.value?.product ?? null)
const collections = computed(() => loaded.value?.collections ?? [])
// A product that is not there is not a page. A request that failed is a state
// this level shows, because the product may well still exist.
watchEffect(() => {
  if (loadFailure.value && isNotFoundError(loadFailure.value)) showError(createError({ statusCode: 404, statusMessage: `${presentation.value.itemLabel} not found` }))
})
const loadError = computed(() => (loadFailure.value && !isNotFoundError(loadFailure.value)
  ? getErrorMessage(loadFailure.value, `Failed to load this ${presentation.value.itemLabel.toLowerCase()}`)
  : null))

/**
 * A writer's re-read. A save or a photo change has just made this row different
 * from what was loaded; the photo preview and every index summary read
 * `product`, not the form. A failed re-read fails the write that asked for it.
 */
async function reload() {
  await refresh()
  if (loadFailure.value) throw loadFailure.value
  await refreshCatalog()
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
  ? 'Choose a location, or hold it online, in Meeting location before adding start times.'
  : scheduleFailure.value ? getErrorMessage(scheduleFailure.value, 'Could not load the weekly schedule') : null)
function savedSlotsFor(weekday: number) { return savedSchedule.value.filter(slot => slot.weekday === weekday) }
// The draft the weekday leaves edit, seeded from every read of the schedule.
const schedule = ref<ScheduleSlotDraft[]>([])
watch(savedSchedule, (rows) => { schedule.value = rows.map(slot => ({ ...slot })) }, { immediate: true })
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
  booking_capacity: '', scheduling_mode: 'legacy', assigned_member_id: '', assigned_team_id: '', confirmation_mode: 'instant', online_payment_required: false, held_online: false,
  image_asset_id: null as string | null,
  stay_location_id: '', check_in_time: '15:00', check_out_time: '11:00', max_guests: '', min_nights: '1', stay_team_id: '', stay_member_id: '',
}))
const form = reactive(draft.value)
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
// The draft is seeded from every read of the row, the first and each writer's re-read.
watch(product, (row) => { if (row) loadForm(row) }, { immediate: true })

function loadForm(row: Product) {
  form.kind = row.kind
  form.stay_location_id = row.stay?.location_id ?? ''
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
  form.assigned_member_id = row.booking?.assigned_member_id ?? ''
  form.assigned_team_id = row.booking?.assigned_team_id ?? ''
  form.online_payment_required = row.booking?.online_payment_required ?? false
  form.held_online = row.booking?.held_online ?? false
  form.booking_capacity = row.booking?.default_capacity === null || row.booking === null ? '' : String(row.booking.default_capacity)
  form.check_in_time = row.stay?.check_in_time ?? '15:00'
  form.check_out_time = row.stay?.check_out_time ?? '11:00'
  form.max_guests = row.stay ? String(row.stay.max_guests) : ''
  form.min_nights = row.stay ? String(row.stay.min_nights) : '1'
  form.stay_team_id = row.stay?.assigned_team_id ?? ''
  form.stay_member_id = row.stay?.assigned_member_id ?? ''
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

const sectionValid = computed(() => {
  if (editorKey.value === 'kind') return PRODUCT_KINDS.includes(form.kind as ProductKind)
  if (editorKey.value === 'name') return Boolean(form.name.trim())
  if (editorKey.value === 'stay') return !stayIncomplete()
  if (editorKey.value === 'options') {
    return form.options.every(option => option.name.trim() && option.values.length > 0)
  }
  return true
})

/** A place to stay is created at a location, with arrival and departure times and how many it sleeps. */
function stayIncomplete(): boolean {
  const guests = Number(form.max_guests)
  const nights = Number(form.min_nights)
  return !form.stay_location_id || !MINUTE_TIME_PATTERN.test(form.check_in_time) || !MINUTE_TIME_PATTERN.test(form.check_out_time)
    || !Number.isInteger(guests) || guests < 1 || guests > 99 || !Number.isInteger(nights) || nights < 1 || nights > 365
}
function staySummary(): string {
  const place = organizationLocations.value.find(entry => entry.id === form.stay_location_id)?.title
  if (!place) return 'Choose where it is'
  return `${place} · Check-in ${form.check_in_time}, checkout ${form.check_out_time} · Sleeps ${form.max_guests}`
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
function assignmentSummary(): string {
  if (form.assigned_team_id) return schedulingMembers.value?.teams.find(team => team.id === form.assigned_team_id)?.name ?? 'Assigned team'
  if (!form.assigned_member_id) return 'The business schedule'
  if (schedulingMembersError.value) return 'Team members could not be loaded'
  return schedulingMembers.value?.members.find(member => member.id === form.assigned_member_id)?.name ?? 'Assigned team member'
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
  // A duration not chosen yet says so; it is never shown as a number.
  const minutes = form.booking_duration ? `${form.booking_duration} minutes` : 'No duration set'
  if (!scheduleData.value) return minutes
  const count = schedule.value.filter(slot => slot.start_time.trim()).length
  return count ? `${minutes} · ${count === 1 ? '1 start time' : `${count} start times`} a week` : `${minutes} · No weekly availability set`
}

function publicationSummary(): string {
  const parts = [form.published ? 'Visible on website' : 'Hidden from website']
  if (!form.active) parts.push(form.kind === 'experience' || form.kind === 'service' ? 'Bookings paused' : 'Orders paused')
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
  if (!product.value) return []
  // One flat list, the same for every kind: what the product is, what it costs,
  // how it is booked, and where it is offered and shown.
  return [{
    id: 'item',
    items: [
      { id: 'photo', label: 'Photo', summary: image ? '' : 'No photo yet', placeholder: !image, to: sectionPath('photo') },
      { id: 'name', label: 'Name', summary: form.name || 'Not named yet', placeholder: !form.name, to: sectionPath('name') },
      { id: 'description', label: 'Description', summary: form.description || 'Nothing written yet', placeholder: !form.description, to: sectionPath('description') },
      // A service is shown by a page of its own. The page has one editor, in
      // Pages; this row is a way into it, and a page not made yet is made here.
      ...(product.value.page || form.kind === 'service'
        ? [{ id: 'page', label: 'Page content', summary: product.value.page ? product.value.page.path : 'No page', placeholder: !product.value.page, to: product.value.page ? `/dashboard/${String(route.params.orgSlug)}/website/pages/${encodeURIComponent(product.value.page.id)}` : sectionPath('page') }]
        : []),
      { id: 'price', label: form.kind === 'service' ? 'Consultation pricing' : form.kind === 'stay' ? 'Nightly price' : 'Price', summary: priceSummary(), placeholder: priceSummary() === 'No price set', to: pricePath.value },
      // A place to stay is at its one location under its stay settings; nights and
      // stays are on the Calendar, not scheduled sessions.
      ...(form.kind === 'stay' ? [{ id: 'stay', label: 'Stay settings', summary: staySummary(), to: sectionPath('stay') }] : []),
      // The person a service's consultations are booked with: the existing
      // assignment concern, reached from the overview. It belongs to bookings,
      // so until the service takes bookings the row leads there first.
      ...(form.kind === 'service'
        ? [product.value.booking
            ? { id: 'assignment', label: 'Assigned team member', summary: assignmentSummary(), to: `${sectionPath('booking')}/assignment` }
            : { id: 'assignment', label: 'Assigned team member', summary: 'Set up bookings first', placeholder: true, to: sectionPath('booking') }]
        : []),
      { id: 'options', label: 'Variants', summary: product.value.variants.length > 1 ? `${product.value.variants.length} variants` : 'One version', to: sectionPath('options') },
      {
        id: 'attributes',
        label: 'Details',
        summary: listSummary(definitions.value.filter(definition => form.details[productDetailKey(definition)] !== undefined).map(definition => definition.name), 'None set'),
        placeholder: !Object.keys(form.details).length,
        to: sectionPath('attributes'),
      },
      { id: 'kind', label: 'Type', summary: form.kind ? PRODUCT_KIND_LABELS[form.kind] : 'Choose a type', to: sectionPath('kind') },
      ...(form.kind === 'stay' ? [] : [{ id: 'booking', label: form.kind === 'service' ? 'Bookings' : 'Scheduling', summary: form.bookable ? bookingSummary() : 'Not bookable', placeholder: !form.bookable, to: sectionPath('booking') }]),
      { id: 'order-url', label: form.kind === 'stay' ? 'Booking link' : 'External link', summary: form.order_url || 'No external link', placeholder: !form.order_url, to: sectionPath('order-url') },
      ...(form.kind === 'stay' ? [] : [{ id: 'locations', label: 'Locations', summary: locationsSummary(), placeholder: !Object.keys(form.locations).length, to: sectionPath('locations') }]),
      { id: 'collections', label: sectionLabels.collections, summary: collectionsSummary(), placeholder: !form.collection_ids.length, to: sectionPath('collections') },
      { id: 'publication', label: 'Website visibility', summary: publicationSummary(), to: sectionPath('publication') },
    ].sort((left, right) => rowRank(left.id) - rowRank(right.id)),
  }]
})

/**
 * The row the editor opens on a wide screen: the first one that opens a leaf
 * beside this index. A row that leads into a level of its own — Bookings,
 * Variants — would open that level too and push this index off the screen.
 */
const LEAF_SECTIONS: readonly string[] = ['photo', 'name', 'description', 'price', 'kind', 'order-url']
const autoOpenTarget = computed(() => navigationGroups.value[0]?.items.find(item => LEAF_SECTIONS.includes(item.id) && item.to === sectionPath(item.id))?.to ?? null)

// A service leads with what is changed most: who handles it, what it costs,
// how it is booked and what its page says. Every other kind keeps the list as written.
const SERVICE_ROW_ORDER = ['assignment', 'price', 'booking', 'description', 'page', 'locations', 'publication']
function rowRank(id: string) {
  if (form.kind !== 'service') return 0
  const at = SERVICE_ROW_ORDER.indexOf(id)
  return at === -1 ? SERVICE_ROW_ORDER.length : at
}

/**
 * The sections this product actually has, read from the rows it offers rather
 * than from a list of every section a product could ever have — a product being
 * created has only its name, and the rows already say so.
 */
const openSections = computed(() => navigationGroups.value.flatMap(group => group.items.map(item => item.id)))

// A section this product does not have 404s. A watcher, not a setup-time check:
// moving between leaves reuses this component.
watchEffect(() => {
  // A product that failed to load has no rows, and every real section would
  // read as unsupported; the failure is shown instead, never a 404.
  if (!isNew.value && !product.value) return
  if (detailKey.value && !openSections.value.includes(detailKey.value)) {
    showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
  }
})

// ── Save / cancel ───────────────────────────────────────
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
  const carry = (price: Price) => ({
    id: price.id, unit_amount: price.unit_amount, currency: price.currency, location_id: price.location_id,
    active: price.active, type: price.type, recurring_interval: price.recurring_interval,
    recurring_interval_count: price.recurring_interval_count, tax_behavior: price.tax_behavior,
    compare_at_unit_amount: price.compare_at_unit_amount, valid_from_at: price.valid_from_at,
    valid_until_at: price.valid_until_at, source: price.source,
  })
  const priceFor = (variant: VariantDraft) => {
    const typed = variant.price_major.trim()
    if (typed === variant.loaded_price_major.trim()) return variant.prices.map(carry)
    const governing = selectPrice(variant.prices, selection)
    // An empty box is not a price of zero. Zero is typed, and means free.
    if (!typed) return variant.prices.filter(price => price.id !== governing?.id).map(carry)
    if (!governing) {
      return [...variant.prices.map(carry), { unit_amount: majorAmountToMinor(typed, currency), currency, location_id: priceLocationId() }]
    }
    return variant.prices.map(price => (price.id === governing.id
      ? { ...carry(price), unit_amount: majorAmountToMinor(typed, price.currency) }
      : carry(price)))
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

function payload() {
  // Options, variants and prices are restated only when they changed. A save
  // that renames a product says nothing about what it costs, and a patch that
  // omits variants leaves every offer exactly as it is.
  const catalog = buildCatalog()
  // A product being created with only a name says nothing about variants, and
  // the canonical writer gives it its one default variant. An empty list is a
  // claim that it has none, which is not a product.
  const describesCatalog = catalog.variants.length > 0
  const changed = JSON.stringify(catalog) !== loadedCatalogShape.value
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
    details: form.details,
    active: form.active,
    // Stay settings are restated only when they are what is being saved, so a
    // description save never writes back settings someone else changed.
    ...(form.kind === 'stay' && (isNew.value || editorKey.value === 'stay') ? { stay: {
      ...(isNew.value ? { location_id: form.stay_location_id } : {}),
      check_in_time: form.check_in_time, check_out_time: form.check_out_time,
      max_guests: Number(form.max_guests), min_nights: Number(form.min_nights),
      assigned_member_id: form.stay_member_id || null, assigned_team_id: form.stay_team_id || null,
    } } : {}),
  }
}

const { createActionLabel, saveLabel: createSaveLabel, saveDisabled, save: saveCurrentEditor, startOrCreate } = useCreateWalk({
  recordPath: itemPath,
  isNew,
  openKey: editorKey,
  labels: sectionLabels,
  order: () => form.kind === 'stay' ? ['kind', 'name', 'stay'] : ['kind', 'name'],
  missing: key => key === 'name' ? !form.name.trim() : key === 'stay' ? stayIncomplete() : !form.kind,
  noun: () => form.kind ? presentationForProduct(vertical, { kind: assertProductKind(form.kind) }, dashboard.organization.value?.theme_id).itemLabel.toLowerCase() : 'product',
  saving,
  // A product that could not be read has no draft worth writing over it.
  existingBlocked: () => !product.value || !sectionValid.value,
  commit,
})

// Saving content and publishing the listing are separate owner decisions.
const saveLabel = computed(() => createSaveLabel.value ?? 'Save')

const closeTo = ref<string | null>(null)
async function save(target?: string, bookingConcern?: BookingConcern) {
  closeTo.value = target ?? null
  try { if (bookingConcern !== undefined) await commit(bookingConcern); else await saveCurrentEditor() } finally { closeTo.value = null }
}

async function commit(bookingConcern?: BookingConcern) {
  const id = locationId.value
  saving.value = true
  saveError.value = null
  try {
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
      if (createCollectionId.value) await setCollectionMembership(created.product.id, createCollectionId.value, true)
      await refreshCatalog()
      // The record it became, not the `new` form it was, so Back from a saved
      // product goes to Catalog and never to an empty Add screen.
      clearNuxtState([draftKey, createKeyName])
      await navigateTo(router.resolve({ path: `${catalogPath.value}/${created.product.id}`, query: { location_id: id ?? undefined } }).fullPath, { replace: true })
      return
    }
    if (bookingConcern !== undefined) {
      await saveBooking(bookingConcern)
    } else {
      await dashboardApi(`/api/editor/organizations/${organizationId}/products/${productId.value}`, {
        method: 'PATCH', body: payload(), validate: isOne,
      })
      if (editorKey.value === 'publication') await savePublication()
      if (editorKey.value === 'locations') await saveLocation()
      if (editorKey.value === 'collections') await saveCollections()
    }
    await reload()
    // A booking write changes what the schedule is: its start times, whether the
    // product has a calendar at all, or the time zone an online one runs in.
    if (bookingConcern !== undefined) await reloadSchedule()
    await (closeTo.value ? navigateTo(closeTo.value) : level.close())
  } catch (error) {
    saveError.value = getErrorMessage(error, `Failed to save ${presentation.value.itemLabel.toLowerCase()}`)
  } finally {
    saving.value = false
  }
}

/**
 * Put a product into a collection, at the end, or take it out.
 *
 * Membership is stated whole — the writer replaces the collection with exactly
 * the ids it is sent — so the current members are read first, across the whole
 * organization, and their existing order is kept.
 */
async function setCollectionMembership(memberId: string, collectionId: string, member: boolean) {
  const { products } = await dashboardApi(`/api/editor/organizations/${organizationId}/products`, { validate: isProductList })
  const members = products
    .flatMap(row => row.collections
      .filter(entry => entry.collection_id === collectionId)
      .map(entry => ({ id: row.id, sort_order: entry.sort_order })))
    .sort((left, right) => left.sort_order - right.sort_order)
    .map(entry => entry.id)
    .filter(existing => existing !== memberId)
  await dashboardApi(`/api/editor/organizations/${organizationId}/collections/${collectionId}/products`, {
    method: 'PUT',
    body: { product_ids: member ? [...members, memberId] : members },
    validate: isRecord,
  })
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

/** Join the collections that were switched on and leave the ones switched off, each stated whole. */
async function saveCollections() {
  const before = new Set(product.value?.collections.map(entry => entry.collection_id) ?? [])
  const after = new Set(form.collection_ids)
  for (const collection of collections.value) {
    if (before.has(collection.id) !== after.has(collection.id)) await setCollectionMembership(productId.value, collection.id, after.has(collection.id))
  }
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
    : concern === 'assignment' ? { scheduling_mode: form.scheduling_mode, assigned_member_id: form.assigned_member_id || null, assigned_team_id: form.assigned_team_id || null }
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
function revert() {
  saveError.value = null
  photoError.value = null
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
  if (!row) throw new Error(`The ${presentation.value.itemLabel.toLowerCase()} is unavailable.`)
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

useSeoMeta({ title: () => `${form.name || presentation.value.itemLabel} | Krabiclaw Dashboard`, robots: 'noindex, nofollow' })
provide(productEditorKey, {
  form,
  product,
  presentation,
  currency,
  organizationId,
  locationId,
  location,
  organizationLocations,
  organizationLocationsError: computed(() => locationsError.value ? getErrorMessage(locationsError.value, 'Locations could not be loaded') : null),
  collections,
  sectionPath,
  definitions,
  isNew,
  loadError,
  sectionLabels,
  saving,
  saveError,
  photoError,
  saveLabel,
  saveDisabled,
  setPrimaryImage,
  createPage,
  addOption,
  removeOption,
  setOptionValues,
  setDetail,
  listValue,
  textValue,
  weekdays: WEEKDAYS,
  scheduleError,
  savedSlotsFor,
  slotsFor,
  addSlot,
  removeSlot,
  revert,
  save,
})
</script>
