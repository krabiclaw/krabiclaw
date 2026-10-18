<template>
  <DashboardLeafPanel
    id="product-photo-visual-description"
    title="Visual description"
    lead="Describe what’s in this photo for guests using a screen reader."
    :saving="p.saving.value"
    :disabled="!photo || !changed || draft.length > 500 || Boolean(p.loadError.value)"
    :error="p.loadError.value || p.photoError.value || ''"
    desktop-cancel
    @cancel="revert"
    @save="save"
  >
    <template v-if="photo">
      <img v-if="mediaStillUrl(photo)" :src="mediaStillUrl(photo) || undefined" :alt="photo.alt_text || ''" class="mb-6 max-h-60 w-full rounded-xl bg-elevated object-contain">
      <UFormField label="Visual description" :hint="`${500 - draft.length} characters available`">
        <UTextarea v-model="draft" aria-label="Visual description" :rows="6" :maxlength="500" :disabled="p.saving.value" autofocus class="w-full" />
      </UFormField>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { isNavigationFailure } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const photoId = computed(() => String(route.params.photoId ?? ''))
const photo = computed(() => p.photoAssets.value.find(asset => asset.asset_id === photoId.value) ?? null)
const draft = ref('')
const changed = computed(() => draft.value.trim() !== (photo.value?.alt_text ?? ''))

function revert() {
  draft.value = photo.value?.alt_text ?? ''
  p.photoError.value = null
}

watch(photo, () => { if (!p.saving.value) revert() }, { immediate: true })

async function save() {
  if (!photo.value || !changed.value || draft.value.length > 500) return
  if (!await p.describeStayPhoto(photoId.value, draft.value)) return
  try {
    const result = await navigateTo(level.to.value!)
    if (isNavigationFailure(result)) throw result
  } catch (error) {
    p.photoError.value = getErrorMessage(error, 'The visual description was saved, but the photo could not be opened')
  }
}
</script>
