<template>
  <GuidedSetupShell id="guided-stay-home" :title="step?.title" :detail="step && 'detail' in step ? step.detail : undefined"
    :wide="step && ['property', 'pin', 'visibility', 'amenities', 'photos', 'description'].includes(step.id)"
    :position="position" :total="flow?.steps.length" :next-label="step?.action" :back-label="finishing ? undefined : flow?.back_label"
    :exit-label="finishing ? undefined : flow?.exit_label ?? 'Save & exit'" :exit-disabled="uploadingPhotos || !step || draftChanged" :busy="pending || selectingAddress"
    :disabled="incomplete || uploadingPhotos || draftChanged" @next="advance" @back="back" @exit="saveAndExit">
    <USkeleton v-if="!step && pending" class="h-12 w-3/4" />
    <fieldset v-if="step" :inert="finishing">
      <div v-if="step.id === 'address-search'" class="space-y-4">
        <GooglePlacePicker v-model="addressQuery" v-model:selecting="selectingAddress" purpose="address" :placeholder="step.search_placeholder" @select="selectAddress" />
        <p v-if="hasAddress" class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-lucide-map-pin" aria-hidden="true" />{{ formatPostalAddress(location.address) }}
        </p>
        <UButton type="button" color="neutral" variant="link" class="px-0" :label="step.manual_label" :disabled="pending || selectingAddress" @click="advance(true)" />
      </div>

      <div v-else-if="step.id === 'address'" class="divide-y divide-default overflow-hidden rounded-xl border border-default">
        <UFormField v-for="field in step.fields" :key="field.key" :label="field.label" :required="field.required" class="px-4 py-2" :ui="{ label: 'text-xs text-muted' }">
          <CountrySelect
            v-if="field.key === 'country'" :model-value="textValue(field.key)" :items="countries"
            :aria-label="field.label" variant="none" placeholder="Select country" class="w-full"
            :ui="{ base: 'min-h-8 py-0 ps-7 pe-8', leading: 'ps-0' }" @update:model-value="setAddress(field.key, $event ?? '')"
          />
          <USelectMenu
            v-else-if="field.key === 'timezone'" :model-value="textValue(field.key)" :items="timezones"
            value-key="value" :aria-label="field.label" variant="none" placeholder="Select time zone" class="w-full"
            :ui="{ base: 'min-h-8 px-0 py-0' }" @update:model-value="setAddress(field.key, $event ?? '')"
          />
          <UInput
            v-else :model-value="textValue(field.key)" :autocomplete="autocomplete[field.key]"
            variant="none" class="w-full" :ui="{ base: 'min-h-8 px-0 py-0' }" @update:model-value="setAddress(field.key, String($event ?? ''))"
          />
        </UFormField>
      </div>

      <OnboardingChoiceGrid
        v-else-if="step.id === 'property'"
        :choices="step.choices"
        :model-value="textValue('property_type')"
        class="grid-cols-2 sm:grid-cols-3 [&>button]:min-h-24 [&>button]:gap-2 [&>button]:p-4"
        @update:model-value="answers.property_type = $event"
      />

      <div v-else-if="step.id === 'access'" class="grid gap-3">
        <button v-for="choice in step.choices" :key="choice.value" type="button"
          :aria-pressed="answers.listing_type === choice.value"
          class="flex items-center justify-between gap-4 rounded-xl border-2 p-5 text-start"
          :class="answers.listing_type === choice.value ? 'border-inverted bg-elevated' : 'border-default hover:border-accented'"
          @click="answers.listing_type = choice.value">
          <span><span class="block font-semibold">{{ choice.label }}</span><span class="mt-1 block text-sm text-muted">{{ choice.detail }}</span></span>
          <UIcon :name="choice.icon" class="size-7 shrink-0" aria-hidden="true" />
        </button>
      </div>

      <div v-else-if="step.id === 'pin'" class="space-y-4">
        <p class="text-muted">Drag the map so the pin marks your place.</p>
        <StaySetupMap :pin="pin" :city="textValue('city')" :region="textValue('state')" :country="textValue('country')" interactive @move="placePin" />
      </div>

      <div v-else-if="step.id === 'visibility'" class="space-y-6">
        <div class="flex items-start justify-between gap-6">
          <div>
            <label for="home-specific-location" class="font-semibold">Show your home's specific location</label>
            <p class="mt-2 text-sm text-muted">Your street address stays private until a reservation is confirmed.</p>
          </div>
          <USwitch id="home-specific-location" v-model="specificLocation" />
        </div>
        <figure class="overflow-hidden rounded-xl border border-default">
          <StaySetupMap :key="String(specificLocation)" :pin="publicMap.public_area?.center ?? null" :city="textValue('city')" :region="textValue('state')" :country="textValue('country')" :approximate="publicMap.public_area?.approximate" />
          <figcaption class="p-4 text-sm text-muted">{{ publicMap.public_area?.approximate ? 'Guests see the approximate area.' : 'Guests see the precise pin.' }}</figcaption>
        </figure>
      </div>

      <div v-else-if="step.id === 'amenities'" class="space-y-8">
        <section v-for="group in step.groups" :key="group.label" class="space-y-3">
          <h2 class="text-lg font-semibold">{{ group.label }}</h2>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <button v-for="choice in group.choices" :key="choice.value" type="button"
              :aria-pressed="amenities.includes(choice.value)"
              class="flex min-h-24 flex-col gap-2 rounded-xl border-2 p-4 text-start"
              :class="amenities.includes(choice.value) ? 'border-inverted bg-elevated' : 'border-default hover:border-accented'"
              @click="toggleAmenity(choice.value)">
              <UIcon :name="choice.icon" class="size-6" aria-hidden="true" />{{ choice.label }}
            </button>
          </div>
        </section>
      </div>

      <GuidedSetupPhotos v-else-if="step.id === 'photos'" v-model="photos" v-model:uploading="uploadingPhotos"
        :limit="step.max_photos" photo-label="Listing photo" :disabled="pending" />

      <div v-else-if="step.id === 'rooms' || step.id === 'booking'">
        <div class="divide-y divide-default border-y border-default">
          <div v-for="count in step.counts" :key="count.key" class="flex items-center justify-between gap-4 py-3">
            <label :for="`home-${count.key}`" class="font-medium">{{ count.label }}</label>
            <UInputNumber
              :id="`home-${count.key}`" :model-value="numberValue(count.key)" :min="count.min" :max="count.max" :step="count.step"
              :aria-label="count.label" variant="none" class="w-32"
              :ui="{ base: 'tabular-nums', increment: 'rounded-full border border-default', decrement: 'rounded-full border border-default' }"
              @update:model-value="answers[count.key] = $event ?? count.min"
            />
          </div>
        </div>
      </div>
      <div v-else-if="step.id === 'highlights'" class="flex flex-wrap gap-3">
        <button v-for="choice in step.choices" :key="choice.value" type="button"
          class="inline-flex items-center gap-2 rounded-full border px-4 py-3 font-medium focus-visible:outline focus-visible:outline-offset-2 disabled:opacity-40"
          :class="numberValue(choice.value) ? 'border-inverted bg-elevated ring-1 ring-inverted' : 'border-default hover:border-inverted'"
          :aria-pressed="numberValue(choice.value) === 1"
          :disabled="!numberValue(choice.value) && step.choices.filter(item => numberValue(item.value)).length >= step.max_selections"
          @click="toggle(choice.value)">
          <UIcon :name="choice.icon" class="size-5" />{{ choice.label }}
        </button>
      </div>
      <div v-else-if="step.id === 'pricing'" class="space-y-3">
        <UFormField v-for="field in step.fields" :key="field.key" :label="field.label"
          class="rounded-2xl border border-default bg-elevated/40 p-5" :ui="{ label: 'font-medium' }">
          <div v-if="field.key === 'base_price'" class="flex items-center gap-1">
            <span class="text-3xl font-bold sm:text-4xl" aria-hidden="true">{{ step.currency_symbol }}</span>
            <UInput :model-value="textValue(field.key)" :aria-label="field.label" inputmode="decimal" placeholder="0"
              size="xl" class="w-full" variant="none" :ui="{ base: 'px-0 text-3xl font-bold sm:text-4xl' }"
              @update:model-value="answers[field.key] = $event" />
          </div>
          <div v-else class="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
            <div class="flex items-baseline text-3xl font-bold sm:text-4xl">
              <UInputNumber :model-value="numberValue(field.key) ?? 0" :min="step.counts[0]?.min" :max="step.counts[0]?.max"
                :aria-label="field.label" :increment="false" :decrement="false" variant="none" size="xl"
                :format-options="{ signDisplay: 'exceptZero', useGrouping: false }"
                :ui="{ base: 'w-[5ch] p-0 text-right text-3xl font-bold sm:text-4xl supports-[field-sizing:content]:w-auto supports-[field-sizing:content]:field-sizing-content' }"
                @update:model-value="answers[field.key] = $event ?? 0" />
              <span aria-hidden="true">%</span>
            </div>
            <p class="pb-1 text-right text-xs text-muted">
              <template v-if="weekendRate"><span>{{ weekendRate }}</span> · </template>{{ field.detail }}
            </p>
          </div>
        </UFormField>
      </div>
      <div v-else-if="step.id === 'discounts'" class="space-y-3">
        <div v-for="choice in step.choices" :key="choice.value"
          class="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl border border-default bg-neutral-100 px-4 py-5 dark:bg-neutral-800 sm:gap-4 sm:px-5"
          :class="numberValue(choice.value + '_enabled') ? 'border-accented' : ''">
          <div class="flex items-center justify-center rounded-lg border border-default bg-default px-1 py-1">
            <UInputNumber :model-value="numberValue(choice.value) ?? choice.suggested_percent" :min="step.counts.find(count => count.key === choice.value)?.min" :max="step.counts.find(count => count.key === choice.value)?.max"
              :aria-label="choice.label + ' percentage'" :increment="false" :decrement="false" variant="none" class="w-9" :ui="{ base: 'p-0 text-right font-semibold' }"
              @update:model-value="answers[choice.value] = $event ?? choice.suggested_percent" />
            <span class="pr-1 text-sm font-semibold" aria-hidden="true">%</span>
          </div>
          <div><p class="font-medium">{{ choice.label }}</p><p class="text-sm text-muted">{{ choice.detail }}</p></div>
          <UCheckbox :model-value="numberValue(choice.value + '_enabled') === 1" :aria-label="choice.label"
            color="neutral" size="lg" @update:model-value="toggle(choice.value + '_enabled')" />
        </div>
      </div>
      <div v-else-if="step.id === 'disclosures'" class="divide-y divide-default">
        <div v-for="field in step.fields" :key="field.key" class="py-4">
          <UCheckbox :model-value="numberValue(field.key) === 1" :label="field.label" size="lg"
            :ui="{ root: 'flex-row-reverse justify-between', wrapper: 'ms-0' }" @update:model-value="toggle(field.key)" />
          <UTextarea v-if="numberValue(field.key)" :model-value="textValue(field.detail_key)" :maxlength="step.max_length"
            :aria-label="field.label + ': details'" class="mt-3 w-full" :rows="3"
            @update:model-value="answers[field.detail_key] = $event" />
        </div>
      </div>
      <UFormField v-else :label="step.name_label" :ui="{ label: 'sr-only' }">
        <UTextarea v-model="writtenAnswer" :aria-label="step.name_label" :maxlength="step.max_length" :rows="step.id === 'description' ? 10 : 4" size="xl" class="w-full" />
        <p class="mt-2 text-sm text-muted" aria-hidden="true">{{ writtenAnswer.length }}/{{ step.max_length }}</p>
      </UFormField>
    </fieldset>
    <UAlert v-if="error" color="error" variant="soft" class="mt-5" :description="error" />
    <UButton v-if="error && (!step || draftChanged)" type="button" color="neutral" variant="outline" class="mt-4" @click="load">{{ draftChanged ? 'Reload saved answers' : 'Try again' }}</UButton>
  </GuidedSetupShell>
