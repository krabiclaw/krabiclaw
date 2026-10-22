<template>
  <DashboardIndexPanel id="product-accessibility" title="Accessibility features" column="leaf">
    <template v-if="level.child.value" #leading><DashboardNavbarLeading :to="router.resolve({ path: level.path.value, query: route.query }).fullPath" :disabled="p.saving.value" /></template>
    <UAlert v-if="p.loadError.value || p.photoError.value" class="mb-6" color="error" variant="soft" :description="p.loadError.value || p.photoError.value || ''" />
    <EditorNavigationList v-else-if="p.product.value?.stay" :groups="groups" :active-item="level.child.value" class="[&_.group]:border-0 [&_.group]:py-6 [&_.font-semibold]:font-normal [&_.font-semibold]:text-base" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_HOME_ACCESSIBILITY_FEATURES } from '~/shared/stay-accessibility'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const groups = computed<EditorNavigationGroup[]>(() => [{ id: 'accessibility', items: (p.product.value?.stay?.accessibility ?? []).map(answer => ({
  id: answer.feature, label: STAY_HOME_ACCESSIBILITY_FEATURES[answer.feature].label,
  summary: answer.available === null ? 'Add details' : answer.available === false ? 'Not available' : `${answer.photo_ids.length} ${answer.photo_ids.length === 1 ? 'photo' : 'photos'}`,
  placeholder: answer.available === null, to: p.sectionPath(`accessibility/${answer.feature}`),
})) }])
watchEffect(() => { if (p.product.value && !p.loadError.value && p.product.value.kind !== 'stay') showNotFound() })
</script>
