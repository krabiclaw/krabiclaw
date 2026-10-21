<template>
  <ul class="space-y-3 text-sm text-muted">
    <li v-for="feature in features" :key="feature.id" class="flex items-start gap-3">
      <UIcon :name="feature.icon" class="size-5 shrink-0" aria-hidden="true" />
      <div class="min-w-0">
        <p>{{ feature.label }}</p>
        <p v-if="feature.description" class="mt-1 leading-relaxed">{{ feature.description }}</p>
        <div v-if="feature.asset_ids?.length" class="mt-3 flex flex-wrap gap-2">
          <button v-for="(assetId, position) in feature.asset_ids" :key="assetId" type="button" class="w-24 overflow-hidden rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4" :aria-label="t('stay.open_accessibility_photo', { feature: feature.label, number: position + 1 })" @click="$emit('open-photo', assetId)">
            <img :src="photoUrl(assetId)" alt="" class="aspect-4/3 w-full object-cover transition hover:brightness-95" loading="lazy">
          </button>
        </div>
      </div>
    </li>
  </ul>
</template>

<script setup lang="ts">
import type { MediaGalleryGroup } from '~/components/MediaLightbox.vue'
const props = defineProps<{ features: NonNullable<MediaGalleryGroup['features']>; photos: ReadonlyArray<{ asset_id: string; url: string }> }>()
defineEmits<{ 'open-photo': [assetId: string] }>()
const { t } = useI18n()
function photoUrl(id: string): string {
  const photo = props.photos.find(photo => photo.asset_id === id)
  if (!photo) throw new TypeError('The accessibility evidence is not in this listing gallery')
  return photo.url
}
</script>
