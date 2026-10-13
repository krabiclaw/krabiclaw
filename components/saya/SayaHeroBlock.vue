<template>
  <SayaHomeHero :data="heroData" />
</template>

<script setup lang="ts">
import SayaHomeHero from '~/components/saya/SayaHomeHero.vue'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockMedia } from '~/utils/tenant-page-block-data'

// Saya draws a hero block with the same opening the location pages use. What
// the block carries is the content — headline, subheading, picture and the two
// buttons; what the site carries is the brand colour, the locations and
// whether ordering exists. The buttons used to be substituted from the
// vertical's copy table, so no owner could change the words on them.
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { organization } = useTenantOrganization()
const { locations } = useOrganizationShellState()

const asset = computed(() => blockMedia(props.block, 'media')[0] ?? null)
const heroData = computed(() => {
  const media = asset.value
  const isVideo = media?.kind === 'video'
  return {
    hero: {
      title: blockText(props.block.data.title),
      subtitle: blockText(props.block.data.subtitle),
      image: isVideo ? '' : media?.public_url ?? '',
      imageKind: isVideo ? 'video' : 'image',
      video: isVideo ? media?.public_url ?? '' : '',
      videoKind: isVideo ? 'video' : 'image',
      thumbnail_url: media?.thumbnail_url ?? null,
    },
    eyebrow: blockText(props.block.data.eyebrow),
    locations: locations.value,
    ctaRoute: blockText(props.block.data.cta_url),
    reserveCta: blockText(props.block.data.cta_label),
    viewMenuRoute: blockText(props.block.data.secondary_url),
    viewMenuCta: blockText(props.block.data.secondary_label),
    vertical: organization.vertical,
  }
})
</script>
