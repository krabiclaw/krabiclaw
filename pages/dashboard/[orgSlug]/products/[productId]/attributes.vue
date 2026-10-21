<template>
  <DashboardIndexPanel id="product-attributes" :title="p.sectionLabels['attributes']">
    <EditorNavigationList :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import type { ProductDetailField } from '~/shared/product-details'
import { STAY_DESCRIPTION_DETAIL_KEYS } from '~/shared/product-details'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const level = useRouteLevel()

function valueSummary(definition: ProductDetailField): string {
  const value = p.isNew.value ? p.form.details[definition.key] : p.product.value?.details[definition.key]
  if (value === undefined) return 'Not provided'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return Array.isArray(value) ? value.join(', ') : String(value)
}

const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'attributes',
    items: p.definitions.value.filter(field => field.key !== 'pricing_note' && !(STAY_DESCRIPTION_DETAIL_KEYS as readonly string[]).includes(field.key) && field.key !== 'house_rules').map((definition) => {
    const summary = valueSummary(definition)
    return { id: definition.id, label: definition.name, icon: definition.icon, summary: summary || undefined, to: p.sectionPath(`attributes/${definition.id}`) }
  }),
}])
</script>
