<template>
  <DashboardLeafPanel
    id="product-checkout-instruction"
    :title="task ? STAY_CHECKOUT_TASKS[task].label : 'Checkout instruction'"
    desktop-cancel
    :saving="p.saving.value"
    :disabled="!p.arrivalManage.value || !changed || (task === 'additional' && !details.trim())"
    :error="p.loadError.value || p.arrivalError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="save"
  >
    <div v-if="task && p.arrivalDraft.value && !p.arrivalError.value" class="space-y-6">
      <UTextarea v-model="details" :aria-label="STAY_CHECKOUT_TASKS[task].label" :rows="7" :maxlength="STAY_CHECKOUT_DETAILS_LIMIT" :placeholder="task === 'additional' ? 'Describe your request' : 'Add details (optional)'" :disabled="p.saving.value || !p.arrivalManage.value" autofocus class="w-full" />
      <p class="text-sm text-muted">{{ details.length }}/{{ STAY_CHECKOUT_DETAILS_LIMIT }}</p>
      <UButton v-if="existing && p.arrivalManage.value" label="Remove instruction" icon="i-lucide-trash-2" color="neutral" variant="outline" :disabled="p.saving.value" @click="remove" />
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_CHECKOUT_TASKS } from '~/shared/stay-listing'
import { isStayCheckoutTask, STAY_CHECKOUT_DETAILS_LIMIT } from '~/shared/stay-arrival'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const task = computed(() => isStayCheckoutTask(route.params.task) ? route.params.task : null)
const existing = computed(() => p.arrivalHome.value?.checkout_instructions.find(instruction => instruction.task === task.value))
const details = ref('')
// Follow an explicit draft reset or a different task, rather than every
// saved-state read: failed writes retain the text the owner is submitting.
watch([task, () => p.arrivalDraft.value], () => {
  details.value = p.arrivalDraft.value?.checkout_instructions.find(instruction => instruction.task === task.value)?.details ?? ''
}, { immediate: true, flush: 'sync' })
const changed = computed(() => !existing.value || (details.value.trim() || null) !== existing.value.details)
async function save() {
  const selected = task.value
  const draft = p.arrivalDraft.value
  if (!selected || !draft || p.saving.value) return
  const instruction = { task: selected, details: details.value.trim() || null }
  const index = draft.checkout_instructions.findIndex(entry => entry.task === selected)
  if (index === -1) draft.checkout_instructions.push(instruction)
  else draft.checkout_instructions[index] = instruction
  await p.saveArrival(['checkout_instructions'], level.to.value ?? undefined)
}
async function remove() {
  if (p.saving.value || !p.arrivalDraft.value) return
  p.arrivalDraft.value.checkout_instructions = p.arrivalDraft.value.checkout_instructions.filter(instruction => instruction.task !== task.value)
  await p.saveArrival(['checkout_instructions'], level.to.value ?? undefined)
}
watchEffect(() => {
  if (p.product.value && !p.loadError.value && !task.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
onBeforeRouteUpdate((to, from) => { if ('task' in to.params && 'task' in from.params && to.params.task !== from.params.task) p.revert() })
onBeforeRouteLeave(() => p.revert())
</script>
