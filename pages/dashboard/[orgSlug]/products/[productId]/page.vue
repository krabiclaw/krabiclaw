<template>
  <!--
    Page content for a service that has no page yet. A page is edited in one
    place, Pages; once this product has one, its Page content row opens it
    there. Nothing is created by opening this.
  -->
  <DashboardIndexPanel id="product-page" :title="p.sectionLabels['page']">
    <UAlert v-if="p.loadError.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.loadError.value" />
    <UEmpty
      v-else-if="p.product.value?.page"
      icon="i-lucide-file-text"
      :title="p.product.value.page.title"
      :actions="[{ label: 'Edit page content', to: `/dashboard/${String(route.params.orgSlug)}/website/pages/${encodeURIComponent(p.product.value.page.id)}` }]"
    />
    <UEmpty
      v-else
      icon="i-lucide-file-text"
      title="No page"
      :actions="[{ label: 'Create page', icon: 'i-lucide-plus', loading: p.saving.value, onClick: p.createPage }]"
    >
      <UAlert v-if="p.saveError.value" class="text-left" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.saveError.value" />
    </UEmpty>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
</script>
