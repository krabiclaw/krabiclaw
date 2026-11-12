<template>
  <DashboardIndexPanel id="organization-qa" title="Q&A">
    <QaList />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import QaList from '~/components/dashboard/QaList.vue'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
if (route.query.tab === 'reviews') {
  const locationQuery = route.query.location_id ? `?location_id=${encodeURIComponent(String(route.query.location_id))}` : ''
  await navigateTo(`/dashboard/${encodeURIComponent(String(route.params.org_slug))}/website/reviews${locationQuery}`, { replace: true })
}

useSeoMeta({ title: 'Q&A | KrabiClaw', robots: 'noindex, nofollow' })
</script>
