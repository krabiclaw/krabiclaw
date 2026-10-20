<template>
  <DashboardIndexPanel id="product-checkout-instruction-choices" title="Choose an instruction" column="leaf">
    <UAlert v-if="p.arrivalError.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.arrivalError.value" />
    <div v-if="p.arrivalHome.value && !p.arrivalError.value" class="space-y-4">
      <UButton v-for="task in choices" :key="task.value" :to="p.sectionPath(`checkout-instructions/${task.value}`)" :icon="task.icon" :label="task.label" :disabled="p.saving.value || !p.arrivalManage.value" color="neutral" variant="outline" class="w-full justify-start gap-6 rounded-xl px-6 py-6 text-base" :ui="{ leadingIcon: 'size-7' }" />
      <p v-if="!choices.length" class="text-base text-muted">All checkout instructions have been added.</p>
    </div>
    <template #footer><UButton :to="level.to.value ?? undefined" label="Cancel" color="neutral" variant="link" :disabled="p.saving.value" class="px-0 font-semibold text-highlighted" @click="p.revert()" /></template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_CHECKOUT_TASKS } from '~/shared/stay-listing'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const choices = computed(() => Object.entries(STAY_CHECKOUT_TASKS).filter(([value]) => !p.arrivalHome.value?.checkout_instructions.some(instruction => instruction.task === value)).map(([value, task]) => ({ value, ...task })))
</script>
