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
    :error="p.loadError.value || removeError || p.saveError.value || mappingError"
    @cancel="cancel"
    @save="save"
  >
    <div v-if="option" class="space-y-6">
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
      <template v-if="requiresMapping">
        <UFormField v-for="variant in savedVariants" :key="variant.id ?? variant.key" :label="variant.name">
          <USelect
            :model-value="variant.selections[option.id]"
            :items="option.values.map(value => ({ label: value.value, value: value.id ?? value.value }))"
            :placeholder="`Choose ${option.name || 'a value'}`"
            class="w-full"
            @update:model-value="p.setOptionSelection(variant, option.id, $event as string)"
          />
        </UFormField>
      </template>
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
const savedVariants = computed(() => p.form.variants.filter(variant => variant.id))
const requiresMapping = computed(() => Boolean(option.value && p.product.value && (!p.product.value.options.some(saved => saved.id === option.value!.id) || !p.validChoiceSelections(savedVariants.value))))
const mappingError = computed(() => {
  if (!p.form.options.every(option => option.name.trim() && option.values.length) || p.validChoiceSelections(savedVariants.value)) return ''
  const missing = p.form.options.filter(option => savedVariants.value.some(variant => !option.values.some(value => (value.id ?? value.value) === variant.selections[option.id])))
  if (missing.length) return `Set ${missing.map(option => option.name).join(' and ')} for each saved priced choice before saving.`
  const selections = savedVariants.value.map(variant => JSON.stringify(p.form.options.map(option => variant.selections[option.id])))
  return new Set(selections).size === selections.length ? '' : 'Choose a different combination for each priced choice.'
})

// An option the product does not have is not a page (DESIGN.md).
// Cancel, removal and the saved draft-to-ID transition leave this leaf.
const leaving = ref(false)
watchEffect(() => {
  if (p.product.value && !p.loadError.value && !option.value && !leaving.value) showError(createError({ statusCode: 404, statusMessage: 'Choice not found' }))
})

function cancel() {
  leaving.value = true
  p.revert()
}
async function save() {
  leaving.value = true
  await p.save(level.to.value ?? undefined)
  if (p.saveError.value) leaving.value = false
}

const removeError = ref('')
// Removing commits, because the list it leaves has no Save of its own. A new
// product has nothing to commit yet, so its draft just loses the option.
async function remove() {
  removeError.value = ''
  leaving.value = true
  const options = [...p.form.options]
  const variants = [...p.form.variants]
  p.removeOption(index.value)
  if (!p.isNew.value) {
    if (p.saveDisabled.value) {
      removeError.value = 'Give each choice a name and values, and choose a different combination for each priced choice before saving.'
      p.form.options = options
      p.form.variants = variants
      leaving.value = false
      return
    }
    // A refused save stays here with its reason; Cancel puts the option back.
    await p.save(level.to.value ?? undefined)
    if (p.saveError.value) {
      p.form.options = options
      p.form.variants = variants
      leaving.value = false
    }
    return
  }
  await navigateTo(level.to.value ?? '/dashboard')
}
</script>
