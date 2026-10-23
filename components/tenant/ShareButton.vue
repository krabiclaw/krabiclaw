<template>
  <!-- Airbnb's Share: the device's own share sheet, or the link copied where there is none. -->
  <button v-bind="$attrs" type="button" class="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-semibold text-default underline underline-offset-4 hover:bg-muted" @click="share">
    <TenantIcon name="share" class="size-4" />
    {{ copied ? t('site.experience_detail.link_copied') : t('site.experience_detail.share') }}
  </button>
  <p v-if="errorMessage" role="alert" class="text-sm text-error">{{ errorMessage }}</p>
</template>
<script setup lang="ts">
import { getErrorMessage } from '~/utils/errors'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ title: string; url: string }>()
const { t } = useI18n()
const copied = ref(false)
const errorMessage = ref('')
async function share() {
  errorMessage.value = ''
  try {
    const url = new URL(props.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.searchParams.has('preview_token')) throw new Error('A public page URL is required to share this page.')
    if (navigator.share) {
      await navigator.share({ title: props.title, url: url.toString() })
      return
    }
    await navigator.clipboard.writeText(url.toString())
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch (cause) {
    // Closing the device's share sheet leaves the page as it was.
    if (cause instanceof DOMException && cause.name === 'AbortError') return
    errorMessage.value = getErrorMessage(cause, 'This page could not be shared.')
  }
}
</script>
