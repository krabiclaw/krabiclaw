<template>
  <!-- One option: what it is called and the values a customer picks between. -->
  <DashboardLeafPanel
    id="product-option"
    :desktop-cancel="!p.isNew.value"
    :title="option?.name || 'Choice'"
    lead="Name a choice, such as Size, and add what customers can choose, such as Small and Large."
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || removeError || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save(level.to.value ?? undefined)"
  >
    <div v-if="option && !removing" class="space-y-6">
      <UFormField label="Name">
        <UInput v-model="option.name" placeholder="Size" :maxlength="PRODUCT_LIMITS.optionName" autofocus class="w-full" />
      </UFormField>
      <UFormField label="Choices">
        <UInputTags
          :model-value="option.values.map(value => value.value)"
          placeholder="Add a choice"
          :max="PRODUCT_LIMITS.optionValues"
          :max-length="PRODUCT_LIMITS.optionValue"
          delimiter=","
          :convert-value="value => value.trim()"
          add-on-blur
          add-on-paste
          class="w-full"
          aria-label="Choices"
          @update:model-value="p.setOptionValues(index, $event as string[])"
        />
      </UFormField>
      <UButton color="error" variant="soft" icon="i-lucide-trash-2" :label="`Remove ${option.name || 'choice'}`" :loading="p.saving.value" @click="remove" />
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { PRODUCT_LIMITS } from '~/shared/product-limits'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
// The option's own id, never its position: reordering or renaming cannot make
// a saved link edit a different option.
const optionId = computed(() => String(route.params.optionId))
const index = computed(() => p.form.options.findIndex(entry => entry.id === optionId.value))
const option = computed(() => p.form.options[index.value] ?? null)

// An option the product does not have is not a page (DESIGN.md).
// Removing it empties this leaf on purpose, on the way back to the list.
const removing = ref(false)
watchEffect(() => {
  if (p.product.value && !p.loadError.value && !option.value && !removing.value) showError(createError({ statusCode: 404, statusMessage: 'Choice not found' }))
})

const removeError = ref('')
// Removing commits, because the list it leaves has no Save of its own. A new
// product has nothing to commit yet, so its draft just loses the option.
async function remove() {
  removeError.value = ''
  removing.value = true
  const options = [...p.form.options]
  const variants = [...p.form.variants]
  p.removeOption(index.value)
  if (!p.isNew.value) {
    if (p.saveDisabled.value) {
      removeError.value = 'Every choice needs a name and at least one value before this can be saved.'
      p.form.options = options
      p.form.variants = variants
      removing.value = false
      return
    }
    // A refused save stays here with its reason; Cancel puts the option back.
    await p.save(level.to.value ?? undefined)
    if (p.saveError.value) {
      p.form.options = options
      p.form.variants = variants
      removing.value = false
    }
    return
  }
  await navigateTo(level.to.value ?? '/dashboard')
}
</script>
