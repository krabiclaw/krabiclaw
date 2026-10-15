<template>
  <!-- Kept as a utility class, not scoped CSS, so the loading skeleton in
       LocationsPage can reserve exactly this layout.

       Tiles are 20/19, near square, matching the listings grid this follows.
       A square crop is only safe because the tile shows a photograph: the name
       is rendered underneath in HTML. Passing a generated social card here
       instead cut the baked-in title off at both edges.

       auto-fill, not auto-fit: auto-fit collapses the tracks it has no items
       for, so an organization with one site rendered that site across the whole
       row instead of in a card the size of every other card. -->
  <div
    class="grid"
    :class="rowsOnMobile ? 'grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] lg:gap-6' : 'grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-6'"
  >
    <!-- The status pill and the overflow menu are siblings of the link, not
         children of it: a menu trigger nested inside an anchor navigates on
         click instead of opening, so the tile would swallow its own action. -->
    <div
      v-for="item in items"
      :key="item.id"
      class="relative min-w-0"
      :class="rowsOnMobile ? 'border-b border-default last:border-b-0 lg:border-b-0' : undefined"
    >
      <NuxtLink
        :to="item.to"
        :aria-label="item.label"
        :aria-current="item.id === activeItem ? 'page' : undefined"
        :data-testid="`selector-item-${item.id}`"
        class="group block min-w-0"
        :class="item.id === activeItem ? 'bg-elevated shadow-[inset_3px_0_0_var(--ui-primary)]' : undefined"
      >
        <div :class="rowsOnMobile ? ['flex items-center gap-3 py-5 lg:block lg:p-0', item.actions?.length ? 'pr-16' : 'pr-6'] : undefined">
          <!--
            A photograph fills the tile and is cropped to it. A logo is centred at
            its own size instead, because cropping a mark is how a wordmark loses
            half its letters.
          -->
          <div
            v-if="item.imageUrl"
            class="overflow-hidden bg-elevated transition duration-300"
            :class="rowsOnMobile ? 'size-15 shrink-0 rounded-xl lg:aspect-[20/19] lg:h-auto lg:w-full lg:rounded-2xl lg:shadow-sm lg:group-hover:-translate-y-0.5 lg:group-hover:shadow-lg' : 'aspect-[20/19] w-full rounded-2xl shadow-sm group-hover:-translate-y-0.5 group-hover:shadow-lg'"
            :data-testid="`selector-image-${item.id}`"
            :data-selector-image="item.id"
          >
            <img
              :src="item.imageUrl"
              :alt="`${item.label} preview`"
              class="size-full"
              :class="item.imageFit === 'contain' ? 'scale-[0.45] object-contain' : 'object-cover'"
              loading="lazy"
              decoding="async"
            >
          </div>
          <!-- Not a placeholder standing in for the image: the image is genuinely
               absent, and this says so. The caller supplies the reason because a
               site and a location are missing different things — a generated
               social card versus a photo the tenant uploads. -->
          <div
            v-else
            class="flex flex-col items-center justify-center gap-1 bg-elevated text-center"
            :class="rowsOnMobile ? ['size-15 shrink-0 overflow-hidden rounded-xl px-1 lg:aspect-[20/19] lg:h-auto lg:w-full lg:rounded-2xl lg:px-4 lg:shadow-sm', item.fallbackIcon ? '' : 'border border-dashed border-default lg:border-0'] : 'aspect-[20/19] w-full rounded-2xl px-4 shadow-sm'"
            data-testid="selector-missing-social-image"
            :data-selector-image="item.id"
          >
            <UIcon
              :name="item.fallbackIcon ?? 'i-lucide-image-off'"
              :class="[rowsOnMobile ? 'size-4 lg:size-6' : 'size-6', item.fallbackIcon || rowsOnMobile ? 'text-muted' : 'text-error']"
            />
            <p v-if="!item.fallbackIcon" :class="rowsOnMobile ? 'text-[10px] text-muted lg:text-sm lg:font-medium lg:text-highlighted' : 'text-sm font-medium text-highlighted'">
              {{ item.missingImageLabel ?? missingImageLabel }}<span :class="rowsOnMobile ? 'hidden lg:inline' : undefined"> for {{ item.label }}</span>
            </p>
            <p v-if="!item.fallbackIcon" class="text-xs text-muted" :class="rowsOnMobile ? 'hidden lg:block' : undefined">{{ missingImageHint }}</p>
          </div>
          <div :class="rowsOnMobile ? 'min-w-0 flex-1 lg:px-1 lg:pt-4' : 'px-1 pt-4'">
            <component :is="`h${labelHeadingLevel}`" class="text-base font-semibold text-highlighted" :class="rowsOnMobile ? 'break-words' : undefined">{{ item.label }}</component>
            <!-- Sites are identified by vertical and domain, locations by address
                 alone. The separator belongs to the eyebrow rather than sitting
                 between the two unconditionally, so a card with one line does not
                 render a leading dot. -->
            <template v-if="rowsOnMobile">
              <p v-if="item.parentOrganizationName || item.eyebrow" class="mt-1 break-words text-sm text-muted">
                <template v-if="item.parentOrganizationName">{{ item.parentOrganizationName }}<span v-if="item.eyebrow" aria-hidden="true"> · </span></template>{{ item.eyebrow }}
              </p>
              <p v-if="item.summary" class="mt-1 break-words text-sm text-muted">{{ item.summary }}</p>
            </template>
            <p v-else class="mt-1 text-sm text-muted">
              <template v-if="item.parentOrganizationName">{{ item.parentOrganizationName }}<span aria-hidden="true"> · </span></template>
              <template v-if="item.eyebrow">{{ item.eyebrow }}<span aria-hidden="true"> · </span></template>{{ item.summary }}
            </p>
          </div>
          <UIcon v-if="rowsOnMobile" name="i-lucide-chevron-right" class="absolute right-0 top-1/2 size-4 -translate-y-1/2 text-muted lg:hidden" />
        </div>
      </NuxtLink>

      <!-- Absent for a record that is live: the pill exists to mark the one
           that is not, the way an in-progress listing is marked in the same
           grid as the published ones. -->
      <UBadge
        v-if="item.status"
        :label="item.status.label"
        :color="item.status.color"
        variant="solid"
        class="pointer-events-none absolute"
        :class="rowsOnMobile ? 'left-0 top-4 max-w-15 text-[10px] lg:left-3 lg:top-3 lg:max-w-none lg:text-xs' : 'left-3 top-3'"
        data-testid="selector-status-badge"
      />

      <UDropdownMenu
        v-if="item.actions?.length"
        :items="item.actions"
        :content="{ align: 'end' }"
      >
        <UButton
          icon="i-lucide-more-horizontal"
          color="neutral"
          variant="subtle"
          size="sm"
          square
          class="absolute"
          :class="rowsOnMobile ? 'right-7 top-1/2 -translate-y-1/2 lg:right-3 lg:top-3 lg:translate-y-0' : 'right-3 top-3'"
          :aria-label="`${item.label} actions`"
          :data-testid="`selector-actions-${item.id}`"
        />
      </UDropdownMenu>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { BadgeProps, DropdownMenuItem } from '@nuxt/ui'

