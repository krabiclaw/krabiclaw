<template>
  <UModal :open="viewer !== null" :title="viewer ? `Photo ${viewer.at + 1} of ${viewer.photos.length}` : ''" :ui="{ content: 'max-w-4xl bg-transparent shadow-none ring-0', header: 'sr-only', body: 'p-0 sm:p-0' }" @update:open="open => { if (!open) viewer = null }">
    <template #body>
      <div v-if="viewer" class="relative flex items-center justify-center">
        <Transition mode="out-in" enter-from-class="opacity-0 scale-[0.98]" enter-active-class="transition duration-200 ease-out motion-reduce:transition-none" leave-to-class="opacity-0" leave-active-class="transition duration-100">
          <img :key="viewer.photos[viewer.at]!.url" :src="viewer.photos[viewer.at]!.url" :alt="viewer.photos[viewer.at]!.alt ?? ''" class="max-h-[85vh] w-auto rounded-2xl object-contain">
        </Transition>
        <template v-if="viewer.photos.length > 1">
          <UButton icon="i-lucide-chevron-left" color="neutral" variant="solid" square class="absolute left-3 rounded-full" aria-label="Previous photo" @click="viewer.at = (viewer.at + viewer.photos.length - 1) % viewer.photos.length" />
          <UButton icon="i-lucide-chevron-right" color="neutral" variant="solid" square class="absolute right-3 rounded-full" aria-label="Next photo" @click="viewer.at = (viewer.at + 1) % viewer.photos.length" />
        </template>
      </div>
    </template>
  </UModal>
</template>
<script lang="ts">
export interface MessagePhotoViewerState { photos: Array<{ url: string; alt?: string | null }>; at: number }
</script>
<script setup lang="ts">
const viewer = defineModel<MessagePhotoViewerState | null>({ required: true })
</script>
