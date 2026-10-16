<template>
  <div :class="{ 'platform-docs': section === 'docs' }" class="platform-layout platform-theme min-h-screen flex flex-col font-sans selection:bg-stone-900 selection:text-white" :data-font-preset="fontPreset">
    <PlatformHeader :section="section" />
    <main class="grow">
      <slot />
    </main>
    <LazyPlatformFooter />
    <!-- An article page searches its own collection; the articles layout mounts that one. -->
    <PlatformCommandSearchModal v-if="section === 'platform'" surface="public" />
  </div>
</template>

<script setup lang="ts">
import PlatformHeader from '~/components/platform/PlatformHeader.vue'
import PlatformCommandSearchModal from '~/components/platform/search/PlatformCommandSearchModal.vue'
import '~/assets/css/platform-entry.css'

const { fontPreset } = usePublicSiteBrand()

// The stable surface file is written by `nuxt build`; under `nuxt dev` Vite serves
// the imported entry itself, so the link exists only in built output.
useHead({
  link: import.meta.dev ? [] : [{ rel: 'stylesheet', href: '/_nuxt/surfaces/platform.css' }],
})

// KrabiClaw's blog and docs pages name their collection; the header says which.
const route = useRoute()
const section = computed(() => route.meta.articleCollection === 'docs' ? 'docs' as const
  : route.meta.articleCollection === 'blog' ? 'blog' as const : 'platform' as const)

// KrabiClaw's public pages have one theme: dark. It is rendered on the server
// so a visitor never sees a light frame first.
useHead(() => ({
  htmlAttrs: { class: section.value === 'docs' ? 'dark platform-documentation' : 'dark', 'data-theme': 'dark', style: 'color-scheme: dark' },
  titleTemplate: (title) => title ? `${title} | KrabiClaw` : 'KrabiClaw | AI Website Platform'
}))
</script>

<style>
/* Keep native document scrollbars consistent with the platform theme. */
html.platform-documentation { scrollbar-width: thin; scrollbar-color: var(--ui-text-dimmed) var(--ui-bg); }
/* Platform-specific base styles */
.platform-layout {
  background-color: var(--ui-bg);
  color: var(--ui-text);
}
.platform-docs h1, .platform-docs h2, .platform-docs h3 { font-family: inherit; }
</style>