</template>

<script setup lang="ts">
import GuidedSetupShell from './GuidedSetupShell.vue'
import GuidedSetupPhotos from './GuidedSetupPhotos.vue'
import { projectPublicLocation } from '~/shared/location-sharing'
import StaySetupMap from './StaySetupMap.client.vue'
import OnboardingChoiceGrid from '~/lib/components/workspace/onboarding/OnboardingChoiceGrid.vue'
import GooglePlacePicker from '~/lib/components/workspace/location/GooglePlacePicker.vue'
import type { OnboardingPlacePreview } from '~/composables/useOnboardingFlow'
import { formatPostalAddress } from '~/utils/postal-address'
import { stayHomeSetupResponse, staySetupNightlyRates, type StayHomeSetupResponse } from '~/shared/stay-home-setup'
import { minorAmountToMajor } from '~/shared/prices'
import { isCurrencyCode } from '~/shared/currencies'
import { getErrorMessage } from '~/utils/errors'
import { ApiClientError } from '~/utils/api-clients'
import { listPhoneCountries } from '~/utils/phone'
import { TIMEZONE_OPTIONS, timezoneLabel } from '~/utils/timezone'

type Flow = Extract<StayHomeSetupResponse, { steps: unknown }>

const api = useDashboardApi()
const organizationId = useDashboardOrganizationId()
const photos = ref<{ asset_id: string; public_url: string }[]>([])
const amenities = ref<string[]>([])
const uploadingPhotos = ref(false)
const countries = listPhoneCountries()
const answers = ref<Record<string, string | number | undefined>>({})
const addressQuery = computed({
  get: () => textValue('address_query'),
  set: (value: string) => { answers.value.address_query = value.slice(0, 200) },
})
const flow = shallowRef<Flow>()
const position = ref(0)
const step = computed(() => flow.value?.steps[position.value])
const pricing = computed(() => flow.value?.steps.find(item => item.id === 'pricing'))
const pending = ref(true)
const selectingAddress = ref(false)
const finishing = ref(false)
const draftChanged = ref(false)
const error = ref('')
const textValue = (key: string) => String(answers.value[key] ?? '')
const numberValue = (key: string) => typeof answers.value[key] === 'number' ? answers.value[key] : undefined
const weekendRate = computed(() => {
  const currency = pricing.value?.currency
  if (!isCurrencyCode(currency) || !textValue('base_price').trim()) return null
  try {
    const rates = staySetupNightlyRates(textValue('base_price'), currency, numberValue('weekend_adjustment'))
    const format = (amount: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 0 }).format(Number(minorAmountToMajor(amount, currency)))
    return format(rates.weekendPrice)
  } catch {
    return null
  }
})
const writtenField = computed(() => step.value?.id === 'description' ? 'description' : 'name')
const writtenAnswer = computed({ get: () => textValue(writtenField.value), set: value => { answers.value[writtenField.value] = value } })
const specificLocation = computed({ get: () => answers.value.stay_map_sharing === 'specific', set: value => { answers.value.stay_map_sharing = value ? 'specific' : 'general' } })
const coordinates = computed(() => ({ latitude: numberValue('latitude') ?? null, longitude: numberValue('longitude') ?? null }))
const pin = computed(() => coordinates.value.latitude != null && coordinates.value.longitude != null ? { latitude: coordinates.value.latitude, longitude: coordinates.value.longitude } : null)
const location = computed(() => ({
  title: '',
  address: { regionCode: textValue('country'), addressLines: [textValue('address')], locality: textValue('city'), administrativeArea: textValue('state'), postalCode: textValue('zip_code') },
  ...coordinates.value,
}))
const publicMap = computed(() => projectPublicLocation(location.value, { is_stay_location: 1, stay_map_sharing: specificLocation.value ? 'specific' : 'general' }))
const timezones = computed(() => [...new Set([textValue('timezone'), ...TIMEZONE_OPTIONS])].filter(Boolean).map(value => ({ value, label: timezoneLabel(value) })))
const hasAddress = computed(() => Boolean(flow.value?.steps.find(item => item.id === 'address')
  ?.fields.every(field => !field.required || textValue(field.key).trim())))
