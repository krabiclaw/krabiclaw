<template>
  <!-- Trigger -->
  <div
    @click="open"
    @keydown.enter.prevent="open"
    @keydown.space.prevent="open"
    class="text-left"
    :class="disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'"
    role="button"
    :aria-disabled="disabled"
    :tabindex="disabled ? -1 : 0"
  >
    <slot>
      <div
        class="group flex items-center gap-2 overflow-hidden rounded-lg border border-default transition-colors hover:border-accented"
        :class="modelValue ? 'p-1' : 'p-2'"
      >
        <UImage
          v-if="selectedUrl"
          :src="selectedUrl"
          class="size-10 shrink-0 rounded object-cover"
          :alt="selectedAlt"
        />
        <div
          v-else
          class="flex size-10 shrink-0 items-center justify-center rounded bg-elevated"
        >
          <UIcon
            :name="accept === 'video' ? 'i-lucide-film' : 'i-lucide-image'"
            class="size-4 text-muted"
          />
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-xs font-medium text-default">
            {{ selectedUrl ? (selectedAlt || 'Media selected') : 'Select media' }}
          </p>
          <p class="text-xs text-muted">{{ selectedUrl ? 'Click to change' : 'Click to browse' }}</p>
        </div>
        <UButton
          v-if="modelValue"
          icon="i-lucide-x"
          size="xs"
          color="neutral"
          variant="ghost"
          class="shrink-0"
          @click.stop="clear"
        />
      </div>
    </slot>
  </div>
  <UAlert
    v-if="modelLoadError"
    color="error"
    variant="soft"
    :description="modelLoadError"
    class="mt-2"
  />

  <!-- Modal -->
  <UModal
    v-model:open="isOpen"
    :title="title"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <MediaLibraryGrid
        :organization-id="organizationId"
        :selected-id="pendingAsset?.asset_id ?? modelValue"
        :accept="accept"
        :location-id="locationId"
        @select="onSelect"
        @uploaded="onUploaded"
      />
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="isOpen = false">Cancel</UButton>
        <UButton :disabled="!pendingAsset" @click="confirm">Done</UButton>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { mediaStillUrl } from '~/shared/media-placement-contract'
const dashboardApi = useDashboardApi()
const props = defineProps<{
  organizationId: string
  modelValue?: string | null
  /**
   * What the caller already knows about `modelValue`'s asset. A page block owns
   * its media placements and the page response carries their URLs and alt text
   * with them, so a populated picker inside one has no reason to ask the server
   * again — twenty gallery images used to mean twenty metadata requests on
   * mount. When this describes `modelValue`, it is rendered as-is and nothing
   * is fetched. A caller holding only an id omits it and keeps the single
   * bounded load below.
   */
  selectedSummary?: MediaSummary | null
  accept?: 'image' | 'video' | 'any'
  locationId?: string | null
  title?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [assetId: string | null]
  change: [asset: SelectedMediaAsset | null]
}>()

const { trackImageUploaded, trackVideoUploaded, trackMediaLibraryViewed } = useAnalytics()

interface PickerMediaAsset {
  id: string
  kind?: string | null
  public_url?: string | null
  thumbnail_url?: string | null
  alt_text?: string | null
  file_name?: string | null
  provider: 'cloudflare_images' | 'cloudflare_r2' | 'static'
  file_size: number | null
}

interface SelectedMediaAsset {
  asset_id: string
  public_url: string | null
  thumbnail_url: string | null
  kind: string | null
  alt_text: string
}

/** The fields the picker renders. Anything holding these can answer for an asset. */
export interface MediaSummary {
  asset_id: string
  public_url?: string | null
  thumbnail_url?: string | null
  kind?: string | null
  alt_text?: string | null
  file_name?: string | null
}

/** What is on screen, and which asset it belongs to. */
interface ResolvedSelection {
  asset_id: string
  url: string | null
  alt: string
}

const isPickerMediaResponse = (value: unknown): value is { media: PickerMediaAsset[] } =>
  isRecord(value)
  && Array.isArray(value.media)
  && value.media.every(asset =>
    isRecord(asset)
    && typeof asset.id === 'string'
    && (asset.provider === 'cloudflare_images' || asset.provider === 'cloudflare_r2' || asset.provider === 'static')
    && (asset.file_size === null || (typeof asset.file_size === 'number' && Number.isSafeInteger(asset.file_size) && asset.file_size >= 0))
    && (asset.kind === undefined || asset.kind === null || typeof asset.kind === 'string')
    && (asset.public_url === undefined || asset.public_url === null || typeof asset.public_url === 'string')
    && (asset.thumbnail_url === undefined || asset.thumbnail_url === null || typeof asset.thumbnail_url === 'string')
    && (asset.alt_text === undefined || asset.alt_text === null || typeof asset.alt_text === 'string')
    && (asset.file_name === undefined || asset.file_name === null || typeof asset.file_name === 'string'),
  )

const isOpen = ref(false)
const pendingAsset = ref<SelectedMediaAsset | null>(null)

