<template>
  <footer class="border-t border-default bg-(color:--kc-footer-bg) text-default">
    <div class="mx-auto max-w-304 px-6 pb-8 pt-16">

      <div class="mb-12 grid grid-cols-2 gap-8 md:grid-cols-[1.4fr_repeat(4,1fr)] md:gap-10">
        <div class="col-span-2 md:col-span-1">
          <NuxtLink to="/" class="group inline-flex items-center gap-2.5 no-underline">
            <img src="/platform/krabiclaw-symbol.svg" alt="KrabiClaw" width="34" height="34" class="size-8.5 rounded-lg transition-transform duration-200 group-hover:rotate-12" />
            <span class="kc-wordmark text-[19px] leading-none">
              <span class="kc-wordmark__krabi">krabi</span><span class="kc-wordmark__claw">claw</span><span class="kc-wordmark__tld">.com</span>
            </span>
          </NuxtLink>
          <p class="mt-3.5 max-w-75 text-[13px] leading-relaxed text-muted">
            Websites for restaurants, experiences, and law firms. Manage yours with your AI assistant or the dashboard.
          </p>
        </div>

        <div v-for="column in COLUMNS" :key="column.title">
          <div class="mb-3.5 text-[11px] font-bold uppercase tracking-[0.18em] text-dimmed">{{ column.title }}</div>
          <ul class="flex list-none flex-col gap-2.5 p-0">
            <li v-for="link in column.links" :key="link.to">
              <NuxtLink :to="link.to" class="text-[14px] text-muted no-underline transition-colors hover:text-default">
                {{ link.label }}
              </NuxtLink>
            </li>
          </ul>
        </div>
      </div>

      <SiteFooterBar name="KrabiClaw" class="border-t border-default pt-6 text-dimmed" />
    </div>
  </footer>
</template>

<script setup lang="ts">
import { KRABICLAW_REPOSITORY_URL } from '~/shared/open-source'

const COLUMNS = [
  {
    title: 'Solutions',
    links: [
      { label: 'Restaurants', to: '/restaurants' },
      { label: 'Experiences', to: '/experiences' },
      { label: 'Law firms', to: '/legal' },
    ],
  },
  {
    title: 'Product',
    links: [
      { label: 'MCP', to: '/plugin' },
      { label: 'Products', to: '/products' },
      { label: 'Pricing', to: '/pricing' },
      { label: 'Templates', to: '/templates' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', to: '/about' },
      { label: 'Blog', to: '/blog' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Docs', to: '/docs' },
      { label: 'Help center', to: '/help' },
      { label: 'GitHub', to: KRABICLAW_REPOSITORY_URL },
    ],
  },
] as const

</script>
