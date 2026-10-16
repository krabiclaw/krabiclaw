<template>
  <!--
    One article, on every template and in every collection: a blog post on
    Saya, an article on Blawby, a post or a doc on KrabiClaw's own site. The
    template's layout is the chrome around it and its design tokens are the
    only other difference.
  -->
  <div :data-collection="collection" :class="hasToc ? 'xl:grid xl:grid-cols-[minmax(0,1fr)_240px] xl:gap-10' : undefined">
    <div class="min-w-0">
      <ArticleBreadcrumb :crumbs="breadcrumbs" />

      <div ref="articleBodyRef" data-parity-section="article-content">
        <BlogArticleRenderer
          :title="post.title"
          :excerpt="post.excerpt"
          :published-at="post.published_at"
          :updated-at="post.updated_at"
          :author-name="authorName"
          :author-image="post.author?.image ?? null"
          :organization-name="organizationName"
          :blocks="post.content_blocks"
          :template="template.slug"
        >
          <template #before-content>
            <ArticleToc v-if="hasToc" :html="tocHtml" collapsible class="mb-8 xl:hidden" />
          </template>
        </BlogArticleRenderer>
      </div>

      <nav v-if="previousArticle || nextArticle" :aria-label="indexLabel" class="mt-12 grid gap-6 border-t border-default pt-6 sm:grid-cols-2">
        <NuxtLink v-if="previousArticle" :to="previousArticle.path" class="group flex min-w-0 flex-initial flex-col gap-1 no-underline">
          <span class="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{{ t('saya.posts.previous') }}</span>
          <span class="flex w-full min-w-0 items-center gap-1.5 text-lg font-semibold text-default group-hover:text-primary">
            <PlatformIcon name="arrow-left" class="size-4 shrink-0" />
            <span class="min-w-0 break-words">{{ previousArticle.title }}</span>
          </span>
        </NuxtLink>
        <span v-else />
        <NuxtLink v-if="nextArticle" :to="nextArticle.path" class="group flex min-w-0 flex-initial flex-col items-start gap-1 sm:items-end sm:text-right no-underline">
          <span class="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{{ t('saya.posts.next') }}</span>
          <span class="flex w-full min-w-0 items-center gap-1.5 text-lg font-semibold text-default group-hover:text-primary">
            <span class="min-w-0 break-words">{{ nextArticle.title }}</span>
            <PlatformIcon name="arrow-right" class="size-4 shrink-0" />
          </span>
        </NuxtLink>
      </nav>
    </div>

    <aside v-if="hasToc" class="hidden xl:block">
      <ArticleToc :html="tocHtml" />
    </aside>
  </div>
</template>

<script setup lang="ts">
import { shallowRef } from 'vue'
import ArticleBreadcrumb from '~/components/blog/ArticleBreadcrumb.vue'
import ArticleToc from '~/components/blog/ArticleToc.vue'
import BlogArticleRenderer from '~/components/blog/BlogArticleRenderer.vue'
import { headingAnchor, renderMarkdownToHtml, sanitizeHtmlForSsr } from '~/utils/markdown'
import { loadDomPurify } from '~/utils/dom-purify-loader'
import { resolveSocialImageUrl } from '~/utils/social-metadata'
import { tenantBlogPostPath } from '~/utils/tenant-blog-route'
import { ARTICLE_COLLECTIONS, type ArticleCollection } from '~/utils/article-collections'
import { categoryTrail } from '~/composables/usePublishedArticles'

const props = defineProps<{ collection: ArticleCollection }>()

const DOMPurify = import.meta.client ? await loadDomPurify() : { sanitize: sanitizeHtmlForSsr }
const route = useRoute()
const { t, localePath } = useI18n()
const { organization } = useTenantOrganization()
const { template } = organization
const locale = useState<string>('public-locale', () => 'en')

