<template>
  <div class="space-y-6">
    <!-- The cover, then the rest a guest swipes through. -->
    <template v-if="organizationId">
      <UFormField label="Photos and video">
        <DashboardCoverPhotoField
          :organization-id="organizationId"
          :model-value="coverMediaId"
          :preview-url="coverPreviewUrl"
          preview-alt="Post photo"
          accept="any"
          title="Select post media"
          empty-label="Add a photo or video"
          @update:model-value="coverMediaId = $event"
          @change="setCover"
        />
      </UFormField>

      <UFormField label="More photos and videos">
        <DashboardMediaGalleryField
          :items="galleryItems"
          :organization-id="organizationId"
          :cover-first="false"
          @remove="(index: number) => removeGalleryItem(index)"
          @move="(index: number, direction: -1 | 1) => moveGalleryItem(index, direction)"
          @reorder="(from: number, to: number) => reorderGalleryItem(from, to)"
          @asset-change="(index: number, asset) => setGalleryAsset(index, asset)"
        >
          <template #add>
            <MediaPicker :organization-id="organizationId" accept="any" title="Select post media" @change="addGalleryAsset">
              <UButton as="span" color="neutral" variant="soft" icon="i-lucide-plus" label="Add media" />
            </MediaPicker>
          </template>
        </DashboardMediaGalleryField>
      </UFormField>
    </template>
  </div>
</template>

<script setup lang="ts">
import DashboardCoverPhotoField from '~/components/dashboard/DashboardCoverPhotoField.vue'
import DashboardMediaGalleryField from '~/components/dashboard/DashboardMediaGalleryField.vue'
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import { mediaStillUrl } from '~/shared/media-placement-contract'

const media = defineModel<PostMediaItem[]>('media', { default: () => [] })

withDefaults(defineProps<{
  organizationId?: string
  /** An alert's contract shape rejects media outright, so the fields are absent. */
}>(), { organizationId: '' })

const coverMedia = computed(() => media.value.find(item => item.slot === 'cover') ?? null)
const coverMediaId = computed({
  get: () => coverMedia.value?.asset_id ?? null,
  set: (assetId: string | null) => {
    if (assetId) return
    media.value = media.value.filter(item => item.slot !== 'cover')
  },
})
const coverPreviewUrl = computed(() => coverMedia.value ? mediaStillUrl(coverMedia.value) : null)

const galleryMedia = computed({
  get: () => media.value.filter(item => item.slot === 'gallery'),
  set: (items: PostMediaItem[]) => {
    media.value = [
      ...media.value.filter(item => item.slot !== 'gallery'),
      ...items.map(item => ({ ...item, slot: 'gallery' as const })),
    ]
  },
})

// The shared gallery field keys rows by a stable `_key`; gallery membership here
// is keyed by asset, and a freshly added empty row has no asset yet.
const galleryItems = computed(() => galleryMedia.value.map((item, index) => ({
  _key: item.asset_id || `gallery-${index}`,
  asset_id: item.asset_id || null,
  url: item.public_url ?? null,
  thumbnail_url: item.thumbnail_url ?? null,
  kind: item.kind ?? 'image',
})))

type MediaAsset = { asset_id: string; public_url: string | null; thumbnail_url: string | null; kind?: string | null }

function setCover(asset: MediaAsset | null) {
  media.value = [
    ...(asset
      ? [{
          asset_id: asset.asset_id,
          slot: 'cover' as const,
          alt_text: '',
          public_url: asset.public_url,
          thumbnail_url: asset.thumbnail_url,
          kind: asset.kind ?? 'image',
        }]
      : []),
    ...media.value.filter(item => item.slot !== 'cover'),
  ]
}

function addGalleryAsset(asset: MediaAsset | null) {
  if (!asset) return
  galleryMedia.value = [...galleryMedia.value, { ...asset, slot: 'gallery', alt_text: '' }]
}

function removeGalleryItem(index: number) {
  galleryMedia.value = galleryMedia.value.filter((_, itemIndex) => itemIndex !== index)
}

function moveGalleryItem(index: number, direction: -1 | 1) {
  reorderGalleryItem(index, index + direction)
}

function reorderGalleryItem(sourceIndex: number, targetIndex: number) {
  const items = [...galleryMedia.value]
  if (targetIndex < 0 || targetIndex >= items.length) return
  const [item] = items.splice(sourceIndex, 1)
  if (!item) return
  items.splice(targetIndex, 0, item)
  galleryMedia.value = items
}

function setGalleryAsset(index: number, asset: MediaAsset | null) {
  const items = [...galleryMedia.value]
  const existing = items[index]
  if (!existing) return
  items[index] = {
    ...existing,
    asset_id: asset?.asset_id ?? '',
    public_url: asset?.public_url ?? null,
    thumbnail_url: asset?.thumbnail_url ?? null,
    kind: asset?.kind ?? 'image',
  }
  galleryMedia.value = items
}
</script>

<script lang="ts">
// Declared in a plain block so the model type above resolves before the setup
// block is compiled, the way DashboardListEditor declares its row type.
export interface PostMediaItem {
  asset_id: string
  slot: 'cover' | 'gallery'
  alt_text: string
  public_url?: string | null
  thumbnail_url?: string | null
  kind?: string | null
}
</script>
