<template>
  <div class="space-y-5">
    <div v-if="photos.length" class="grid grid-cols-2 gap-4 sm:grid-cols-3">
      <div v-for="(photo, index) in photos" :key="photo.asset_id" class="relative overflow-hidden rounded-xl border border-default" :class="{ 'col-span-full': index === 0 }">
        <img :src="photo.public_url" :alt="photoLabel + ' ' + (index + 1)" class="w-full object-cover" :class="index === 0 ? 'aspect-[16/8]' : 'aspect-square'">
        <span v-if="index === 0 && limit > 1" class="absolute left-2 top-2 rounded-full bg-default px-3 py-1 text-xs font-semibold">Cover photo</span>
        <div class="absolute right-2 top-2 flex gap-2">
          <UButton v-if="index > 0" type="button" icon="i-lucide-arrow-left" color="neutral" variant="soft"
            :aria-label="'Move photo ' + (index + 1) + ' forward'" :disabled="disabled || uploading" @click="move(index)" />
          <UButton type="button" icon="i-lucide-x" color="neutral" variant="soft"
            :aria-label="'Remove photo ' + (index + 1)" :disabled="disabled || uploading" @click="photos = photos.filter((_, i) => i !== index)" />
        </div>
      </div>
    </div>
    <label v-if="photos.length < limit"
      class="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-default p-10 text-center focus-within:ring-2 focus-within:ring-primary"
      :class="{ 'min-h-80': !photos.length }" @dragover.prevent @drop.prevent="upload($event.dataTransfer?.files)">
      <UIcon name="i-lucide-images" class="size-8" aria-hidden="true" />
      <span class="font-semibold">{{ uploading ? 'Uploading photos…' : photos.length ? 'Add more photos' : 'Choose photos or drag them here' }}</span>
      <input type="file" accept="image/*" :multiple="limit > 1" class="sr-only" aria-label="Add photos" :disabled="disabled || uploading" @change="choose">
    </label>
    <UAlert v-if="error" color="error" variant="soft" :description="error" />
  </div>
</template>

<script setup lang="ts">
import { getErrorMessage } from '~/utils/errors'

const props = withDefaults(defineProps<{ limit: number; disabled?: boolean; photoLabel?: string }>(), { photoLabel: 'Photo' })
const photos = defineModel<{ asset_id: string; public_url: string }[]>({ required: true })
const uploading = defineModel<boolean>('uploading', { required: true })
const organizationId = useDashboardOrganizationId()
const uploader = useMediaUpload('/api/editor/organizations/' + encodeURIComponent(organizationId))
const error = ref('')

function move(index: number) {
  const reordered = [...photos.value]
  const [photo] = reordered.splice(index, 1)
  if (photo) reordered.splice(index - 1, 0, photo)
  photos.value = reordered
}

function choose(event: Event) {
  const input = event.target as HTMLInputElement
  void upload(input.files)
  input.value = ''
}

async function upload(files: FileList | null | undefined) {
  if (!files?.length || uploading.value || props.disabled) return
  const selected = Array.from(files)
  if (selected.length + photos.value.length > props.limit) {
    error.value = 'Choose up to ' + props.limit + (props.limit === 1 ? ' photo.' : ' photos.')
    return
  }
  if (selected.some(file => !file.type.startsWith('image/'))) {
    error.value = 'Choose image files.'
    return
  }
  error.value = ''
  uploading.value = true
  try {
    for (const file of selected) {
      const photo = await uploader.upload(file)
      if (!photo?.public_url) throw new Error(uploader.error.value ?? 'The photo could not be uploaded.')
      if (!photos.value.some(item => item.asset_id === photo.asset_id)) {
        photos.value = [...photos.value, { asset_id: photo.asset_id, public_url: photo.public_url }]
      }
    }
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not upload the photo.')
  } finally {
    uploading.value = false
  }
}
</script>
