<template>
  <DashboardIndexPanel id="product-cancellation" :title="p.sectionLabels.cancellation" column="leaf">
    <template v-if="level.child.value" #leading>
      <DashboardNavbarLeading
        :to="router.resolve({ path: level.path.value, query: route.query }).fullPath"
        :disabled="p.saving.value"
      />
    </template>
    <UAlert
      v-if="p.loadError.value || p.saveError.value"
      class="mb-6"
      color="error"
      variant="soft"
      icon="i-lucide-triangle-alert"
      :description="p.loadError.value || p.saveError.value || ''"
    />
    <EditorNavigationList
      v-if="p.product.value && !p.loadError.value"
      :groups="groups"
      :active-item="level.child.value"
      variant="cards"
      class="[&_a]:p-6 [&_a]:shadow-none [&_a:not([aria-current=page])]:border-default"
    >
      <template #summary="{ item }">
        <span class="block text-sm">{{ item.summary }}</span>
        <span class="mt-2 block text-lg font-semibold text-highlighted">{{ selectedPolicy(item.id) }}</span>
      </template>
    </EditorNavigationList>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_CANCELLATION_POLICIES, STAY_LONG_TERM_CANCELLATION_POLICIES } from '~/shared/stay-listing'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const groups = computed(() => [{ id: 'cancellation', items: [
  { id: 'standard', label: 'Short-term stays', summary: 'For less than 28 nights', to: p.sectionPath('cancellation/standard') },
  { id: 'long-term', label: 'Long-term stays', summary: 'For 28 nights or more', to: p.sectionPath('cancellation/long-term') },
] }])

function selectedPolicy(period: string): string {
  if (period === 'standard') {
    const policy = p.form.stay_cancellation_policy
    return policy ? STAY_CANCELLATION_POLICIES[policy].label : 'Not set'
  }
  const policy = p.form.stay_long_term_cancellation_policy
  return policy ? STAY_LONG_TERM_CANCELLATION_POLICIES[policy].label : 'Not set'
}
</script>
