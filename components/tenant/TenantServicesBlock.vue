<template>
  <section class="relative pb-14 pt-14 sm:pb-20 sm:pt-14 lg:pb-14" :data-parity-section="paritySection">
    <div :class="isService ? 'blawby-container' : 'tenant-container'" class="relative z-20">
      <TenantSectionHeading
        v-if="title || description"
        :title="title"
        :accent="accent"
        :description="description"
        centered
      />
      <TenantPageGrid :items="items" :image-slot="imageSlot" class="mt-20" />
    </div>
    <img
      v-if="decorationUrl"
      :src="decorationUrl"
      alt=""
      width="1920"
      height="400"
      loading="lazy"
      class="absolute bottom-0 w-full object-contain object-center"
      :class="isService ? undefined : 'opacity-40'"
    >
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockRecords, blockMedia } from '~/utils/tenant-page-block-data'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { organization } = useTenantOrganization()

const isService = computed(() => organization.template?.slug === 'blawby' || organization.vertical === 'service')

const decorationUrl = computed(() => blockMedia(props.block, 'decoration')[0]?.public_url ?? null)

const items = computed(() => blockRecords(props.block.data.items).map(item => ({
  id: blockText(item.id),
  title: blockText(item.title),
  description: blockText(item.description) || undefined,
  url: blockText(item.url) || undefined,
  city: blockText(item.city) || undefined,
  address: blockText(item.address) || undefined,
  value: blockText(item.value) || undefined,
  compareAt: blockText(item.compare_at) || undefined,
  featured: item.featured === true,
  unavailable: item.unavailable === true,
  schedulingSummary: blockText(item.scheduling_summary) || undefined,
  media: blockRecords(item.media).map(media => ({
    slot: blockText(media.slot),
    public_url: blockText(media.public_url),
    thumbnail_url: blockText(media.thumbnail_url) || undefined,
    kind: blockText(media.kind),
  })).filter(media => media.slot && media.public_url),
})).filter(item => item.id && item.title))

const title = computed(() => blockText(props.block.data.title))
const accent = computed(() => blockText(props.block.data.accent))
const description = computed(() => blockText(props.block.data.description))
const imageSlot = computed(() => props.block.type === 'product_grid' ? 'image' : props.block.type === 'location_grid' ? 'hero' : 'cover')
const paritySection = computed(() => props.block.type === 'location_grid' ? 'locations' : props.block.type === 'product_grid' ? 'products' : 'services')
</script>
