<template>
  <!-- One attribute, edited in its own type: a number typed into a text box arrives as a string the validator refuses. -->
  <DashboardLeafPanel
    id="product-attribute"
    :title="definition?.name ?? ''"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save(level.to.value ?? undefined)"
  >
    <template v-if="definition">
      <UButton v-if="p.saveError.value" label="Use saved details" color="neutral" variant="outline" :disabled="p.saving.value" class="mb-5" @click="p.revert()" />
      <USwitch
        v-if="definition.value_type === 'boolean'"
        :model-value="p.form.details[definition.key] === true"
        :label="definition.name"
        @update:model-value="p.setDetail(definition, $event)"
      />
      <UInputTags
        v-else-if="definition.value_type === 'list.single_line_text'"
        :model-value="p.listValue(definition)"
        placeholder="Add a value"
        delimiter=","
        add-on-blur
        add-on-paste
        :aria-label="definition.name"
        class="w-full"
        @update:model-value="p.setDetail(definition, $event as string[])"
      />
      <UTextarea v-else-if="definition.value_type === 'multi_line_text'" ref="narrative" :model-value="p.textValue(definition)" variant="none" :rows="1" :aria-label="definition.name" :ui="{ base: 'resize-none' }" autofocus class="w-full" @update:model-value="p.setDetail(definition, $event)" />
      <UInput v-else :model-value="p.textValue(definition)" :aria-label="definition.name" autofocus class="w-full" @update:model-value="p.setDetail(definition, $event)" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { isStayFocusedDetail } from '~/shared/product-details'
import { useTextareaAutosize } from '@vueuse/core'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const definition = computed(() => p.definitions.value.find(entry => entry.id === String(route.params.definitionId) && entry.key !== 'tagline' && !isStayFocusedDetail(entry.key)) ?? null)
const narrative = useTemplateRef('narrative')
useTextareaAutosize({ element: computed(() => narrative.value?.textareaRef), input: computed(() => definition.value ? p.textValue(definition.value) : '') })

// An attribute this catalog does not define is not a page (DESIGN.md).
watchEffect(() => {
  if (p.product.value && !p.loadError.value && !definition.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
</script>
