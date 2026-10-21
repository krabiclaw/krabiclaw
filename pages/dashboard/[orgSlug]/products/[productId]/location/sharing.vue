<template>
  <DashboardLeafPanel
    id="location-sharing"
    title="Location sharing"
    :lead="sharedLead"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value && !(navigationError && !editor.dirty.value)"
    :error="[p.loadError.value, editor.editorError.value, navigationError].filter(Boolean).join(' ')"
    desktop-cancel
    @cancel="editor.revert"
    @save="save"
  >
    <UAlert v-if="editor.error.value" class="mb-6" color="error" variant="soft" :description="editor.error.value" />
    <template v-if="preview">
      <div class="flex items-start justify-between gap-6">
        <div>
          <h2 class="text-base font-semibold">Show your home's specific location</h2>
          <p id="location-sharing-description" class="mt-3 text-sm leading-6 text-muted">Show a precise pin on your public map. Your street address stays private in either setting. Guests receive your address after their reservation is confirmed.</p>
        </div>
        <USwitch v-model="specificLocation" aria-label="Show your home's specific location" aria-describedby="location-sharing-description" :disabled="editor.saving.value" class="mt-1 shrink-0" />
      </div>
      <figure class="mt-8 overflow-hidden rounded-xl border border-default">
        <iframe v-if="preview.map_embed_url" :src="preview.map_embed_url" :title="preview.public_area?.approximate ? 'General location preview' : 'Specific location preview'" class="h-72 w-full" referrerpolicy="strict-origin-when-cross-origin" />
        <p v-else class="p-6 text-sm text-muted">Add an address or map pin to preview the location guests will see.</p>
        <figcaption class="border-t border-default px-4 py-4 text-sm text-muted">{{ specificLocation && !preview.public_area?.center ? 'Add a map pin to show your home’s specific location. Until then, your listing shows the approximate area.' : preview.public_area?.approximate ? 'Your listing shows the approximate area. Your exact pin and street address stay private.' : 'Your listing shows a precise pin. Your street address stays private.' }}</figcaption>
      </figure>
    </template>
    <p v-else-if="!editor.error.value && !p.loadError.value" role="status" class="text-muted">Loading location…</p>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'
import { projectPublicLocation } from '~/shared/location-sharing'
import { parseStayMapSharing } from '~/shared/stay-listing'
import { isNavigationFailure } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const locationId = computed(() => p.product.value?.stay?.location_id ?? null)
const editor = await useLocationEditor(p.organizationId, locationId, 'stay-map-sharing')
const navigationError = ref('')
const sharedLead = computed(() => editor.location.value ? `Every place to stay at ${editor.location.value.title} uses this setting.` : undefined)
const specificLocation = computed({
  get: () => editor.detailsForm.stay_map_sharing === 'specific',
  set: (value: boolean) => { if (!editor.saving.value) editor.detailsForm.stay_map_sharing = value ? 'specific' : 'general' },
})
const preview = computed(() => editor.location.value && editor.detailsForm.stay_map_sharing !== null
  ? projectPublicLocation(editor.location.value, { is_stay_location: 1, stay_map_sharing: parseStayMapSharing(editor.detailsForm.stay_map_sharing) }) : null)

async function save() {
  if ((!navigationError.value || editor.dirty.value) && await editor.save() !== true) return
  navigationError.value = ''
  if (!level.to.value) return
  try {
    const result = await navigateTo(level.to.value)
    if (isNavigationFailure(result)) throw result
  } catch (error) {
    navigationError.value = getErrorMessage(error, 'The setting was saved, but the editor could not be closed.')
  }
}

watchEffect(() => {
  if (p.product.value && !p.loadError.value && p.product.value.kind !== 'stay') showNotFound()
})
</script>
