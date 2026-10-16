<template>
  <template v-if="visible">
    <Transition
      appear
      enter-active-class="transition-opacity duration-300 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-200 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div class="fixed inset-0 z-[60] bg-black/50" />
    </Transition>
    <Transition
      appear
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="opacity-0 translate-y-4 scale-95"
      enter-to-class="opacity-100 translate-y-0 scale-100"
      leave-active-class="transition duration-200 ease-in"
      leave-from-class="opacity-100 translate-y-0 scale-100"
      leave-to-class="opacity-0 translate-y-4 scale-95"
    >
      <div
        role="dialog"
        aria-modal="true"
        :aria-label="announcement?.headline"
        class="fixed inset-0 z-[60] flex items-center justify-center p-4"
        @click="dismiss"
      >
        <div class="relative w-full max-w-sm" @click.stop>
          <button
            type="button"
            class="absolute -right-3 -top-3 z-10 flex size-8 items-center justify-center rounded-full bg-elevated text-muted shadow-lg ring-1 ring-default hover:bg-muted hover:text-highlighted"
            aria-label="Close"
            @click="dismiss"
          >
            <svg class="size-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M5.22 5.22a.75.75 0 0 1 1.06 0L10 8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L8.94 10 5.22 6.28a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
          <div class="overflow-hidden rounded-2xl bg-elevated shadow-xl">
            <img
              v-if="announcement?.image_url"
              :src="announcement.image_url"
              alt=""
              class="h-48 w-full object-cover"
            >
            <div class="space-y-3 p-6">
              <h2 class="text-lg font-semibold text-highlighted">{{ announcement?.headline }}</h2>
              <p v-if="announcement?.description" class="text-sm leading-6 text-muted">{{ announcement.description }}</p>
              <a
                v-if="announcement?.cta_label && announcement?.cta_url"
                :href="announcement.cta_url"
                target="_blank"
                rel="noopener noreferrer"
                class="mt-2 inline-flex w-full items-center justify-center rounded-lg bg-action px-4 py-2.5 text-sm font-semibold text-on-action no-underline hover:opacity-90"
                @click="trackCtaClick"
              >
                {{ announcement.cta_label }}
              </a>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </template>
</template>

<script setup lang="ts">
import { usePublicAnnouncement } from '~/composables/usePublicAnnouncement'

const route = useRoute()
const { trackAnnouncementView, trackAnnouncementCtaClick } = useOrganizationConversionTracking()

const dismissed = ref(false)
const { announcement, storageKey } = await usePublicAnnouncement()

const visible = computed(() => !!announcement.value && !dismissed.value && (announcement.value.format ?? 'modal') === 'modal')

function dismiss() {
  if (announcement.value?.dismissible && storageKey.value) {
    try { localStorage.setItem(storageKey.value, '1') } catch { /* private browsing or blocked storage: closes for this view only */ }
  }
  dismissed.value = true
}

function trackCtaClick() {
  trackAnnouncementCtaClick(route.path)
}

onMounted(() => {
  if (!announcement.value || !storageKey.value || (announcement.value.format ?? 'modal') !== 'modal') return
  try {
    if (localStorage.getItem(storageKey.value) === '1') { dismissed.value = true; return }
  } catch { /* private browsing or blocked storage: never previously dismissed */ }
  trackAnnouncementView(route.path)
})
</script>
