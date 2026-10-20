<template>
  <DashboardLeafPanel
    :id="`integration-google-maps-${String(route.params.locationSlug)}`"
    :title="location?.title ?? 'Google Maps'"
    :saving="saving"
    :error="error || integrations.failure.value"
    :footer="false"
  >
    <div v-if="location" class="space-y-6">
      <template v-if="location.google_place_id && !searching">
        <!-- The place leads with its picture, large; a muted pin holds the footprint when it has none. -->
        <div class="overflow-hidden rounded-2xl bg-elevated ring ring-default">
          <img v-if="location.image" :src="location.image" alt="" class="aspect-[16/7] w-full object-cover">
          <div v-else class="flex aspect-[16/7] w-full items-center justify-center">
            <UIcon name="i-lucide-map-pin" class="size-10 text-dimmed" />
          </div>
        </div>

        <div class="space-y-2">
          <UBadge color="success" variant="subtle" size="lg" class="rounded-full">
            <span class="size-2 rounded-full bg-success" />
            Connected to Google Maps
          </UBadge>
          <p v-if="location.address" class="text-muted">{{ location.address }}</p>
          <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span v-if="location.rating !== null" class="flex items-center gap-1 font-medium text-highlighted">
              <UIcon name="i-lucide-star" class="size-4 text-warning" />{{ location.rating }}
            </span>
            <span>{{ location.review_count ?? 0 }} reviews</span>
            <span aria-hidden="true" class="text-dimmed">|</span>
            <span>{{ location.last_synced_at ? `Updated ${new Date(location.last_synced_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : 'Not updated from Google yet' }}</span>
          </p>
        </div>

        <dl v-if="location.phone || location.website_url" class="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2 border-t border-default pt-5 text-sm">
          <template v-if="location.phone">
            <dt class="text-muted">Phone</dt>
            <dd class="text-highlighted">{{ formatPhone(location.phone) }}</dd>
          </template>
          <template v-if="location.website_url">
            <dt class="text-muted">Website</dt>
            <dd class="min-w-0 truncate"><ULink :to="location.website_url" target="_blank" class="text-highlighted underline underline-offset-4">{{ location.website_url }}</ULink></dd>
          </template>
        </dl>

        <div class="flex flex-wrap gap-3">
          <UButton icon="i-lucide-refresh-cw" color="neutral" variant="outline" @click="confirmingReimport = true">Re-import details from Google Maps</UButton>
          <UButton color="neutral" variant="ghost" @click="searching = true">Connect a different place</UButton>
        </div>
      </template>

      <!-- Picking a prediction is the confirmation: it connects that place. -->
      <UFormField v-else label="Find this location on Google Maps" description="Picking it connects it, and imports its address, phone, opening hours, timezone, rating and reviews into this location.">
        <GooglePlacePicker :model-value="location.title" @select="connect" />
        <p v-if="saving" class="mt-2 text-sm text-muted" aria-live="polite">Connecting to Google Maps…</p>
      </UFormField>
    </div>

    <UModal v-model:open="confirmingReimport" title="Re-import details from Google Maps?">
      <template #body>
        <p class="text-sm text-default">This replaces {{ location?.title }}'s <strong>address, phone, website, opening hours and timezone</strong> with what Google Maps has now. Anything you edited in KrabiClaw is overwritten.</p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmingReimport = false">Cancel</UButton>
          <UButton :loading="saving" @click="reimport">Replace with Google Maps details</UButton>
        </div>
      </template>
    </UModal>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { formatPhone } from '~/utils/phone'
import GooglePlacePicker from '~/lib/components/workspace/location/GooglePlacePicker.vue'
import type { OnboardingPlacePreview } from '~/composables/useOnboardingFlow'
import { integrationsKey } from '../../integrations.vue'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const integrations = inject(integrationsKey)!
const dashboardApi = useDashboardApi()
const level = useRouteLevel()
const location = computed(() => integrations.summary.value?.google_maps.find(candidate => candidate.slug === route.params.locationSlug) ?? null)
// A location the business does not have is not a page: it 404s rather than
// drawing a leaf for it. A leaf on its way out yields and reads nothing.
watchEffect(() => {
  if (level.mode.value !== 'yield' && integrations.summary.value && !location.value) {
    showError(createError({ statusCode: 404, statusMessage: 'Location not found' }))
  }
})

const isSuccess = (value: unknown): value is { success: true } => isRecord(value) && value.success === true

const searching = ref(false)
const saving = ref(false)
const confirmingReimport = ref(false)
const error = ref('')

async function importPlace(placeId?: string) {
  if (!location.value) return
  saving.value = true
  error.value = ''
  try {
    await dashboardApi('/api/integrations/google-places/sync', {
      method: 'POST',
      body: { organizationId: integrations.organizationId, locationId: location.value.id, ...(placeId ? { placeId } : {}) },
      validate: isSuccess,
    })
    searching.value = false
    confirmingReimport.value = false
    await integrations.refresh()
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Google Maps import failed.')
    confirmingReimport.value = false
  } finally {
    saving.value = false
  }
}

const connect = (place: OnboardingPlacePreview) => importPlace(place.placeId)
const reimport = () => importPlace()
</script>
