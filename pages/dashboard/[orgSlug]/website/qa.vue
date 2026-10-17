<template>
  <DashboardIndexPanel id="organization-qa" title="Reviews and Q&A">
    <div>
      <DashboardFilterPills
        id="qa-tab"
        v-model="tab"
        label="Reviews and Q&A"
        :items="tabs"
        role="tablist"
        class="mb-8"
      />
      <QaList v-if="tab === 'qa'" />
      <TestimonialList v-else />
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import QaList from '~/components/dashboard/QaList.vue'
import TestimonialList from '~/components/dashboard/TestimonialList.vue'

// A row on Website: Website is both its pane and its Back.
definePageMeta({ layout: 'dashboard' })

const route = useRoute()


// One surface for the trust content a guest reads: the questions a tenant
// answers and the reviews they import or enter. Two tables, one card.
const tabs = [
  { label: 'Q&A', value: 'qa' },
  { label: 'Reviews', value: 'reviews' },
]
// The open tab lives in the URL. A review is a level below this one, so while
// one is open the tab is Reviews, and Back from it — which leads here, with no
// query of its own — puts `tab=reviews` back rather than landing on Q&A.
const router = useRouter()
const level = useRouteLevel()
const reviewsTab = useState(`qa-reviews-tab-${String(route.params.orgSlug)}-${String(route.query.location_id ?? '')}`, () => false)
const tab = computed<string>({
  get: () => (route.query.tab === 'reviews' || route.params.reviewId ? 'reviews' : 'qa'),
  set: (value: string) => {
    reviewsTab.value = value === 'reviews'
    void router.replace({ query: { ...route.query, tab: value === 'reviews' ? 'reviews' : undefined } })
  },
})
watch([() => route.params.reviewId, () => route.params.qaId, level.mode], ([reviewId, qaId, mode]) => {
  if (reviewId) reviewsTab.value = true
  else if (qaId) reviewsTab.value = false
  else if (mode === 'index' && reviewsTab.value && route.query.tab === undefined) void router.replace({ query: { ...route.query, tab: 'reviews' } })
}, { immediate: true })

useSeoMeta({ title: 'Reviews and Q&A | KrabiClaw', robots: 'noindex, nofollow' })
</script>