const incomplete = computed(() => {
  switch (step.value?.id) {
    case 'address-search': return !hasAddress.value
    case 'address': return step.value.fields.some(field => field.required && !textValue(field.key).trim())
    case 'property': return !textValue('property_type')
    case 'access': return !textValue('listing_type')
    case 'title': return !textValue('name').trim()
    case 'pricing': return step.value.fields.some(field => field.required && !textValue(field.key).trim())
    case 'disclosures': return step.value.fields.some(field => numberValue(field.key) && !textValue(field.detail_key).trim())
    case 'highlights':
    case 'booking':
    case 'discounts':
    case 'pin':
    case 'rooms':
    case 'visibility':
    case 'amenities':
    case 'photos':
    case 'description': return false
    default: return true
  }
})
const autocomplete: Record<string, string> = { address: 'street-address', city: 'address-level2', state: 'address-level1', zip_code: 'postal-code' }
let idempotencyKey: string | undefined
let revision: string | undefined

function setAddress(key: string, value: string) {
  if (key !== 'timezone' && answers.value[key] !== value) {
    delete answers.value.latitude
    delete answers.value.longitude
    delete answers.value.timezone
  }
  answers.value[key] = value
}

function selectAddress(place: OnboardingPlacePreview) {
  const address = place.address
  if (!address) {
    error.value = 'This result has no street address. Choose another result or enter it manually.'
    return
  }
  setAddress('country', address.regionCode)
  setAddress('address', address.addressLines.join(', '))
  setAddress('city', address.locality ?? '')
  setAddress('state', address.administrativeArea ?? '')
  setAddress('zip_code', address.postalCode ?? '')
  if (place.timezone) setAddress('timezone', place.timezone)
  void advance(true)
}

