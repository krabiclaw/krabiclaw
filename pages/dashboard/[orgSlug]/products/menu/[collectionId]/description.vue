<template>
  <DashboardLeafPanel
    id="menu-section-description"
    title="Description"
    :saving="c.saving.value"
    :disabled="c.saveDisabled.value"
    :save-label="c.saveLabel.value"
    :error="c.errorMessage.value"
    @cancel="c.revert"
    @save="c.save"
  >
    <p class="mb-2 text-sm font-semibold text-muted">{{ charactersRemaining }}/2000 available</p>
    <UTextarea ref="descriptionTextarea" v-model="c.form.description" aria-label="Description" variant="none" :rows="1" autoresize :maxlength="PRODUCT_LIMITS.collectionDescription" autofocus class="w-full" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { collectionEditorKey } from '../[collectionId].vue'
import { useResizeObserver } from '@vueuse/core'

definePageMeta({ layout: 'dashboard' })

const c = inject(collectionEditorKey)!
const descriptionTextarea = useTemplateRef('descriptionTextarea')
useResizeObserver(() => descriptionTextarea.value?.textareaRef, () => descriptionTextarea.value?.autoResize())
const charactersRemaining = computed(() => PRODUCT_LIMITS.collectionDescription - (c.form.description?.length ?? 0))
</script>
