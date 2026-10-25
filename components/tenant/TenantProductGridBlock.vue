<template>
  <TenantFeaturedContent :data="featured" />
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockRecords } from '~/utils/tenant-page-block-data'
import { presentationForProduct, productCtaKey, resolveProductPresentation } from '~/utils/product-presentation'
import { assertProductKind } from '~/shared/product-details'
import { resolveSocialImageUrl } from '~/utils/social-metadata'
import { getVerticalCopy } from '~/utils/vertical-copy'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()
const { locale, t } = useI18n()
const { organization } = useTenantOrganization()

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
    image: resolveSocialImageUrl(media && {
      kind: blockText(media.kind) || null,
      public_url: blockText(media.public_url) || null,
      thumbnail_url: blockText(media.thumbnail_url) || null,
    }),
    alt: blockText(media?.alt_text) || blockText(item.title),
    href: url || null,
    ctaText: t(productCtaKey(blockText(item.kind))),
    unavailable: item.unavailable === true,
    featured: item.featured === true,
    category: blockText(item.category) || null,
  }
}).filter(item => item.name))

const presentation = computed(() => {
  const first = items.value[0]
  return first && items.value.every(item => item.kind === first.kind)
    ? presentationForProduct({ kind: assertProductKind(first.kind) }, organization.theme_id)
    : resolveProductPresentation(organization.vertical)
})
const allExperiences = computed(() => items.value.length > 0 && items.value.every(item => item.kind === 'experience'))
const allFeatured = computed(() => items.value.length > 0 && items.value.every(item => item.featured))
const featured = computed(() => ({
  items: items.value,
  kicker: blockText(props.block.data.description)
    || (allExperiences.value ? homeCopy.value.experiencesPageTitle : presentation.value?.locationCollectionSegment === 'menu' ? t('site.footer.menu') : t('site.footer.products')),
  heading: blockText(props.block.data.title)
    || (allFeatured.value ? t('site.posts.featured') : allExperiences.value ? t('site.experiences.collection_title', { organization: brandName }) : presentation.value?.locationCollectionSegment === 'menu' ? t('site.footer.menu') : t('site.products.collection_title', { organization: brandName })),
  linkTarget: presentation.value?.collectionPath ?? null,
}))
</script>
