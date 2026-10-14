<template>
  <AppSection v-if="title || body" bg="black" padding="xl">
    <div :class="image ? 'grid gap-16 lg:grid-cols-2 lg:items-center' : ''">
      <div v-if="image" class="overflow-hidden">
        <UImage
          :src="image"
          :alt="imageAlt"
          class="aspect-4/3 w-full object-cover"
        />
      </div>
      <div>
        <p class="saya-eyebrow mb-8 text-inverted/60">{{ kicker }}</p>
        <h2 v-if="title" class="saya-display-md text-inverted" :class="image ? '' : 'max-w-3xl'">
          {{ title }}
        </h2>
        <p v-if="body" class="mt-8 text-base leading-relaxed text-inverted/60" :class="image ? '' : 'max-w-2xl'">
          {{ body }}
        </p>
        <NuxtLink
          v-if="linkUrl && linkLabel"
          :to="route(linkUrl)"
          class="mt-8 inline-block border-b border-inverted pb-1 text-xs uppercase tracking-widest text-inverted no-underline transition hover:opacity-60"
        >
          {{ linkLabel }}
        </NuxtLink>
      </div>
    </div>
  </AppSection>
</template>

<script setup lang="ts">
import AppSection from '~/components/ui/AppSection.vue'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockMedia, isInternalRoute } from '~/utils/tenant-page-block-data'

// Saya draws an image-with-text block as the brand story. It read three props
// a page component assembled from `story.title`, `story.body` and
// `story.image` — three blocks the renderer re-joined at display time, in the
// alphabetical order of the field names a migration wrote. It is one block now,
// and the words under it are the block's own, not the vertical's copy table.
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { localePath, locale } = useI18n()
const { organization } = useTenantOrganization()

const title = computed(() => blockText(props.block.data.title))
const body = computed(() => blockText(props.block.data.body))
const asset = computed(() => blockMedia(props.block, 'media')[0] ?? null)
const image = computed(() => asset.value?.public_url ?? '')
const imageAlt = computed(() => asset.value?.alt_text ?? '')
const linkLabel = computed(() => blockText(props.block.data.label))
const linkUrl = computed(() => blockText(props.block.data.url))
// The eyebrow above the story. It is the one word here the block does not
// carry, because it names the section rather than the site's own story.
const kicker = computed(() => getVerticalCopy(organization.vertical, locale.value).ourStoryKicker)

/** An internal route takes the visitor's locale; an absolute URL is left alone. */
function route(url: string) {
  return isInternalRoute(url) ? localePath(url) : url
}
</script>
