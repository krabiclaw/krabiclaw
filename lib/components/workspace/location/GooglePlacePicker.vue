<template>
  <div class="flex flex-col gap-2" data-google-place-picker>
    <UInputMenu
      v-model="searchTerm"
      mode="autocomplete"
      :items="items"
      value-key="label"
      ignore-filter
      :loading="loading || selecting"
      :disabled="selecting"
      :placeholder="placeholder ?? 'Search for your business on Google Maps'"
      trailing-icon="i-lucide-search"
      class="w-full"
      autofocus
    >
      <template #empty>
        {{ emptyText }}
      </template>
      <!-- A caller's own actions sit under the predictions. Predictions shown
           without a map carry Google Maps attribution; text attribution is
           Google's documented form where the logo is not used: exactly
           "Google Maps", Roboto 400, #5E5E5E on light and white on dark. -->
      <template #content-bottom>
        <slot name="actions" />
        <p class="border-t border-default px-2.5 py-1.5 text-right text-xs font-normal text-[#5E5E5E] dark:text-white" style="font-family: Roboto, sans-serif;" data-google-maps-attribution>
          Google Maps
        </p>
      </template>
    </UInputMenu>
    <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { applicationFetch } from '~/composables/dashboardFetch'
import type { OnboardingPlacePreview } from '~/composables/useOnboardingFlow'
import type { GooglePlaceSuggestion } from '~/server/utils/google-places'
import { validateApiShape } from '~/utils/api-validation'
import { getErrorMessage } from '~/utils/errors'

/**
 * The one business search for every surface that connects a location to a
 * Google place: new-site onboarding and Settings → Google Maps.
 *
 * It owns Google's Autocomplete (New) session. A token is minted when a search
 * starts, reused for every prediction request in it, and sent once more with
 * the Place Details request for the chosen prediction, which ends the session.
 * The next search mints a new token. Selecting a prediction is the owner's
 * confirmation: the caller receives the place and decides what that means.
 */
const props = defineProps<{ modelValue?: string; placeholder?: string }>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  select: [place: OnboardingPlacePreview]
}>()

const DEBOUNCE_MS = 250
const MIN_INPUT = 3

const searchTerm = ref(props.modelValue ?? '')
const suggestions = ref<GooglePlaceSuggestion[]>([])
// Choosing a prediction writes its name into the box. That is the selection,
// not a new search, so it must not open another Google session.
let chosenName: string | null = null
const items = computed(() => suggestions.value.map(suggestion => ({
  label: suggestion.name,
  description: suggestion.addressLabel,
  onSelect: () => void select(suggestion),
})))
const loading = ref(false)
const selecting = ref(false)
const error = ref<string | null>(null)

let sessionToken: string | null = null
let debounce: ReturnType<typeof setTimeout> | null = null
// Only the newest request may write results: a slow answer for "Kiku" must
// not replace the one for "Kikuzuki".
let latestRequest = 0

const isSuggestions = validateApiShape<{ suggestions: GooglePlaceSuggestion[] }>({
  suggestions: { arrayOf: { placeId: 'string', name: 'string', addressLabel: 'string', fullText: 'string' } },
})
const isPlace = validateApiShape<OnboardingPlacePreview>({
  placeId: 'string', name: 'string', address: 'nullable-object', phone: 'nullable-string',
  mapsUrl: 'nullable-string', timezone: 'nullable-string',
})

const emptyText = computed(() => {
  if (searchTerm.value.trim().length < MIN_INPUT) return `Type at least ${MIN_INPUT} characters`
  if (loading.value) return 'Searching Google Maps…'
  if (error.value) return 'Search failed'
  return 'No matching places on Google Maps'
})

watch(() => props.modelValue, (value) => {
  if (value !== undefined && value !== searchTerm.value) searchTerm.value = value
})

watch(searchTerm, (value) => {
  emit('update:modelValue', value)
  if (value === chosenName) return
  chosenName = null
  if (debounce) clearTimeout(debounce)
  error.value = null
  if (value.trim().length < MIN_INPUT) {
    latestRequest++
    suggestions.value = []
    loading.value = false
    return
  }
  loading.value = true
  debounce = setTimeout(() => void search(value.trim()), DEBOUNCE_MS)
})

async function search(input: string) {
  sessionToken ??= crypto.randomUUID()
  const request = ++latestRequest
  try {
    const response = await applicationFetch('/api/dashboard/google-places/autocomplete', {
      method: 'POST', body: { input, sessionToken }, validate: isSuggestions,
    })
    if (request === latestRequest) suggestions.value = response.suggestions
  } catch (cause) {
    if (request !== latestRequest) return
    suggestions.value = []
    error.value = getErrorMessage(cause, 'Google Maps search failed. Try again.')
  } finally {
    if (request === latestRequest) loading.value = false
  }
}

async function select(suggestion: GooglePlaceSuggestion) {
  // A retry after a failed Place Details call has no open session left, so it
  // is a session of its own. Place Details closes the session whether or not
  // it succeeds, so the next search starts a new one.
  const token = sessionToken ?? crypto.randomUUID()
  sessionToken = null
  chosenName = suggestion.name
  if (debounce) clearTimeout(debounce)
  latestRequest++
  loading.value = false
  selecting.value = true
  error.value = null
  try {
    const place = await applicationFetch('/api/dashboard/google-places/details', {
      method: 'POST', body: { placeId: suggestion.placeId, sessionToken: token }, validate: isPlace,
    })
    emit('select', place)
  } catch (cause) {
    // The input still shows the name; it must search again when retyped.
    chosenName = null
    error.value = getErrorMessage(cause, 'Could not load that place from Google Maps. Try again.')
  } finally {
    selecting.value = false
  }
}

onBeforeUnmount(() => {
  if (debounce) clearTimeout(debounce)
  latestRequest++
})
</script>
