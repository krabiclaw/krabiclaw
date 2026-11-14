<template>
  <div class="space-y-3">
    <UFormField label="Note">
      <UInput :model-value="calculatorNote" class="w-full" @update:model-value="setCalculatorNote($event)" />
    </UFormField>
    <div class="grid gap-2 text-xs text-muted lg:grid-cols-4">
      <span v-for="label in PRICING_CALCULATOR_COLUMNS" :key="label">{{ label }}</span>
    </div>
    <div v-for="(row, rowIndex) in calculatorRows" :key="rowIndex" class="grid gap-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
      <UInput :model-value="cellValue(row, 0)" type="number" min="1" max="8" aria-label="Household size" @update:model-value="setCalculatorCell(rowIndex, 0, $event)" />
      <UInput :model-value="cellValue(row, 1)" type="number" aria-label="250 percent limit" placeholder="250%" @update:model-value="setCalculatorCell(rowIndex, 1, $event)" />
      <UInput :model-value="cellValue(row, 2)" type="number" aria-label="350 percent limit" placeholder="350%" @update:model-value="setCalculatorCell(rowIndex, 2, $event)" />
      <UInput :model-value="cellValue(row, 3)" type="number" aria-label="400 percent limit" placeholder="400%" @update:model-value="setCalculatorCell(rowIndex, 3, $event)" />
      <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="xs" square aria-label="Remove calculator row" @click="removeCalculatorRow(rowIndex)" />
    </div>
    <UButton icon="i-lucide-plus" color="neutral" variant="soft" size="sm" @click="addCalculatorRow">Add row</UButton>
  </div>
</template>

<script setup lang="ts">
import { PRICING_CALCULATOR_COLUMNS, pricingCalculatorConfig, pricingCalculatorRows, updatePricingCalculator } from '~/utils/pricing-calculator'
import { useTenantPageBlock } from '~/composables/useTenantPageDraft'

/** The income table a pricing calculator reads, which is a grid and not a field. */
const props = defineProps<{ organizationId: string; pageId: string; blockId: string }>()
const block = useTenantPageBlock(props.organizationId, props.pageId, () => props.blockId)

const config = computed(() => pricingCalculatorConfig(block.value.data.calculator))
const calculatorRows = computed(() => pricingCalculatorRows(config.value))
const calculatorNote = computed(() => String(config.value.note ?? ''))

function setCalculator(rows: unknown[][], note = calculatorNote.value) {
  block.value.data.calculator = updatePricingCalculator(config.value, rows, note)
}

function setCalculatorNote(value: unknown) {
  setCalculator(calculatorRows.value, String(value ?? ''))
}

function cellValue(row: unknown[], index: number): string {
  return row[index] == null ? '' : String(row[index])
}

function setCalculatorCell(rowIndex: number, cellIndex: number, value: unknown) {
  const rows = calculatorRows.value
  const row = rows[rowIndex] ?? []
  while (row.length <= cellIndex) row.push('')
  row[cellIndex] = value == null ? '' : String(value)
  rows[rowIndex] = row
  setCalculator(rows)
}

function addCalculatorRow() {
  setCalculator([...calculatorRows.value, [calculatorRows.value.length + 1, '', '', '']])
}

function removeCalculatorRow(index: number) {
  setCalculator(calculatorRows.value.filter((_, rowIndex) => rowIndex !== index))
}

</script>
