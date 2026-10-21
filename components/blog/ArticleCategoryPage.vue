<template>
  <div class="space-y-8" :class="collection === 'docs' ? 'docs-category max-w-5xl' : ''">
    <ArticleBreadcrumb :crumbs="breadcrumbs" />
    <header class="max-w-2xl">
      <h1 class="font-bold tracking-tight text-default" :class="collection === 'docs' ? 'text-3xl' : 'text-4xl sm:text-5xl'">{{ category.name }}</h1>
      <p v-if="intro" class="mt-3 text-base leading-7 text-muted">{{ intro }}</p>
    </header>

    <div v-if="collection === 'docs'" class="space-y-9" data-parity-section="articles">
      <section v-if="featured" class="docs-category-feature grid items-end gap-7 border-b border-default" :class="illustration ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : ''" data-category-feature>
        <div class="max-w-xl pb-8">
          <h2 class="text-xl font-semibold leading-7 text-default">{{ featured.title }}</h2>
          <p v-if="featured.excerpt" class="mt-3 text-sm leading-6 text-muted">{{ featured.excerpt }}</p>
          <NuxtLink :to="featured.path" class="mt-5 inline-flex min-h-11 items-center gap-3 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white no-underline hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
            {{ t('site.posts.read_guide') }} <PlatformIcon name="arrow-right" class="size-4" />
          </NuxtLink>
        </div>
        <figure v-if="illustration" class="min-w-0 self-end">
          <img :src="illustration.src" :alt="illustration.alt" class="block max-h-80 w-full object-contain object-bottom" data-category-illustration>
        </figure>
      </section>

      <section v-if="guides.length" class="space-y-4">
        <h2 class="text-base font-semibold text-default">{{ t('site.posts.category_guides') }}</h2>
        <div class="grid gap-4 md:grid-cols-2" data-category-guides>
          <article v-for="article in guides" :key="article.id" class="group relative rounded-lg border border-default p-5 transition-colors hover:border-primary/40 hover:bg-elevated">
            <h3 class="text-sm font-semibold leading-6 text-default">
              <NuxtLink :to="article.path" class="no-underline after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary group-hover:text-primary">{{ article.title }}</NuxtLink>
            </h3>
            <p v-if="article.excerpt" class="mt-2 text-sm leading-6 text-muted">{{ article.excerpt }}</p>
          </article>
        </div>
      </section>
      <ArticleCategorySection v-for="child in category.children" :key="child.id" :category="child" compact />

      <section v-if="nextCategories.length" class="space-y-4 border-t border-default pt-7" data-category-next>
        <h2 class="text-base font-semibold text-default">{{ t('site.posts.next_steps') }}</h2>
        <div class="grid gap-x-8 gap-y-6 md:grid-cols-2">
          <section v-for="next in nextCategories" :key="next.id" class="space-y-2">
            <h3 class="text-sm font-semibold text-default"><NuxtLink :to="next.path" class="no-underline hover:text-primary">{{ next.name }}</NuxtLink></h3>
            <p v-if="next.description" class="text-sm leading-6 text-muted">{{ next.description }}</p>
            <ul class="space-y-2 pt-1">
              <li v-for="article in next.posts.slice(0, 2)" :key="article.id"><NuxtLink :to="article.path" class="text-sm leading-6 text-primary no-underline hover:underline">{{ article.title }}</NuxtLink></li>
            </ul>
          </section>
        </div>
      </section>
    </div>
    <div v-else class="space-y-12" data-parity-section="articles">
      <div v-if="category.posts.length" class="grid gap-6 md:grid-cols-2">
        <ArticleCard v-for="article in category.posts" :key="article.id" :article="article" />
      </div>
      <ArticleCategorySection v-for="child in category.children" :key="child.id" :category="child" />
    </div>
  </div>
</template>

<script setup lang="ts">
import ArticleBreadcrumb from '~/components/blog/ArticleBreadcrumb.vue'
import ArticleCard from '~/components/blog/ArticleCard.vue'
import ArticleCategorySection from '~/components/blog/ArticleCategorySection.vue'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import { ARTICLE_COLLECTIONS, collectionCategoryPath, type ArticleCollection } from '~/utils/article-collections'
import { categorySubtree, categoryTrail } from '~/composables/usePublishedArticles'

