<template>
  <DashboardIndexPanel v-if="isStay" id="product-description" title="Description" column="leaf">
    <template v-if="level.child.value" #leading>
      <DashboardNavbarLeading :to="router.resolve({ path: level.path.value, query: route.query }).fullPath" :disabled="p.saving.value" />
    </template>
    <UAlert v-if="p.loadError.value || p.saveError.value" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.loadError.value || p.saveError.value || ''" />
    <EditorNavigationList
      v-if="p.product.value && !p.loadError.value"
      :groups="groups"
      :active-item="level.child.value"
      class="[&_.group]:border-0 [&_.group]:py-6 [&_.font-semibold]:font-normal [&_.font-semibold]:text-base [&_.line-clamp-2]:whitespace-pre-line [&_.line-clamp-2]:break-words"
    />
  </DashboardIndexPanel>
  <DashboardLeafPanel
    v-else
    id="product-description"
    :title="p.sectionLabels.description"
    :desktop-cancel="!p.isNew.value"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || p.photoError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <template v-if="p.isNew.value || p.product.value">
      <UButton v-if="p.saveError.value" label="Use saved details" color="neutral" variant="outline" :disabled="p.saving.value" class="mb-5" @click="p.revert()" />
      <p class="mb-2 text-sm font-semibold text-muted">{{ charactersRemaining }}/{{ PRODUCT_LIMITS.description }} available</p>
      <UTextarea ref="descriptionTextarea" v-model="p.form.description" :aria-label="p.sectionLabels.description" variant="none" :rows="1" :maxlength="PRODUCT_LIMITS.description" :ui="{ base: 'resize-none' }" autofocus class="w-full" />
      <UFormField v-if="introduction" label="Short introduction" hint="Optional" class="mt-8">
        <UInput :model-value="p.textValue(introduction)" class="w-full" @update:model-value="p.setDetail(introduction, $event)" />
      </UFormField>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useTextareaAutosize } from '@vueuse/core'
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { productDetailFields, STAY_DESCRIPTION_DETAIL_KEYS } from '~/shared/product-details'
import { PRODUCT_LIMITS } from '~/shared/product-limits'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const isStay = computed(() => p.product.value?.kind === 'stay')
const charactersRemaining = computed(() => PRODUCT_LIMITS.description - p.form.description.length)
const descriptionTextarea = useTemplateRef('descriptionTextarea')
useTextareaAutosize({ element: computed(() => descriptionTextarea.value?.textareaRef), input: computed(() => p.form.description) })
const introduction = computed(() => p.definitions.value.find(field => field.key === 'tagline'))
const descriptionFields = productDetailFields('stay').filter(field => (STAY_DESCRIPTION_DETAIL_KEYS as readonly string[]).includes(field.key))
const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'description',
  items: [
    { id: 'listing-description', label: 'Listing description', summary: p.product.value?.description || undefined, to: p.sectionPath('description/listing-description') },
    ...descriptionFields.map(field => {
      const value = p.product.value?.details[field.key]
      return { id: field.key, label: field.name, summary: typeof value === 'string' ? value : undefined, to: p.sectionPath(`description/${field.key}`) }
    }),
  ],
}])

watchEffect(() => {
  if (p.product.value && !p.loadError.value && !isStay.value && level.child.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})

onBeforeRouteLeave(() => { if (isStay.value) p.revert() })
</script>