const slug = computed(() => String(route.params.slug || '').trim())
if (!slug.value) throw createError({ statusCode: 404, statusMessage: 'Article not found' })
const post = await usePublishedArticle(props.collection, slug)
const { readingOrder: articles, categories } = await usePublishedArticles(props.collection)

const organizationName = organization.name
const authorName = computed(() => post.value.author?.name ?? null)
// Each collection's index is at its own prefix on every template; only a blog article's own path varies (/blog or /article).
const indexPath = computed(() => localePath(ARTICLE_COLLECTIONS[props.collection].pathPrefix))
const indexLabel = computed(() => props.collection === 'docs' ? t('saya.footer.docs') : t('saya.footer.blog'))
const articlePath = computed(() => localePath(tenantBlogPostPath(template, post.value.slug, props.collection)))
// The index, the article's category, the article: the category is a page of its own.
const breadcrumbs = computed(() => [
  { name: indexLabel.value, url: indexPath.value },
  // Every category above the article's own, then its own.
  ...(post.value.category ? categoryTrail(categories.value, post.value.category.id).map(crumb => ({ name: crumb.name, url: crumb.path })) : []),
  { name: post.value.title, url: articlePath.value },
])

// Previous and next walk the collection in the order the sidebar reads it: each category's articles, then its subcategories'.
const currentIndex = computed(() => articles.value.findIndex(item => item.id === post.value.id || item.slug === post.value.slug))
const previousArticle = computed(() => currentIndex.value > 0 ? articles.value[currentIndex.value - 1] : null)
const nextArticle = computed(() => currentIndex.value >= 0 && currentIndex.value < articles.value.length - 1 ? articles.value[currentIndex.value + 1] : null)

const tocHtml = computed(() => post.value.content_blocks
  .map((block, index) => {
    if (block.type === 'markdown') return DOMPurify.sanitize(renderMarkdownToHtml(String(block.data.markdown || ''), index))
    if (block.type !== 'heading') return ''
    const level = Math.max(2, Math.min(6, block.level || 2))
    const text = String(block.data.text || '')
    return `<h${level} id="${headingAnchor(text)}-${index}">${DOMPurify.sanitize(text)}</h${level}>`
  })
  .join('\n'))
// The column is there only when the article has headings to list; an empty one left a blank strip beside the text.
const hasToc = computed(() => /<h[23]\b[^>]*\bid="[^"]+"/.test(tocHtml.value))
const articleBodyRef = shallowRef<Element | null>(null)
useCopyableCodeBlocks(articleBodyRef, computed(() => post.value.content_blocks))

useSocialMetadata(() => {
  return {
    pageType: 'article',
    title: post.value.title,
    description: post.value.excerpt,
    path: articlePath.value,
    author: authorName.value,
    publishedAt: post.value.published_at,
    discoverability: post.value.visibility,
    socialImage: post.value.social_image,
    breadcrumbs: breadcrumbs.value,
    contentBlocks: post.value.content_blocks,
    article: {
      type: props.collection === 'docs' ? 'TechArticle' : 'BlogPosting',
      imageUrl: resolveSocialImageUrl(post.value.cover ?? null),
      imageWidth: post.value.cover?.width,
      imageHeight: post.value.cover?.height,
      dateModified: post.value.updated_at,
      articleSection: post.value.category?.name,
      keywords: post.value.seo_keywords,
      inLanguage: locale.value === 'en' ? 'en-US' : locale.value,
    },
  }
})

useHead(() => ({
  meta: post.value.seo_keywords?.trim() ? [{ name: 'keywords', content: post.value.seo_keywords.trim() }] : [],
}))
</script>

<style scoped>
[data-collection="docs"] :deep(.blog-article-header h1) { font-size: clamp(1.875rem, 4vw, 2.75rem); overflow-wrap: anywhere; }
[data-collection="docs"] :deep(.blog-article-header > p) { font-size: 1.125rem; line-height: 1.75; }
[data-collection="docs"] :deep(.blog-article figure img) { height: auto; object-fit: contain; }
</style>