// One record of what is displayed, tagged with the asset it describes. Tracking
// the url and the alt text on their own could not say which asset they were
// for, so a confirmed selection was indistinguishable from stale state and the
// watcher re-fetched the asset the picker had just been handed.
const resolved = ref<ResolvedSelection | null>(null)
const selectedUrl = computed(() => resolved.value?.url ?? null)
const selectedAlt = computed(() => resolved.value?.alt ?? '')
const modelLoadController = ref<AbortController | null>(null)
const modelLoadError = ref<string | null>(null)

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function assetAlt(asset: Pick<PickerMediaAsset, 'alt_text' | 'file_name'> | Pick<SelectedMediaAsset, 'alt_text'>): string {
  if ('alt_text' in asset && typeof asset.alt_text === 'string' && asset.alt_text) return asset.alt_text
  return 'file_name' in asset && typeof asset.file_name === 'string' ? asset.file_name : ''
}

function summaryFor(id: string): ResolvedSelection | null {
  const summary = props.selectedSummary
  if (!summary || summary.asset_id !== id) return null
  const url = mediaStillUrl(summary)
  // A summary with no URL does not describe the asset, so it cannot stand in
  // for loading it. Accepting one left the picker on its placeholder icon
  // forever, because taking this branch is what stops the fetch below.
  if (!url) return null
  return { asset_id: id, url, alt: assetAlt(summary) }
}

watch([() => props.modelValue, () => props.selectedSummary], async ([id]) => {
  if (!id) {
    modelLoadController.value?.abort()
    resolved.value = null
    modelLoadError.value = null
    return
  }

  // Already showing this asset — from a summary, an earlier load, or the
  // selection the owner just confirmed. Nothing to fetch.
  if (resolved.value?.asset_id === id) return

  const supplied = summaryFor(id)
  if (supplied) {
    modelLoadController.value?.abort()
    resolved.value = supplied
    modelLoadError.value = null
    return
  }

  // An id nobody described. Drop what is on screen before loading it, so the
  // previous asset's thumbnail is never shown against the new id.
  modelLoadController.value?.abort()
  resolved.value = null

  const controller = new AbortController()
  modelLoadController.value = controller
  modelLoadError.value = null

  try {
    const res = await dashboardApi<{ media: PickerMediaAsset[] }>(
      `/api/editor/organizations/${props.organizationId}/media?id=${encodeURIComponent(id)}&limit=1`,
      { signal: controller.signal, validate: isPickerMediaResponse },
    )

    if (controller.signal.aborted) return

    const asset = (res.media ?? [])[0]
    resolved.value = asset
      ? { asset_id: id, url: mediaStillUrl(asset), alt: assetAlt(asset) }
      : null
  } catch (err) {
    if (controller.signal.aborted || isAbortError(err)) return
    modelLoadError.value = getErrorMessage(err, 'Failed to load the selected media')
  } finally {
    if (modelLoadController.value === controller) {
      modelLoadController.value = null
    }
  }
}, { immediate: true })

onUnmounted(() => {
  modelLoadController.value?.abort()
})

function open() {
  if (props.disabled) return
  pendingAsset.value = null
  isOpen.value = true
  trackMediaLibraryViewed(props.organizationId)
}

function onSelect(asset: PickerMediaAsset) {
  pendingAsset.value = {
    asset_id: asset.id,
    public_url: asset.public_url ?? null,
    thumbnail_url: asset.thumbnail_url ?? null,
    kind: asset.kind ?? null,
    alt_text: assetAlt(asset),
  }
}

function onUploaded(asset: PickerMediaAsset & { kind: 'image' | 'video'; provider: 'cloudflare_images' | 'cloudflare_r2'; file_size: number }) {
  // The upload answered with the asset it created, and that asset knows what
  // it is. Reading the kind back off the URL's extension invented a second
  // answer that could disagree with the row.
  const kind = asset.kind
  pendingAsset.value = {
    asset_id: asset.id,
    public_url: asset.public_url ?? null,
    thumbnail_url: asset.thumbnail_url ?? null,
    kind,
    alt_text: assetAlt(asset),
  }
  if (kind === 'image') {
    trackImageUploaded(props.organizationId, asset.file_size, asset.provider)
  } else {
    trackVideoUploaded(props.organizationId, asset.file_size, asset.provider)
  }
}

function confirm() {
  const asset = pendingAsset.value
  if (!asset) return
  // The library already handed over this asset's metadata. Recording it against
  // its id is what stops the modelValue change below from fetching the very
  // asset the owner just picked.
  resolved.value = {
    asset_id: asset.asset_id,
    url: mediaStillUrl(asset),
    alt: assetAlt(asset),
  }
  modelLoadError.value = null
  emit('update:modelValue', asset.asset_id)
  emit('change', asset)
  isOpen.value = false
}

function clear() {
  resolved.value = null
  modelLoadError.value = null
  pendingAsset.value = null
  emit('update:modelValue', null)
  emit('change', null)
}

defineExpose({ open })
</script>