const props = defineProps<{ collection: ArticleCollection }>()
const route = useRoute()
const { t, localePath } = useI18n()
const { organization } = useTenantOrganization()
const isPlatform = organization.template.slug === 'platform'
const organizationName = organization.name

const { categories, localeRepresentations } = await usePublishedArticles(props.collection)
// A category with no published article, or none by this name, is not a page.
const found = categories.value.find(candidate => candidate.slug === String(route.params.slug))
if (!found) throw createError({ statusCode: 404, statusMessage: 'Category not found', fatal: true })
const category = computed(() => {
  const current = categories.value.find(candidate => candidate.slug === String(route.params.slug))
  if (!current) throw createError({ statusCode: 404, statusMessage: 'Category not found', fatal: true })
  return current
})

// Editorial emphasis selects existing published tasks; it does not create content.
const featured = computed(() => (isPlatform && props.collection === 'docs' && category.value.slug === 'getting-started'
  ? category.value.posts.find(article => article.slug === 'create-your-krabiclaw-account')
  : null) ?? category.value.posts[0] ?? null)
const guides = computed(() => category.value.posts.filter(article => article.id !== featured.value?.id))
const intro = computed(() => category.value.description || (props.collection === 'docs' ? category.value.posts[0]?.excerpt : null))
const illustration = computed(() => isPlatform && props.collection === 'docs' ? docsCategoryArt(category.value.slug) : null)
const nextCategories = computed(() => {
  if (!isPlatform || props.collection !== 'docs') return []
  const nextByCategory: Record<string, string[]> = {
    'getting-started': ['build-and-edit', 'ai-assistants'],
    'build-and-edit': ['run-your-business'],
    'run-your-business': ['integrations'],
    'ai-assistants': ['build-and-edit'],
    integrations: ['run-your-business'],
  }
  return (nextByCategory[category.value.slug] ?? []).flatMap(slug => {
    const next = categories.value.find(candidate => candidate.slug === slug && candidate.posts.length)
    return next ? [next] : []
  })
})
// A category page is read in the index's languages, under the index's prefix.
useState<PublicLocaleRepresentation[]>('public-locale-representations', () => []).value = localeRepresentations.value
  .filter(representation => found.locales.includes(representation.locale))
  .map(representation => ({ ...representation, route_path: `${representation.route_path}/category/${encodeURIComponent(found.slug)}` }))

const indexLabel = computed(() => props.collection === 'docs' ? t('site.footer.docs') : t('site.footer.blog'))
const indexPath = ARTICLE_COLLECTIONS[props.collection].pathPrefix
const path = computed(() => collectionCategoryPath(props.collection, category.value.slug))
// The index, then each category above this one, then this one.
const breadcrumbs = computed(() => [
  { name: indexLabel.value, url: localePath(indexPath) },
  ...categoryTrail(categories.value, category.value.id).map(crumb => ({ name: crumb.name, url: crumb.path })),
])
const itemList = useArticleItemList(() => localePath(path.value), () => category.value.name, () => props.collection === 'docs' && featured.value
  ? [featured.value, ...categorySubtree(category.value).flatMap(entry => entry.posts).filter(article => article.id !== featured.value!.id)]
  : categorySubtree(category.value).flatMap(entry => entry.posts))

useSocialMetadata(() => ({
  path: path.value,
  socialImage: illustration.value ? { url: illustration.value.og, width: 1200, height: 630, type: 'image/png', alt: illustration.value.alt } : organization.social_image,
  title: isPlatform ? `${category.value.name} | ${indexLabel.value}` : `${category.value.name} | ${indexLabel.value} | ${organizationName}`,
  description: category.value.description || t('site.posts.category_meta_description', { category: category.value.name, collection: indexLabel.value, organization: organizationName }),
  schemaPageType: 'CollectionPage',
  schemaNodes: [itemList.value],
  breadcrumbs: [
    { name: t('site.experience_detail.home'), url: localePath('/') },
    ...breadcrumbs.value,
  ],
}))
</script>
