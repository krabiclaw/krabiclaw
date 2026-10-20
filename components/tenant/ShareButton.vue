<template>
  <!-- Airbnb's Share: the device's own share sheet, or the link copied where there is none. -->
  <button type="button" class="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-semibold text-default underline underline-offset-4 hover:bg-muted" @click="share">
    <TenantIcon name="share" class="size-4" />
    {{ copied ? t('saya.experience_detail.link_copied') : t('saya.experience_detail.share') }}
  </button>
</template>
<script setup lang="ts">
const props = defineProps<{ title: string }>()
const { t } = useI18n()
const copied = ref(false)
async function share() {
  const url = window.location.href
  if (navigator.share) {
    // A guest closing the sheet is an answer, not a failure.
    await navigator.share({ title: props.title, url }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error
    })
    return
  }
  await navigator.clipboard.writeText(url)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>
