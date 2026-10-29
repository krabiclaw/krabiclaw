<template>
  <div>
    <UAlert v-if="selectionError" color="error" variant="soft" :description="selectionError" class="mb-3" />
    <p v-if="incompatibleContent" class="mb-3 text-sm text-warning">Send text and photos to Airbnb separately. Remove the text or photo before sending.</p>
    <p v-if="sendAt && photos.length" class="mb-3 text-sm text-warning">Send later carries text only. Remove the photo, or send it now.</p>
    <UChatPrompt v-model="body" :autofocus="false" :placeholder="offeredSuggestion ?? (sendAt ? 'Send later' : placeholder)" :aria-label="placeholder" color="neutral" :disabled="disabled || sending" :rows="2" :maxrows="8" class="gap-2 rounded-2xl px-5 pb-2.5 pt-4" :ui="{ header: 'flex-wrap gap-2 pb-1', base: 'px-0 py-0 text-base/6 sm:text-base/6', footer: 'items-center' }" @submit="submit" @paste="paste" @keydown.tab="acceptWithTab">
      <template v-if="photos.length || sendAt" #header>
        <!-- A message set to send later carries its time above the words, the way Messages does. -->
        <div v-if="sendAt" class="flex w-full items-center gap-2 rounded-xl border border-dashed border-primary px-3 py-1.5 text-sm text-primary">
          <UIcon name="i-lucide-clock" class="size-4 shrink-0" />
          <span class="flex-1">{{ sendAtLabel }}</span>
          <UButton icon="i-lucide-x" color="primary" variant="ghost" size="xs" square aria-label="Send now instead" :disabled="sending" @click="sendAt = null" />
        </div>
        <div v-for="(photo, at) in photos" :key="photo.url" class="relative">
          <img :src="photo.url" :alt="photo.file.name" class="size-16 rounded-xl object-cover">
          <UButton icon="i-lucide-x" color="neutral" variant="solid" size="xs" square class="absolute -right-1.5 -top-1.5 rounded-full ring-2 ring-default" :aria-label="`Remove ${photo.file.name}`" :disabled="sending" @click="remove(at)" />
        </div>
      </template>
      <template #footer>
        <!-- "+" adds something to this message: photos, or a time to send it. -->
        <UFileUpload :model-value="[]" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple reset :dropzone="false" :interactive="false" :preview="false" :disabled="disabled || sending" @update:model-value="add($event ?? [])">
          <template #default="{ open }">
            <UDropdownMenu :items="addItems(open)" :content="{ side: 'top', align: 'start' }">
              <UButton icon="i-lucide-plus" color="neutral" variant="ghost" square class="-ms-1.5 size-9 justify-center rounded-full p-0" :ui="{ leadingIcon: 'size-6' }" aria-label="Add to message" :disabled="disabled || sending" />
            </UDropdownMenu>
          </template>
        </UFileUpload>
        <UButton v-if="offeredSuggestion" label="Use" color="neutral" variant="soft" size="sm" class="ms-auto rounded-full" aria-label="Use suggested reply" @click="body = offeredSuggestion" />
        <!-- Nuxt UI owns keyboard/IME submission; this explicit button also sends a photo with no text. -->
        <UButton type="button" icon="i-lucide-arrow-up" color="neutral" variant="solid" square class="size-8 justify-center rounded-full p-0 transition duration-200 active:scale-90 disabled:bg-elevated disabled:text-dimmed disabled:opacity-100" :ui="{ leadingIcon: 'size-4' }" :aria-label="sendLabel" :title="sendLabel" :loading="sending" :disabled="disabled || sending || incompatibleContent || (sendAt !== null && photos.length > 0) || (!body.trim() && !photos.length)" @click="submit" />
      </template>
    </UChatPrompt>
    <UModal v-model:open="scheduling" title="Send later" description="Choose when this message is sent.">
      <template #body>
        <UForm :state="{ when }" class="space-y-4" @submit="schedule">
          <UFormField label="Date and time" :error="scheduleError || undefined"><UInput v-model="when" type="datetime-local" :min="earliest" class="w-full" /></UFormField>
          <UButton type="submit" label="Done" color="neutral" block />
        </UForm>
      </template>
    </UModal>
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
import type { DropdownMenuItem } from '@nuxt/ui'
const props = withDefaults(defineProps<{ disabled?: boolean; sending?: boolean; channel?: 'airbnb' | 'email' | 'team'; placeholder?: string; sendLabel?: string; suggestion?: string | null; sendLater?: boolean }>(), { disabled: false, sending: false, channel: 'email', placeholder: 'Write a message…', sendLabel: 'Send message', suggestion: null, sendLater: false })
const emit = defineEmits<{ send: [] }>()
const body = defineModel<string>({ required: true })
const photos = defineModel<MessagePhotoDraft[]>('photos', { required: true })
/** When the message is sent later: an ISO instant, or null to send now. */
const sendAt = defineModel<string | null>('sendAt', { default: null })
const { locale } = useI18n()

// A suggested reply is the field's placeholder until Use or Tab puts it in the field.
const offeredSuggestion = computed(() => !body.value && !photos.value.length && !sendAt.value && props.suggestion ? props.suggestion : null)
function acceptWithTab(event: KeyboardEvent) {
  if (!offeredSuggestion.value) return
  event.preventDefault()
  body.value = offeredSuggestion.value
}

const scheduling = ref(false)
const when = ref('')
const scheduleError = ref('')
const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const earliest = computed(() => localInput(new Date(Date.now() + 60_000)))
const sendAtLabel = computed(() => sendAt.value ? new Intl.DateTimeFormat(locale.value, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(sendAt.value)) : '')
function addItems(open: () => void): DropdownMenuItem[] {
  return [
    { label: 'Photos', icon: 'i-lucide-image', disabled: photos.value.length >= maxPhotos.value || Boolean(sendAt.value), onSelect: open },
    ...(props.sendLater ? [{ label: 'Send later', icon: 'i-lucide-clock', onSelect: () => { when.value = sendAt.value ? localInput(new Date(sendAt.value)) : localInput(new Date(Date.now() + 3_600_000)); scheduleError.value = ''; scheduling.value = true } }] : []),
  ]
}
function schedule() {
  const instant = new Date(when.value)
  if (!when.value || Number.isNaN(instant.getTime()) || instant.getTime() <= Date.now()) { scheduleError.value = 'Choose a time in the future.'; return }
  sendAt.value = instant.toISOString()
  scheduling.value = false
}
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
function submit() { if (!props.disabled && !props.sending && !incompatibleContent.value && !(sendAt.value && photos.value.length) && (body.value.trim() || photos.value.length)) emit('send') }
</script>
