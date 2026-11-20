<template>
  <template v-if="announcement && (announcement.format ?? 'modal') === format && storageKey">
  <aside
    v-if="format === 'banner'"
    :data-public-announcement="storageKey"
    :data-dismissible="announcement.dismissible"
    hidden
    aria-label="Announcement"
    class="relative z-40 bg-action text-on-action"
  >
    <div class="tenant-container flex items-center justify-between gap-x-4 py-2.5 text-sm">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p class="font-medium">
          <strong v-if="announcement.headline" class="font-semibold">{{ announcement.headline }}</strong>
          <span v-if="announcement.headline && announcement.description" class="mx-1.5 opacity-75">·</span>
          <span v-if="announcement.description" class="opacity-90">{{ announcement.description }}</span>
        </p>
        <a
          v-if="announcement.cta_label && announcement.cta_url"
          :href="announcement.cta_url"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 font-semibold underline underline-offset-4 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          data-announcement-link
        >
          {{ announcement.cta_label }}
          <svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.638L10.23 5.29a.75.75 0 1 1 1.04-1.08l5.5 5.25a.75.75 0 0 1 0 1.08l-5.5 5.25a.75.75 0 1 1-1.04-1.08l4.158-3.96H3.75A.75.75 0 0 1 3 10Z" clip-rule="evenodd" />
          </svg>
        </a>
      </div>

      <button
        v-if="announcement.dismissible"
        type="button"
        class="-mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-lg p-1 text-on-action opacity-75 hover:opacity-100 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        aria-label="Dismiss announcement"
        data-announcement-dismiss
      >
        <svg class="size-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
        </svg>
      </button>
    </div>
  </aside>
  <dialog v-else :data-public-announcement="storageKey" :data-dismissible="announcement.dismissible" :aria-label="announcement.headline" class="m-auto w-[calc(100%-2rem)] max-w-sm overflow-visible bg-transparent p-0 backdrop:bg-black/50">
        <div class="relative w-full max-w-sm">
          <button
            type="button"
            class="absolute -right-3 -top-3 z-10 flex size-8 items-center justify-center rounded-full bg-elevated text-muted shadow-lg ring-1 ring-default hover:bg-muted hover:text-highlighted"
            aria-label="Close"
            data-announcement-dismiss
          >
            <svg class="size-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M5.22 5.22a.75.75 0 0 1 1.06 0L10 8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L8.94 10 5.22 6.28a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
          <div class="overflow-hidden rounded-2xl bg-elevated shadow-xl">
            <img
              v-if="announcement.image_url"
              :src="announcement.image_url"
              alt=""
              class="h-48 w-full object-cover"
            >
            <div class="space-y-3 p-6">
              <h2 class="text-lg font-semibold text-highlighted">{{ announcement.headline }}</h2>
              <p v-if="announcement.description" class="text-sm leading-6 text-muted">{{ announcement.description }}</p>
              <a
                v-if="announcement.cta_label && announcement.cta_url"
                :href="announcement.cta_url"
                target="_blank"
                rel="noopener noreferrer"
                class="mt-2 inline-flex w-full items-center justify-center rounded-lg bg-action px-4 py-2.5 text-sm font-semibold text-on-action no-underline hover:opacity-90"
                data-announcement-link
              >
                {{ announcement.cta_label }}
              </a>
            </div>
          </div>
        </div>
  </dialog>
  </template>
</template>

<script setup lang="ts">
defineProps<{ format: 'banner' | 'modal' }>()
const { announcement, storageKey } = await usePublicAnnouncement()
</script>