function placePin(pin: { latitude: number; longitude: number }) {
  answers.value.latitude = pin.latitude
  answers.value.longitude = pin.longitude
}

function toggle(key: string) {
  answers.value[key] = numberValue(key) === 1 ? 0 : 1
}

function toggleAmenity(code: string) {
  amenities.value = amenities.value.includes(code) ? amenities.value.filter(value => value !== code) : [...amenities.value, code]
}

async function request(body: object) {
  return await api<StayHomeSetupResponse>('/api/dashboard/stay-homes/setup', {
    method: 'POST', body, validate: (value): value is StayHomeSetupResponse => stayHomeSetupResponse.safeParse(value).success,
  })
}

async function load() {
  pending.value = true
  error.value = ''
  try {
    const response = await request({})
    if (!('steps' in response)) throw new Error('Home setup returned no steps.')
    draftChanged.value = false
    const draft = response.draft
    answers.value = { ...(draft?.answers ?? response.defaults) }
    flow.value = response
    photos.value = draft?.photos ?? []
    amenities.value = draft?.amenities ?? []
    idempotencyKey = draft?.idempotency_key
    revision = draft?.revision
    finishing.value = draft?.finishing === true
    position.value = 0
    if (!draft) return
    const index = response.steps.findIndex(step => step.id === draft.step)
    if (index === -1) throw new Error('Home setup returned an unknown saved step.')
    position.value = index
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not open home setup.')
  } finally {
    pending.value = false
  }
}

