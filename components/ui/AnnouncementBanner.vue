<template>
  <aside
    v-if="visible"
    aria-label="Announcement"
    class="relative z-40 bg-action text-on-action"
  >
    <div class="mx-auto flex max-w-7xl items-center justify-between gap-x-4 px-4 py-2.5 sm:px-6 lg:px-8 text-sm">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p class="font-medium">
          <strong v-if="announcement?.headline" class="font-semibold">{{ announcement.headline }}</strong>
          <span v-if="announcement?.headline && announcement?.description" class="mx-1.5 opacity-75">·</span>
          <span v-if="announcement?.description" class="opacity-90">{{ announcement.description }}</span>
        </p>
        <a
          v-if="announcement?.cta_label && announcement?.cta_url"
          :href="announcement.cta_url"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 font-semibold underline underline-offset-4 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          @click="trackCtaClick"
        >
          {{ announcement.cta_label }}
          <svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.638L10.23 5.29a.75.75 0 1 1 1.04-1.08l5.5 5.25a.75.75 0 0 1 0 1.08l-5.5 5.25a.75.75 0 1 1-1.04-1.08l4.158-3.96H3.75A.75.75 0 0 1 3 10Z" clip-rule="evenodd" />
          </svg>
        </a>
      </div>

      <button
        v-if="announcement?.dismissible"
        type="button"
        class="-mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-lg p-1 text-on-action opacity-75 hover:opacity-100 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        aria-label="Dismiss announcement"
        @click="dismiss"
      >
        <svg class="size-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
        </svg>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { usePublicAnnouncement } from '~/composables/usePublicAnnouncement'

const route = useRoute()
const { trackAnnouncementView, trackAnnouncementCtaClick } = useOrganizationConversionTracking()

const dismissed = ref(false)
const { announcement, storageKey } = await usePublicAnnouncement()

const visible = computed(() => !!announcement.value && !dismissed.value && announcement.value.format === 'banner')

function dismiss() {
  if (announcement.value?.dismissible && storageKey.value) {
    try { localStorage.setItem(storageKey.value, '1') } catch { /* private browsing or blocked storage */ }
  }
  dismissed.value = true
}

function trackCtaClick() {
  trackAnnouncementCtaClick(route.path)
}

onMounted(() => {
  if (!announcement.value || !storageKey.value || announcement.value.format !== 'banner') return
  try {
    if (localStorage.getItem(storageKey.value) === '1') { dismissed.value = true; return }
  } catch { /* private browsing or blocked storage */ }
  trackAnnouncementView(route.path)
})
</script>
