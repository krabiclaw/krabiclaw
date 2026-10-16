<template>
  <!--
    Every blog and KrabiClaw's docs, on every template: the site's own chrome,
    and inside it one article layout — the collection by category down the
    side, the page beside it. Below the width where the template's header
    collapses, the list moves into that header's menu: one navigation, not a
    second drawer beside the hamburger.
  -->
  <NuxtLayout :name="template.slug">
    <div class="mx-auto px-5 py-8 sm:px-8 lg:px-10" :class="[split.grid, isDocs ? 'docs-shell max-w-360' : 'max-w-7xl']">
      <aside class="hidden" :class="split.aside">
        <!-- Desktop search leads the sidebar; collapsed, it leads the header's menu. -->
        <PlatformCommandSearchTrigger
          v-if="nav.search && template.slug !== 'platform'"
          :surface="nav.search.surface"
          :variant="nav.search.variant"
          :label="searchLabel"
          :aria-label="searchLabel"
          class="mb-3"
        />
        <ArticleSidebar :nav="nav" />
      </aside>

      <div class="min-w-0">
        <slot />
      </div>
    </div>

    <PlatformCommandSearchModal v-if="nav.search" :key="nav.search.surface" :surface="nav.search.surface" :variant="nav.search.variant" />
  </NuxtLayout>
</template>

<script setup lang="ts">
import ArticleSidebar from '~/components/blog/ArticleSidebar.vue'
import PlatformCommandSearchModal from '~/components/platform/search/PlatformCommandSearchModal.vue'
import PlatformCommandSearchTrigger from '~/components/platform/search/PlatformCommandSearchTrigger.vue'
import { articleNavKey } from '~/composables/useArticleNav'

const { t } = useI18n()
const route = useRoute()
const isDocs = computed(() => route.meta.articleCollection === 'docs')
const { organization } = useTenantOrganization()
const { template } = organization
const nav = await useArticleNav()
provide(articleNavKey, nav)
const searchLabel = computed(() => t('saya.search.dialog_title', { surface: nav.value.indexLabel }))

// The sidebar shows exactly where the template's header stops collapsing:
// KrabiClaw's header at `nav` (1080px), the tenant templates' at `lg`.
const split = computed(() => template.slug === 'platform'
  ? { grid: isDocs.value ? 'nav:grid nav:grid-cols-[280px_minmax(0,1fr)] nav:gap-10' : 'nav:grid nav:grid-cols-[220px_minmax(0,1fr)] nav:gap-12', aside: 'nav:sticky nav:top-28 nav:block nav:h-fit nav:max-h-[calc(100vh-8rem)] nav:overflow-y-auto' }
  : { grid: isDocs.value ? 'lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-10' : 'lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-10', aside: 'lg:sticky lg:top-28 lg:block lg:h-fit lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto' })
</script>

<style>
@import "@fontsource/inter/400.css";
@import "@fontsource/inter/500.css";
@import "@fontsource/inter/600.css";
@import "@fontsource/inter/700.css";
.docs-shell { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.docs-shell h1, .docs-shell h2, .docs-shell h3 { font-family: inherit; }
.docs-shell h1 { font-weight: 650; }
.docs-shell section > h2 { font-weight: 650; }
.docs-shell > aside { border-right: 1px solid var(--ui-border); padding-right: 1.25rem; scrollbar-width: thin; scrollbar-color: var(--ui-text-dimmed) transparent; scrollbar-gutter: stable; }
.docs-shell > aside::-webkit-scrollbar { width: 6px; }
.docs-shell > aside::-webkit-scrollbar-track { background: transparent; }
.docs-shell > aside::-webkit-scrollbar-thumb { background: var(--ui-text-dimmed); border-radius: 6px; }
.docs-shell > aside nav { font-size: 0.8125rem; line-height: 1.5; }
.docs-shell > aside summary { margin-bottom: 0.25rem; }
.docs-shell > aside details { margin-bottom: 1rem; }
.docs-shell .docs-category h1 { font-size: 2rem; line-height: 1.2; }
.docs-shell .docs-category section > h2 { font-weight: 600; }
.docs-shell .docs-task a:hover { text-decoration: underline; text-underline-offset: 3px; }
.docs-shell .blog-article-header { margin-bottom: 2rem; }
.docs-shell .blog-article-header > div { border: 0; padding: 0; margin-top: 1.25rem; }
.docs-shell .blog-article-header .size-11 { display: none; }
.docs-shell .blog-article { max-width: 48rem; }
.docs-shell .blog-article .prose { font-size: 1rem; line-height: 1.8; }
</style>
