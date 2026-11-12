<template>
  <DashboardLeafPanel
    id="product-description-section"
    :title="title"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value || !validSection || value.length > PRODUCT_LIMITS.description"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    desktop-cancel
    @cancel="p.revert"
    @save="p.save(level.to.value ?? undefined)"
  >
    <template v-if="validSection && p.product.value && !p.loadError.value">
      <UButton v-if="p.saveError.value" label="Use saved details" color="neutral" variant="outline" :disabled="p.saving.value" class="mb-5" @click="p.revert()" />
      <p class="mb-2 text-sm font-semibold text-muted" data-testid="stay-description-counter">{{ PRODUCT_LIMITS.description - value.length }}/{{ PRODUCT_LIMITS.description }} available</p>
      <UTextarea
        ref="descriptionTextarea"
        v-model="value"
        :aria-label="title"
        :data-testid="`stay-description-${section}`"
        variant="none"
        :rows="1"
        :maxlength="PRODUCT_LIMITS.description"
        :disabled="p.saving.value"
        :ui="{ base: 'resize-none' }"
        autofocus
        class="w-full"
      />
      <UFormField v-if="listingDescription && introduction" label="Short introduction" hint="Optional" class="mt-8">
        <UInput :model-value="p.textValue(introduction)" class="w-full" @update:model-value="p.setDetail(introduction, $event)" />
      </UFormField>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useTextareaAutosize } from '@vueuse/core'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { productDetailFields, STAY_DESCRIPTION_DETAIL_KEYS } from '~/shared/product-details'
import { PRODUCT_LIMITS } from '~/shared/product-limits'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const section = computed(() => String(route.params.section))
const descriptionFields = productDetailFields('stay').filter(field => (STAY_DESCRIPTION_DETAIL_KEYS as readonly string[]).includes(field.key))
const definition = computed(() => descriptionFields.find(field => field.key === section.value) ?? null)
const listingDescription = computed(() => section.value === 'listing-description')
const validSection = computed(() => p.product.value?.kind === 'stay' && (listingDescription.value || Boolean(definition.value)))
const title = computed(() => listingDescription.value ? 'Listing description' : definition.value?.name ?? '')
const descriptionTextarea = useTemplateRef('descriptionTextarea')
const introduction = computed(() => p.definitions.value.find(field => field.key === 'tagline'))
const value = computed({
  get: () => listingDescription.value ? p.form.description : definition.value ? p.textValue(definition.value) : '',
  set: (text: string) => {
    if (listingDescription.value) p.form.description = text
    else if (definition.value) p.setDetail(definition.value, text)
  },
})
useTextareaAutosize({ element: computed(() => descriptionTextarea.value?.textareaRef), input: value })

watchEffect(() => {
  if (p.product.value && !p.loadError.value && !validSection.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})

onBeforeRouteLeave(() => { p.revert() })
onBeforeRouteUpdate((to, from) => {
  if ('section' in to.params && 'section' in from.params && to.params.section !== from.params.section) p.revert()
})
</script>