async function saveAndExit() {
  if (!step.value || pending.value || uploadingPhotos.value) return
  pending.value = true
  error.value = ''
  try {
    const response = await request({ ...submission(step.value.id), action: 'exit' })
    if (!('to' in response)) throw new Error('Home setup returned no exit destination.')
    await refreshNuxtData(`first-home-setup:${organizationId}`)
    await navigateTo(response.to, { replace: true })
  } catch (cause) {
    draftChanged.value = cause instanceof ApiClientError && cause.code === 'STAY_HOME_DRAFT_CHANGED'
    error.value = getErrorMessage(cause, 'Could not save your progress.')
  } finally {
    pending.value = false
  }
}

function submission(id: string) {
  return { step: id, answers: { ...answers.value, amenities: amenities.value, photo_ids: photos.value.map(photo => photo.asset_id) }, idempotency_key: idempotencyKey ??= crypto.randomUUID(), revision }
}

function back() {
  if (draftChanged.value) return
  position.value--
  error.value = ''
}

async function advance(addressSelected = false) {
  if (!step.value || pending.value || (incomplete.value && !(step.value.id === 'address-search' && addressSelected)) || uploadingPhotos.value) return
  pending.value = true
  error.value = ''
  try {
    const response = await request(submission(step.value.id))
    if ('next' in response) {
      if (response.suggested_description && !answers.value.description) answers.value.description = response.suggested_description
      const index = flow.value?.steps.findIndex(step => step.id === response.next) ?? -1
      if (index < 0) throw new Error('Home setup returned an unknown step.')
      position.value = index
    } else if ('home' in response) {
      await refreshNuxtData([`first-home-setup:${organizationId}`, `product-catalog:${organizationId}`])
      await navigateTo(response.to, { replace: true })
    } else {
      throw new Error('Home setup did not advance.')
    }
  } catch (cause) {
    draftChanged.value = cause instanceof ApiClientError && cause.code === 'STAY_HOME_DRAFT_CHANGED'
    error.value = getErrorMessage(cause, 'Could not continue home setup.')
  } finally {
    pending.value = false
  }
}

onMounted(load)
</script>
