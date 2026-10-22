<template>
  <DashboardLeafPanel
    :id="panelId"
    :title="definition.label"
    :lead="definition.description"
    :saving="saving"
    :disabled="!answer || !changed || Boolean(loadError) || (available === true && photoIds.length === 0)"
    :error="loadError || error || localError"
    desktop-cancel
    @cancel="reset"
    @save="save"
  >
    <template #right>
      <UButton label="Clear details" color="neutral" variant="ghost" :disabled="saving || available === null" @click="choose(null)" />
    </template>
    <template v-if="answer">
      <p class="mb-6 text-sm text-muted">{{ contextLabel }}</p>
      <UButton label="Review photo guidelines" color="neutral" variant="link" class="mb-6 px-0 underline" :disabled="saving" @click="guidelinesOpen = true" />
      <p v-if="available === null" class="mb-4 text-sm text-muted" role="status">This feature hasn’t been specified.</p>
      <UButton v-if="error" label="Use saved details" color="neutral" variant="soft" :disabled="saving || Boolean(loadError)" class="mb-6" @click="reset" />
      <URadioGroup
        :model-value="available === null ? undefined : available ? 'yes' : 'no'"
        :items="[{ value: 'no', label: 'I don’t have this feature' }, { value: 'yes', label: 'I have this feature' }]"
        :disabled="saving"
        :aria-label="definition.label"
        variant="card"
        indicator="end"
        class="w-full"
        @update:model-value="choose($event === 'yes')"
      />
      <section v-if="available === true" class="mt-8">
        <h2 class="text-xl font-semibold text-highlighted">Add photos of this feature</h2>
        <ul class="my-5 list-disc space-y-3 pl-5 text-sm leading-relaxed text-muted"><li v-for="guideline in definition.guidelines" :key="guideline">{{ guideline }}</li></ul>
        <p class="mb-5 text-sm text-muted">Choose photos that show this feature. They will appear on your listing when you save.</p>
        <div v-if="photos.length" class="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <button
            v-for="(photo, index) in photos"
            :key="photo.asset_id"
            type="button"
            :aria-label="`Use photo ${index + 1} as evidence`"
            :aria-pressed="photoIds.includes(photo.asset_id)"
            :disabled="saving"
            class="relative aspect-square overflow-hidden rounded-xl border-2 focus-visible:outline-2 focus-visible:outline-offset-4"
            :class="photoIds.includes(photo.asset_id) ? 'border-highlighted' : 'border-transparent'"
            @click="togglePhoto(photo.asset_id)"
          >
            <img v-if="photo.url" :src="photo.url" :alt="photo.alt_text || ''" class="size-full object-cover">
            <span v-else class="flex size-full items-center justify-center bg-elevated"><UIcon name="i-lucide-image" class="size-8" /></span>
            <span class="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-default"><UIcon v-if="photoIds.includes(photo.asset_id)" name="i-lucide-check" class="size-4" /></span>
          </button>
        </div>
        <MediaPicker :organization-id="organizationId" accept="image" title="Add evidence photo" :disabled="saving" @change="selectPhoto">
          <span class="inline-flex h-10 items-center gap-2 rounded-full bg-elevated px-4 font-medium text-highlighted"><UIcon name="i-lucide-image-plus" class="size-4" />Add photos</span>
        </MediaPicker>
        <p v-if="!photoIds.length" class="mt-4 text-sm text-muted" role="status">Add at least one photo to save this feature.</p>
      </section>
    </template>
  </DashboardLeafPanel>
  <DashboardListItemDialog v-model:open="guidelinesOpen" title="Photo guidelines" save-label="Got it" @save="guidelinesOpen = false">
    <ul class="list-disc space-y-4 pl-5 text-base text-muted"><li v-for="guideline in definition.guidelines" :key="guideline">{{ guideline }}</li></ul>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import type { Product } from '~/server/types/products'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { isNavigationFailure } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'

type Answer = { available: boolean | null; photo_ids: string[] }
const props = defineProps<{
  panelId: string
  contextKey: string
  contextLabel: string
  organizationId: string
  definition: { label: string; description: string; guidelines: readonly string[] }
  answer: Answer | null
  snapshotToken: string | number | null
  photos: Product['gallery']
  saving: boolean
  loadError: string | null
  error: string | null
  closeTo?: string
  commit: (answer: Answer, token: string | number) => Promise<boolean>
}>()
const emit = defineEmits<{ 'reset-error': [] }>()
const available = ref<boolean | null>(null)
const photoIds = ref<string[]>([])
const original = ref<Answer | null>(null)
const token = ref<string | number | null>(null)
const guidelinesOpen = ref(false)
const localError = ref('')
const addedPhotos = ref<Array<{ asset_id: string; public_url: string | null; kind: string | null; alt_text: string }>>([])
const photos = computed(() => [
  ...props.photos.filter(photo => photo.kind === 'image').map(photo => ({ asset_id: photo.asset_id, url: mediaStillUrl(photo), alt_text: photo.alt_text })),
  ...addedPhotos.value.filter(photo => !props.photos.some(saved => saved.asset_id === photo.asset_id)).map(photo => ({ ...photo, url: photo.public_url })),
])
const changed = computed(() => original.value !== null && (available.value !== original.value.available || photoIds.value.length !== original.value.photo_ids.length || photoIds.value.some(id => !original.value!.photo_ids.includes(id))))
function choose(value: boolean | null) {
  available.value = value
  if (value !== true) photoIds.value = []
}
function togglePhoto(id: string) {
  if (props.saving) return
  photoIds.value = photoIds.value.includes(id) ? photoIds.value.filter(value => value !== id) : [...photoIds.value, id]
}
function selectPhoto(asset: { asset_id: string; public_url: string | null; kind: string | null; alt_text: string } | null) {
  if (!asset) return
  if (asset.kind !== 'image' || !asset.public_url) { localError.value = 'Choose an image that can be displayed.'; return }
  if (!addedPhotos.value.some(photo => photo.asset_id === asset.asset_id)) addedPhotos.value.push(asset)
  if (!photoIds.value.includes(asset.asset_id)) photoIds.value.push(asset.asset_id)
}
function reset() {
  if (!props.answer || props.snapshotToken === null) return
  original.value = { available: props.answer.available, photo_ids: [...props.answer.photo_ids] }
  available.value = original.value.available
  photoIds.value = [...original.value.photo_ids]
  token.value = props.snapshotToken
  addedPhotos.value = []
  localError.value = ''
  emit('reset-error')
}
watch(() => props.contextKey, () => { original.value = null; token.value = null; reset() }, { immediate: true })
watch(() => props.answer, () => { if (original.value === null) reset() })
async function save() {
  if (token.value === null || !changed.value || (available.value === true && photoIds.value.length === 0)) return
  localError.value = ''
  try {
    if (!await props.commit({ available: available.value, photo_ids: [...photoIds.value] }, token.value)) return
    await nextTick()
    reset()
    if (!props.closeTo) throw new Error('The accessibility details were saved, but their parent editor could not be found')
    const result = await navigateTo(props.closeTo)
    if (isNavigationFailure(result)) throw result
  } catch (error) {
    localError.value = getErrorMessage(error, 'The accessibility changes could not be completed')
  }
}
onBeforeRouteLeave(() => !props.saving)
onBeforeRouteUpdate(() => !props.saving)
</script>
