<template>
  <StayAccessibilityFeatureEditor
    panel-id="product-accessibility-feature"
    :context-key="`${String(route.params.productId)}:${feature}`"
    :context-label="p.product.value?.name ?? ''"
    :organization-id="p.organizationId"
    :definition="definition"
    :answer="answer"
    :snapshot-token="p.product.value?.updated_at ?? null"
    :photos="p.photoAssets.value"
    :saving="p.saving.value"
    :load-error="p.loadError.value"
    :error="p.photoError.value"
    :close-to="level.to.value ?? undefined"
    :commit="commit"
    @reset-error="p.photoError.value = null"
  />
</template>

<script setup lang="ts">
import StayAccessibilityFeatureEditor from '~/components/dashboard/StayAccessibilityFeatureEditor.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_HOME_ACCESSIBILITY_FEATURES, isStayHomeAccessibilityFeature } from '~/shared/stay-accessibility'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const feature = computed(() => {
  if (!isStayHomeAccessibilityFeature(route.params.feature)) throw createError({ statusCode: 404, statusMessage: 'Accessibility feature not found' })
  return route.params.feature
})
const definition = computed(() => STAY_HOME_ACCESSIBILITY_FEATURES[feature.value])
const answer = computed(() => {
  if (!p.product.value?.stay) return null
  const saved = p.product.value.stay.accessibility.find(answer => answer.feature === feature.value)
  if (!saved) throw createError({ statusCode: 500, statusMessage: 'The listing accessibility details could not be read' })
  return saved
})
async function commit(value: { available: boolean | null; photo_ids: string[] }, token: string | number) {
  if (typeof token !== 'string') throw new Error('The listing version could not be read')
  return await p.updateStayAccessibility({ feature: feature.value, ...value }, token)
}
watchEffect(() => { if (p.product.value && !p.loadError.value && p.product.value.kind !== 'stay') showNotFound() })
</script>
