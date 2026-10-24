<template>
  <div>
    <UAlert v-if="selectionError" color="error" variant="soft" :description="selectionError" class="mb-3" />
    <p v-if="incompatibleContent" class="mb-3 text-sm text-warning">Send text and photos to Airbnb separately. Remove the text or photo before sending.</p>
    <UChatPrompt v-model="body" :autofocus="false" :placeholder="placeholder" :aria-label="placeholder" color="neutral" :disabled="disabled || sending" :rows="2" :maxrows="8" class="gap-2 rounded-2xl px-5 pb-2.5 pt-4" :ui="{ header: 'flex-wrap gap-2 pb-1', base: 'px-0 py-0 text-base/6 sm:text-base/6', footer: 'items-center' }" @submit="submit" @paste="paste">
      <template v-if="photos.length" #header>
        <div v-for="(photo, at) in photos" :key="photo.url" class="relative">
          <img :src="photo.url" :alt="photo.file.name" class="size-16 rounded-xl object-cover">
          <UButton icon="i-lucide-x" color="neutral" variant="solid" size="xs" square class="absolute -right-1.5 -top-1.5 rounded-full ring-2 ring-default" :aria-label="`Remove ${photo.file.name}`" :disabled="sending" @click="remove(at)" />
        </div>
      </template>
      <template #footer>
        <UFileUpload :model-value="[]" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple reset :dropzone="false" :interactive="false" :preview="false" :disabled="disabled || sending || photos.length >= maxPhotos" @update:model-value="add($event ?? [])">
          <template #default="{ open }"><UButton icon="i-lucide-image" color="neutral" variant="ghost" square class="-ms-1.5 size-9 justify-center rounded-full p-0" :ui="{ leadingIcon: 'size-6' }" aria-label="Add photos" :disabled="disabled || sending || photos.length >= maxPhotos" @click="open()" /></template>
        </UFileUpload>
        <!-- Nuxt UI owns keyboard/IME submission; this explicit button also sends a photo with no text. -->
        <UButton type="button" icon="i-lucide-arrow-up" color="neutral" variant="solid" square class="size-8 justify-center rounded-full p-0 transition duration-200 active:scale-90 disabled:bg-elevated disabled:text-dimmed disabled:opacity-100" :ui="{ leadingIcon: 'size-4' }" :aria-label="sendLabel" :title="sendLabel" :loading="sending" :disabled="disabled || sending || incompatibleContent || (!body.trim() && !photos.length)" @click="submit" />
      </template>
    </UChatPrompt>
  </div>
</template>
<script lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
export interface MessagePhotoDraft { file: File; url: string }
/** Preview lifetime follows the conversation draft, including when a failed read hides its composer. */
export function useMessagePhotoDraft() {
  const photos = ref<MessagePhotoDraft[]>([])
  watch(photos, (current, previous) => {
    const retained = new Set(current.map(photo => photo.url))
    for (const photo of previous) if (!retained.has(photo.url)) URL.revokeObjectURL(photo.url)
  }, { flush: 'sync' })
  onBeforeUnmount(() => { for (const photo of photos.value) URL.revokeObjectURL(photo.url) })
  return photos
}
export function messageReplyForm(body: string, photos: MessagePhotoDraft[], idempotencyKey: string) {
  const form = new FormData()
  form.set('body', body)
  form.set('idempotencyKey', idempotencyKey)
  for (const photo of photos) form.append('photos', photo.file, photo.file.name)
  return form
}
export function sameMessagePhotos(left: MessagePhotoDraft[], right: MessagePhotoDraft[]) {
  return left.length === right.length && left.every((photo, at) => photo.file === right[at]?.file)
}
</script>
<script setup lang="ts">
const props = withDefaults(defineProps<{ disabled?: boolean; sending?: boolean; channel?: 'airbnb' | 'email' | 'team'; placeholder?: string; sendLabel?: string }>(), { disabled: false, sending: false, channel: 'email', placeholder: 'Write a message…', sendLabel: 'Send message' })
const emit = defineEmits<{ send: [] }>()
const body = defineModel<string>({ required: true })
const photos = defineModel<MessagePhotoDraft[]>('photos', { required: true })
const selectionError = ref('')
const maxPhotos = computed(() => props.channel === 'airbnb' ? 1 : 10)
const incompatibleContent = computed(() => props.channel === 'airbnb' && Boolean(body.value.trim()) && photos.value.length > 0)
const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
function add(files: File[]) {
  if (props.disabled || props.sending) return
  selectionError.value = ''
  const invalid = files.find(file => !acceptedTypes.has(file.type) || file.size > 10 * 1024 * 1024)
  if (invalid) { selectionError.value = `${invalid.name} must be a JPEG, PNG, WebP, GIF or AVIF photo up to 10 MB.`; return }
  if (files.length + photos.value.length > maxPhotos.value) { selectionError.value = props.channel === 'airbnb' ? 'Send one photo at a time to Airbnb.' : 'A message can carry at most 10 photos.'; return }
  photos.value = [...photos.value, ...files.map(file => ({ file, url: URL.createObjectURL(file) }))]
}
function paste(event: ClipboardEvent) { const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); add(files) } }
function remove(at: number) { photos.value = photos.value.filter((_photo, index) => index !== at); selectionError.value = '' }
function submit() { if (!props.disabled && !props.sending && !incompatibleContent.value && (body.value.trim() || photos.value.length)) emit('send') }
</script>
