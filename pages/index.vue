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
const homePath = template.pageDocuments.recipes.home
const layout = template.layout
</script>

