<template>
  <div class="flex min-h-0 flex-col gap-3">
    <!-- Upload zone -->
    <div
      class="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-6 transition-colors"
      :class="isDragging ? 'border-primary bg-primary/5' : 'border-default hover:border-accented'"
      @dragenter.prevent="isDragging = true"
      @dragover.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
      @drop.prevent="onDrop"
    >
      <UIcon name="i-lucide-upload" class="size-6 text-muted" />
      <UButton size="sm" color="neutral" variant="outline" @click.stop="fileInput?.inputRef?.click()">+ Add files</UButton>
      <p class="text-xs text-muted">Drag and drop images or videos</p>
      <UInput
        ref="fileInput"
        type="file"
        :accept="computedAccept"
        class="hidden"
        @change="onFileSelect"
       />
    </div>

    <div v-if="uploading" class="flex items-center gap-2 text-xs font-medium text-default">
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
      <span>Uploading...</span>
    </div>

    <!-- Error -->
    <UAlert v-if="uploadError" color="error" variant="soft" :description="uploadError" icon="i-lucide-triangle-alert" />
    <UAlert v-if="mediaError" color="error" variant="soft" :description="getErrorMessage(mediaError, 'Failed to load media')" icon="i-lucide-triangle-alert" />

    <!-- Filters -->
    <div class="flex items-center gap-2">
      <USelect
        v-if="accept === 'any'"
        v-model="kindFilter"
        :items="kindOptions"
        value-key="value"
        label-key="label"
        size="sm"
        class="w-28"
      />
    </div>

    <!-- Grid -->
    <div v-if="media?.media.length === 0" class="py-10 text-center">
      <UIcon name="i-lucide-image" class="mx-auto size-8 text-muted" />
      <p class="mt-3 text-sm text-muted">No media yet. Upload your first file.</p>
    </div>

    <div v-else class="grid grid-cols-4 gap-2 sm:grid-cols-5 lg:grid-cols-6 overflow-y-auto max-h-80">
      <button
        v-for="asset in media?.media ?? []"
        :key="asset.id"
        type="button"
        class="group relative aspect-square overflow-hidden rounded-lg border-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        :class="selectedId === asset.id
          ? 'border-primary'
          : 'border-transparent hover:border-accented'"
        @click="emit('select', asset)"
      >
        <!-- Media thumbnail -->
        <UImage
          v-if="mediaStillUrl(asset)"
          :src="mediaStillUrl(asset)"
          :alt="asset.alt_text ?? ''"
          class="h-full w-full object-cover"
          loading="lazy"
        />
        <!-- Video / file placeholder -->
        <div v-else class="flex h-full w-full items-center justify-center bg-elevated">
          <video
            v-if="asset.kind === 'video' && asset.public_url"
            :src="asset.public_url"
            class="h-full w-full object-cover"
            muted
            playsinline
            preload="metadata"
          />
          <UIcon
            v-else
            :name="asset.kind === 'video' ? 'i-lucide-film' : 'i-lucide-file'"
            class="size-6 text-muted"
          />
        </div>

        <!-- Video overlay icon -->
        <div v-if="asset.kind === 'video'" class="absolute inset-0 flex items-center justify-center bg-black/10 pointer-events-none">
          <UIcon name="i-lucide-circle-play" class="size-8 text-white/70 shadow-sm" />
        </div>

        <!-- Selected overlay -->
        <div
          v-if="selectedId === asset.id"
          class="absolute inset-0 flex items-center justify-center bg-primary/20"
        >
          <div class="flex size-6 items-center justify-center rounded-full bg-primary">
            <UIcon name="i-lucide-check" class="size-3.5 text-white" />
          </div>
        </div>

        <!-- Hover filename -->
        <div class="absolute inset-x-0 bottom-0 translate-y-full bg-black/70 px-1.5 py-1 transition-transform group-hover:translate-y-0">
          <p class="truncate text-xs text-white">{{ asset.file_name || asset.kind }}</p>
        </div>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getErrorMessage } from '~/utils/errors'
import { mediaStillUrl } from '~/shared/media-placement-contract'
const dashboardApi = useDashboardApi()
const props = defineProps<{
  organizationId: string
  selectedId?: string | null
  accept?: 'image' | 'video' | 'any'
  locationId?: string | null
}>()

interface MediaAsset {
  id: string
  kind: 'image' | 'video' | 'file'
  provider: 'cloudflare_images' | 'cloudflare_r2' | 'static'
  file_size: number | null
  file_name?: string
  thumbnail_url?: string | null
  public_url?: string
  alt_text?: string
  title?: string
  description?: string
}

