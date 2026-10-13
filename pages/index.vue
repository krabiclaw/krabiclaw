<template>
  <NuxtLayout :name="layout">
    <!--
      Every home is its page document, drawn block by block like every other
      page on the site. Each template used to have its own home component that
      composed a fixed list of sections — Saya's read no blocks at all — so the
      one page every visitor lands on was the one page its owner could not edit.
    -->
    <TenantPublicPage :path="homePath" />
  </NuxtLayout>
</template>

<script setup lang="ts">
definePageMeta({ layout: false })

const { template } = useTenantOrganization().organization
const isPlatform = template.slug === 'platform'
const homePath = template.pageDocuments.recipes.home
const layout = template.layout

// A signed-in owner has no use for the platform's own sales pitch, and showing
// it to them is how a returning owner ends up clicking "Start free" and opening
// a second account. The marketing homepage is for people who do not have an
// account yet; everyone else goes to their dashboard. Anonymous visitors and
// crawlers are untouched, so the cached public page is unchanged: a request
// carrying a session cookie bypasses the edge cache (00.edge-cache.ts).
// The session is read through applicationFetch, which forwards the visitor's
// cookie during SSR, so the server answers a hard load with the 302 and the
// client covers in-app navigation to `/`.
if (isPlatform) {
  const session = await applicationFetch<{ user?: { id?: string } } | null>('/api/auth/get-session', {
    validate: (value): value is { user?: { id?: string } } | null => value === null || typeof value === 'object',
  })
  if (session?.user?.id) await navigateTo('/api/post-login', { external: true, redirectCode: 302 })
}
</script>
