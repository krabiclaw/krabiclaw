<template>
  <!--
    A collection's index — the blog or the docs — on every template: the
    newest-placed article leads, then the rest grouped by the collection's
    categories in the owner's order, subcategories under their parent, each
    heading linking to its category page.
  -->
  <div :class="collection === 'docs' ? 'space-y-8' : 'space-y-14'">
    <header class="max-w-3xl" :class="collection === 'docs' ? 'pb-5' : ''">
      <h1 class="font-bold text-default" :class="collection === 'docs' ? 'text-3xl tracking-tight sm:text-4xl' : 'text-4xl sm:text-5xl'">{{ title }}</h1>
      <p v-if="index?.summary || (collection === 'docs' && featured?.excerpt)" class="mt-4 max-w-2xl text-lg leading-8 text-muted">{{ index?.summary || featured?.excerpt }}</p>
      <NuxtLink v-if="collection === 'docs' && featured" :to="featured.path" class="mt-6 inline-flex min-h-11 items-center gap-3 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white no-underline hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
        {{ featured.title }} <PlatformIcon name="arrow-right" class="size-4" />
      </NuxtLink>
    </header>

    <div v-if="posts.length === 0" class="py-16 text-center text-muted">
      <p class="text-lg font-medium">{{ t('saya.posts.empty_title') }}</p>
    </div>

    <div v-else :class="collection === 'docs' ? 'space-y-10' : 'space-y-14'" data-parity-section="articles">
      <ArticleCard v-if="featured && collection !== 'docs'" :article="featured" featured />
      <div :class="collection === 'docs' ? 'grid items-start gap-x-10 gap-y-9 md:grid-cols-2 xl:grid-cols-3' : 'space-y-14'">
        <ArticleCategorySection v-for="category in categoryTree" :key="category.id" :category="category" :exclude="featured?.id ?? null" :compact="collection === 'docs'" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import ArticleCard from '~/components/blog/ArticleCard.vue'
import ArticleCategorySection from '~/components/blog/ArticleCategorySection.vue'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import { ARTICLE_COLLECTIONS, type ArticleCollection } from '~/utils/article-collections'

const props = defineProps<{ collection: ArticleCollection }>()
const { t, localePath } = useI18n()
const { organization } = useTenantOrganization()
const isPlatform = organization.template.slug === 'platform'
const organizationName = organization.name

const { posts, categoryTree, index, localeRepresentations } = await usePublishedArticles(props.collection)
// The index is read in every language the site publishes; the switcher offers them.
useState<PublicLocaleRepresentation[]>('public-locale-representations', () => []).value = localeRepresentations.value

const label = computed(() => props.collection === 'docs' ? t('saya.footer.docs') : t('saya.footer.blog'))
const title = computed(() => index.value?.title?.trim() || label.value)
// The first article leads the index, the way the list reads.
const featured = computed(() => posts.value[0] ?? null)

const path = ARTICLE_COLLECTIONS[props.collection].pathPrefix
const itemList = useArticleItemList(() => localePath(path), title, posts)
useSocialMetadata(() => ({
  path,
  schemaPageType: 'CollectionPage',
  schemaNodes: [itemList.value],
  // A page about the business: its image is the organization's.
  socialImage: organization.social_image,
  // Krabiclaw's layout already titles every page with its own name.
  title: isPlatform ? title.value : `${title.value} | ${organizationName}`,
  description: index.value?.summary || t(props.collection === 'docs' ? 'saya.posts.docs_meta_description' : 'saya.posts.meta_description', { organization: organizationName }),
  breadcrumbs: [
    { name: t('saya.experience_detail.home'), url: localePath('/') },
    { name: label.value, url: localePath(path) },
  ],
}))
</script>
