<template>
  <DashboardIndexPanel id="product-guest-safety" title="Guest safety" lead="These safety details appear on your listing." column="leaf">
    <template v-if="level.child.value" #leading>
      <DashboardNavbarLeading :to="router.resolve({ path: level.path.value, query: route.query }).fullPath" :disabled="p.saving.value" />
    </template>
    <UAlert v-if="!level.child.value && (p.loadError.value || p.saveError.value)" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.loadError.value || p.saveError.value || ''" />
    <EditorNavigationList
      v-if="p.product.value?.kind === 'stay' && !p.loadError.value"
      :groups="groups"
      :active-item="level.child.value"
      class="[&_.group]:border-0 [&_.group]:py-6 [&_.font-semibold]:font-normal [&_.font-semibold]:text-base [&_.line-clamp-2]:whitespace-pre-line [&_.line-clamp-2]:break-words"
    />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_SAFETY_SECTIONS, staySafetyLines, stayAlarmLines, type StaySafetySection } from '~/shared/stay-safety'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const groups = computed<EditorNavigationGroup[]>(() => [{ id: 'guest-safety', items: (Object.keys(STAY_SAFETY_SECTIONS) as StaySafetySection[]).map((section) => {
  const product = p.product.value
  const lines = product ? [
    ...staySafetyLines(product.details, { section, includeNo: true }),
    ...(section === 'devices' ? stayAlarmLines(product.stay!.amenity_answers, product.details) : []),
  ] : []
  return { id: section, label: STAY_SAFETY_SECTIONS[section].label, summary: lines.join('\n') || 'Not provided', placeholder: !lines.length, to: p.sectionPath(`guest-safety/${section}`) }
}) }])
watchEffect(() => {
  if (p.product.value && !p.loadError.value && p.product.value.kind !== 'stay') showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
</script>
