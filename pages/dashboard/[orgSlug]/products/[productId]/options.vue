<template>
  <!--
    Options as a list: each option is a row previewing its values and opening
    its own leaf, and each combination a customer can buy is a row carrying its
    price (DESIGN.md: a pane that would need many fields becomes an index).
  -->
  <DashboardIndexPanel id="product-options" :title="p.sectionLabels['options']">
    <p class="mb-6 text-sm text-muted">Offer different versions, such as sizes or session types. Add a choice such as Size, then set a price for each variant.</p>
    <EditorNavigationList :groups="groups" :active-item="activeItem" @act="act" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()

const groups = computed<EditorNavigationGroup[]>(() => [
  {
    id: 'options',
    items: [
      // Addressed by the option's own id — a draft's until it is saved — so a
      // saved link keeps naming the same option after a reorder or a rename.
      ...p.form.options.map(option => ({
        id: `option-${option.id}`,
        label: option.name || 'Choice',
        summary: option.values.map(value => value.value).join(', ') || undefined,
        to: p.sectionPath(`options/${encodeURIComponent(option.id)}`),
      })),
      ...(p.form.options.length < PRODUCT_LIMITS.options ? [{ id: 'add', icon: 'i-lucide-plus', label: 'Add a choice', action: {} }] : []),
    ],
  },
  ...(p.form.variants.length > 1
    ? [{
        id: 'combinations',
        // A combination is priced by its saved variant's id; one not yet saved
        // has no id to address and opens once the choices are saved.
        items: p.form.variants.map(variant => ({
          id: `price-${variant.id ?? variant.key}`,
          label: variant.name,
          summary: variant.price_major ? `${variant.price_major} ${p.currency}` : undefined,
          ...(variant.id ? { to: p.sectionPath(`options/prices/${encodeURIComponent(variant.id)}`) } : {}),
        })),
      }]
    : []),
])

const activeItem = computed(() => {
  if (typeof route.params.optionId === 'string') return `option-${route.params.optionId}`
  if (typeof route.params.variantId === 'string') return `price-${route.params.variantId}`
  return null
})

// Adding an option is a draft until its own leaf saves it.
function act(id: string) {
  if (id !== 'add') return
  p.addOption()
  void navigateTo(p.sectionPath(`options/${encodeURIComponent(p.form.options.at(-1)!.id)}`))
}
</script>
