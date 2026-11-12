<template>
  <GuidedStayHome v-if="guided" />
  <ProductEditorPage v-else />
</template>

<script setup lang="ts">
import GuidedStayHome from '~/components/dashboard/GuidedStayHome.vue'
import ProductEditorPage from '~/components/dashboard/ProductEditorPage.vue'

const route = useRoute()
const guided = computed(() => route.params.product_id === 'new' && route.query.kind === 'stay' && route.query.setup === 'guided')

definePageMeta({
  layout: 'dashboard', dashboardFrame: true,
  key: route => JSON.stringify([route.params.org_slug, route.params.product_id, ...(route.params.product_id === 'new' ? [route.query.kind ?? null, route.query.setup ?? null, route.query.location_id ?? null, route.query.collection_id ?? null] : [])]),
})
</script>
