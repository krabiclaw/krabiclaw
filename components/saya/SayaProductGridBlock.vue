<template>
  <SayaFeaturedContent :data="featured" />
</template>

<script setup lang="ts">
import SayaFeaturedContent from '~/components/saya/SayaFeaturedContent.vue'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockRecords } from '~/utils/tenant-page-block-data'
import { productCtaKey, resolveProductPresentation } from '~/utils/product-presentation'
import { resolveSocialImageUrl } from '~/utils/social-metadata'

// Saya's catalogue preview. The block names the products — a collection, or a
// hand-picked set — and the loader resolves each card's price and its route,
// so this draws what the block selected. It used to take the front of whatever
// the merchant's collections happened to contain, which no page could express
// and no owner could change.
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { locale, t } = useI18n()
const { organization } = useTenantOrganization()

const presentation = computed(() => resolveProductPresentation(organization.vertical))
const homeCopy = computed(() => getVerticalCopy(organization.vertical, locale.value))
const brandName = organization.name

const items = computed(() => blockRecords(props.block.data.items).map((item) => {
  const media = blockRecords(item.media)[0] ?? null
  const url = blockText(item.url)
  return {
    kind: blockText(item.kind),
    name: blockText(item.title),
    description: blockText(item.description),
    price: blockText(item.value) || null,
    compareAtPrice: blockText(item.compare_at) || null,
    // A card draws a still. A video cover is shown as its own poster frame —
    // the same asset — because an <img> cannot render an .mp4.
    image: resolveSocialImageUrl(media && {
      kind: blockText(media.kind) || null,
      public_url: blockText(media.public_url) || null,
      thumbnail_url: blockText(media.thumbnail_url) || null,
    }),
    alt: blockText(media?.alt_text) || blockText(item.title),
    // A product published at more than one location has no single page, so its
    // card is shown without a link rather than sent to a location the merchant
    // did not name.
    href: url || null,
    ctaText: t(productCtaKey(blockText(item.kind))),
    // A product with no current offer cannot be bought today, whatever the
    // card says next to it.
    unavailable: item.unavailable === true,
    featured: item.featured === true,
    category: blockText(item.category) || null,
  }
}).filter(item => item.name))

const allExperiences = computed(() => items.value.length > 0 && items.value.every(item => item.kind === 'experience'))
const allFeatured = computed(() => items.value.length > 0 && items.value.every(item => item.featured))
const featured = computed(() => ({
  items: items.value,
  kicker: blockText(props.block.data.description)
    || (allExperiences.value ? homeCopy.value.experiencesPageTitle : presentation.value?.locationCollectionSegment === 'menu' ? t('saya.footer.menu') : t('saya.footer.products')),
  heading: blockText(props.block.data.title)
    || (allFeatured.value ? t('saya.posts.featured') : allExperiences.value ? t('saya.experiences.collection_title', { organization: brandName }) : presentation.value?.locationCollectionSegment === 'menu' ? t('saya.footer.menu') : t('saya.products.collection_title', { organization: brandName })),
  linkTarget: allExperiences.value ? '/experiences' : presentation.value?.collectionPath ?? null,
}))
</script>