export interface OrganizationLocationSelectorItem {
  id: string
  label: string
  imageUrl: string | null
  /** 'contain' centres a logo at its own size; the default crops a photograph. */
  imageFit?: 'cover' | 'contain'
  /** A section's own icon when it has no authored image. Products leave this unset. */
  fallbackIcon?: string
  /** Overrides the shared missing-image label for this record. */
  missingImageLabel?: string
  eyebrow: string
  summary: string
  to: string
  /** Marks a record that is not live yet. Omitted by a caller whose records are. */
  status?: { label: string; color: BadgeProps['color'] }
  /** The tile's overflow menu. Omitted when the viewer has no action on the record. */
  actions?: DropdownMenuItem[]
  /** Parent site name for organization-scoped location display */
  parentOrganizationName?: string
}

withDefaults(defineProps<{
  items: OrganizationLocationSelectorItem[]
  /** Catalog uses horizontal thumbnail rows below the desktop breakpoint. */
  rowsOnMobile?: boolean
  /** Keeps the record heading beneath the caller's section heading. */
  labelHeadingLevel?: 2 | 3
  /** The record already open in the adjacent editor pane. */
  activeItem?: string | null
  /** Names what is missing, e.g. "No social image" or "No photo". */
  missingImageLabel?: string
  /** Says why it is missing and what fixes it. */
  missingImageHint?: string
}>(), {
  rowsOnMobile: false,
  labelHeadingLevel: 2,
  activeItem: null,
  missingImageLabel: 'No social image',
  missingImageHint: 'Its social card has not been generated.',
})
</script>
