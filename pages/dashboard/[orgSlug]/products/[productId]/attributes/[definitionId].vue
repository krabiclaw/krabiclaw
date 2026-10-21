<template>
  <!-- One attribute, edited in its own type: a number typed into a text box arrives as a string the validator refuses. -->
  <DashboardLeafPanel
    id="product-attribute"
    :title="definition?.name ?? ''"
    :lead="definition?.description ?? undefined"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save(level.to.value ?? undefined)"
  >
    <template v-if="definition">
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
      <UTextarea v-else-if="definition.value_type === 'multi_line_text'" :model-value="p.textValue(definition)" :rows="4" :aria-label="definition.name" autofocus class="w-full" @update:model-value="p.setDetail(definition, $event)" />
      <UInput v-else :model-value="p.textValue(definition)" :aria-label="definition.name" autofocus class="w-full" @update:model-value="p.setDetail(definition, $event)" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { isStayFocusedDetail } from '~/shared/product-details'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const definition = computed(() => p.definitions.value.find(entry => entry.id === String(route.params.definitionId) && !isStayFocusedDetail(entry.key)) ?? null)

// An attribute this catalog does not define is not a page (DESIGN.md).
watchEffect(() => {
  if (p.product.value && !p.loadError.value && !definition.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
</script>
