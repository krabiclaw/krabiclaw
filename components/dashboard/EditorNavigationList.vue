<template>
  <div class="space-y-8">
    <section v-for="group in groups" :key="group.id" class="space-y-3">
      <h2 v-if="group.label" class="text-sm font-semibold text-muted">
        {{ group.label }}
      </h2>

      <!-- Rows: settings, where the chevron marks a push into a deeper screen. -->
      <!-- The rows sit on the pane itself: a card around them is a second surface saying nothing.
           Their highlight reaches into the gutter so their text keeps the gutter's edge. -->
      <div class="-mx-4">
        <component
          :is="item.to ? NuxtLink : item.action ? 'button' : 'div'"
          v-for="(item, index) in group.items"
          :key="item.id"
          v-bind="item.to ? { to: item.to } : item.action ? { type: 'button' } : {}"
          class="group flex min-h-20 w-full items-center gap-4 text-left px-4 py-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
          :class="[
            index > 0 ? 'border-t border-default' : '',
            item.id === activeItem ? 'bg-elevated shadow-[inset_3px_0_0_var(--ui-primary)]' : '',
            item.to || item.action ? 'hover:bg-elevated' : '',
          ]"
          :aria-current="item.id === activeItem ? 'page' : undefined"
          @click="item.action ? $emit('act', item.id) : undefined"
        >
          <!--
            A mark beside the label: the product's logo, or the record's own
            picture with a muted icon in the same footprint when it has none,
            so rows with and without one line up (DESIGN.md).
          -->
          <span
            v-if="item.lead"
            class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-elevated"
          >
            <img
              v-if="item.lead.image"
              :src="item.lead.image"
              alt=""
              class="size-full"
              :class="[item.lead.imageFit === 'contain' ? 'object-contain p-2' : 'object-cover', item.lead.darkImage ? 'dark:hidden' : '']"
              loading="lazy"
              decoding="async"
            >
            <img
              v-if="item.lead.image && item.lead.darkImage"
              :src="item.lead.darkImage"
              alt=""
              class="hidden size-full dark:block"
              :class="item.lead.imageFit === 'contain' ? 'object-contain p-2' : 'object-cover'"
              loading="lazy"
              decoding="async"
            >
            <UIcon v-if="!item.lead.image" :name="item.lead.icon" class="size-7 text-dimmed" />
          </span>
          <span class="min-w-0 flex-1">
            <!-- The picture leads, in the row's own footprint (DESIGN.md). -->
            <img
              v-if="item.image"
              :src="item.image"
              alt=""
              class="mb-3 aspect-[40/21] w-full rounded-xl object-cover"
              loading="lazy"
              decoding="async"
            >
            <!--
              Several pictures share the row's width. Four thumbnails at a fixed
              96px overran a phone and scrolled the whole column.
            -->
            <span v-else-if="item.images?.length" class="mb-3 flex w-full gap-2">
              <img
                v-for="(picture, at) in item.images"
                :key="at"
                :src="picture"
                alt=""
                class="aspect-[20/19] min-w-0 max-w-24 flex-1 rounded-xl object-cover"
                loading="lazy"
                decoding="async"
              >
            </span>
            <span class="block font-semibold text-highlighted">{{ item.label }}</span>
            <span
              v-if="item.summary && !item.card"
              class="mt-1 line-clamp-2 block text-sm"
              :class="item.placeholder ? 'italic text-dimmed' : 'text-muted'"
            ><span
              v-if="item.status"
              class="me-1.5 inline-block size-2 rounded-full align-middle"
              :class="{ success: 'bg-success', error: 'bg-error', neutral: 'bg-(--ui-text-dimmed)' }[item.status]"
            />{{ item.summary }}</span>


            <!--
              The share card's own proportions, so the crop the tenant is
              choosing is the crop readers get. An absent picture says what
              follows from that rather than sitting blank.
            -->
            <span v-if="item.card" class="mt-3 block overflow-hidden rounded-xl border border-default">
              <img
                v-if="item.card.image"
                :src="item.card.image"
                alt=""
                class="aspect-[1200/630] w-full bg-elevated object-cover"
                loading="lazy"
                decoding="async"
              >
              <span
                v-else
                class="flex aspect-[1200/630] w-full items-center justify-center bg-elevated px-6 text-center text-sm italic text-dimmed"
              >{{ item.card.empty }}</span>
              <span class="block px-4 py-3">
                <span class="block truncate text-sm font-semibold text-highlighted">{{ item.card.title }}</span>
                <span v-if="item.card.description" class="mt-0.5 line-clamp-2 block text-sm text-muted">{{ item.card.description }}</span>
              </span>
            </span>
          </span>
          <!--
            A row that opens a level gets the chevron. A row that acts is the
            control: the whole row presses, and a trailing verb names what it
            does only where the label is a noun (Languages → Localize).
          -->
          <span
            v-if="item.action?.label"
            class="shrink-0 text-sm font-medium text-highlighted underline underline-offset-4"
          >{{ item.action.label }}</span>
          <UIcon v-else-if="item.to" name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
        </component>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { NuxtLink } from '#components'

export interface EditorNavigationItem {
  id: string
  label: string
  summary?: string
  icon?: string
  /**
   * Where the row goes. A row with no `to` and no `action` states a value and
   * does nothing — the Google connection is read-only here — so it renders
   * inert rather than as a control that looks clickable and is not.
   */
  to?: string
  /**
   * A mark in a fixed footprint ahead of the label: `image` when the record
   * has a picture, `icon` in its place when it has none — or on its own, for
   * a product known by its logo.
   */
  lead?: { image?: string | null; darkImage?: string; imageFit?: 'cover' | 'contain'; icon?: string }
  /** A dot ahead of the summary: the thing the row names is working, failing, or off. */
  status?: 'success' | 'error' | 'neutral'
  /** Renders the summary as absent rather than as a value. */
  placeholder?: boolean
  /** A picture that leads the row, in the row's own footprint. */
  image?: string | null
  /** Several pictures that lead the row, sharing its width. */
  images?: readonly string[]
  /**
   * Renders the row as the card a reader will actually meet — the picture, the
   * headline and the line underneath it — rather than a summary naming the
   * fields. Where the row is the post's picture, "Image" tells the tenant a
   * value exists; the card tells them how it crops and what it sits next to.
   */
  card?: { image: string | null; title: string; description: string | null; empty: string }
  /**
   * A row that acts rather than opening anything. It is not a level of the
   * chain, so it takes no chevron: the row itself is the button and its id is
   * emitted through `act`. `label` adds a trailing verb where the row's own
   * label does not say what pressing it does — Languages → Localize. Log out
   * already does, so it carries none.
   */
  action?: { label?: string }
}

export interface EditorNavigationGroup {
  id: string
  label?: string
  items: EditorNavigationItem[]
}

defineProps<{
  groups: EditorNavigationGroup[]
  activeItem?: string | null
}>()

defineEmits<{
  /** Emitted by a session action row's control, carrying the item id. */
  act: [id: string]
}>()
</script>