const isMediaAsset = (value: unknown): value is MediaAsset =>
  isRecord(value)
  && typeof value.id === 'string'
  && (value.kind === 'image' || value.kind === 'video' || value.kind === 'file')
  && (value.provider === 'cloudflare_images' || value.provider === 'cloudflare_r2' || value.provider === 'static')
  && (value.file_size === null || (typeof value.file_size === 'number' && Number.isSafeInteger(value.file_size) && value.file_size >= 0))
  && (value.public_url === undefined || typeof value.public_url === 'string')
  && (value.thumbnail_url === undefined || value.thumbnail_url === null || typeof value.thumbnail_url === 'string')

const isMediaResponse = (value: unknown): value is { media: MediaAsset[] } =>
  isRecord(value)
  && Array.isArray(value.media)
  && value.media.every(isMediaAsset)

const emit = defineEmits<{
  select: [asset: MediaAsset]
  uploaded: [asset: MediaAsset & { kind: 'image' | 'video'; provider: 'cloudflare_images' | 'cloudflare_r2'; file_size: number }]
}>()

const ALL_MEDIA_KIND = 'all'
const { uploading, error: mediaUploadError, upload: uploadMedia } = useMediaUpload(`/api/editor/organizations/${props.organizationId}`)

const uploadError = ref<string | null>(null)
const isDragging = ref(false)
const fileInput = ref<{ inputRef?: HTMLInputElement | null } | null>(null)
const kindFilter = ref(props.accept === 'video' ? 'video' : 'image')

const computedAccept = computed(() => {
  if (props.accept === 'video') return 'video/mp4,video/webm'
  if (props.accept === 'any') return 'image/*,video/mp4,video/webm'
  return 'image/*'
})

const kindOptions = [
  { label: 'Images', value: 'image' },
  { label: 'Videos', value: 'video' },
  { label: 'All', value: ALL_MEDIA_KIND },
]

function onDrop(e: DragEvent) {
  isDragging.value = false
  const file = e.dataTransfer?.files[0]
  if (file) void upload(file)
}

function onFileSelect(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) void upload(file)
  if (fileInput.value?.inputRef) fileInput.value.inputRef.value = ''
}

async function upload(file: File) {
  uploadError.value = null
  const isImage = file.type.startsWith('image/')
  const isVideo = file.type.startsWith('video/')
  const acceptedTypes = computedAccept.value.split(',').map(type => type.trim())
  const isAccepted = acceptedTypes.some(type => type.endsWith('/*')
    ? file.type.startsWith(type.slice(0, -1))
    : file.type === type
  )

  if (!isImage && !isVideo) {
    uploadError.value = 'Only images and videos are supported.'
    return
  }
  if (!isAccepted) {
    uploadError.value = props.accept === 'video'
      ? 'Only MP4 and WebM videos are supported.'
      : props.accept === 'image'
        ? 'Only image files are supported.'
        : 'Only images, MP4 videos, and WebM videos are supported.'
    return
  }

  let uploadedAssetId: string | null = null
  try {
    const result = await uploadMedia(file)
    if (!result) {
      uploadError.value = mediaUploadError.value ?? 'Upload failed.'
      return
    }

    uploadedAssetId = result.asset_id
    const saved = await dashboardApi<{ media: MediaAsset[] }>(
      `/api/editor/organizations/${props.organizationId}/media`,
      { query: { id: uploadedAssetId }, validate: isMediaResponse },
    )
    const asset = saved.media.find(entry => entry.id === uploadedAssetId)
    if (!asset || (asset.kind !== 'image' && asset.kind !== 'video') || asset.kind !== result.kind || asset.provider === 'static' || asset.file_size === null) {
      throw new Error('The uploaded file could not be read back with its saved metadata.')
    }
    await refresh()
    if (mediaError.value) throw mediaError.value
    emit('uploaded', { ...asset, kind: asset.kind, provider: asset.provider, file_size: asset.file_size })
  } catch (err) {
    uploadError.value = uploadedAssetId
      ? `The file was uploaded, but the media library could not be read. Close and reopen the picker to select it. ${getErrorMessage(err, 'Failed to load media.')}`
      : getErrorMessage(err, 'Upload failed.')
  }
}

// One request answers the grid for the selected kind; an upload refreshes it.
const { data: media, error: mediaError, refresh } = await useAsyncData(
  () => `dashboard-media-library:${props.organizationId}:${props.locationId ?? 'organization'}:${kindFilter.value}`,
  async () => {
    const params = new URLSearchParams({ limit: '100' })
    if (kindFilter.value !== ALL_MEDIA_KIND) params.set('kind', kindFilter.value)
    if (props.locationId) {
      params.set('ownerType', 'business_location')
      params.set('ownerId', props.locationId)
      params.set('slot', 'gallery')
    }
    return await dashboardApi<{ media: MediaAsset[] }>(
      `/api/editor/organizations/${props.organizationId}/media?${params}`,
      { validate: isMediaResponse },
    )
  },
)
</script>
