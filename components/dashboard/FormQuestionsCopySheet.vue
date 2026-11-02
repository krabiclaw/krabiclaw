<template>
  <DashboardListItemDialog
    v-model:open="open"
    title="Copy questions"
    :saving="saving"
    :save-disabled="!chosen || saving"
    :save-label="chosen ? `Copy ${chosen.questions.length} ${chosen.questions.length === 1 ? 'question' : 'questions'}` : 'Copy'"
    :error="error"
    @save="copy"
  >
    <p class="text-sm text-muted">Adds a copy of another form’s questions after these. Later edits to either form stay separate.</p>
    <p v-if="loading" class="text-sm text-muted" role="status">Loading your forms…</p>
    <URadioGroup v-else-if="sources.length" v-model="chosenKey" :items="sources.map(source => ({ value: source.key, label: source.label, description: source.description }))" variant="card" color="neutral" aria-label="Copy from" />
    <p v-else-if="!error" class="text-sm text-muted">No other form has questions yet.</p>
    <template #actions><UButton label="Cancel" color="neutral" variant="ghost" :disabled="saving" @click="open = false" /></template>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import type { FormQuestionsOwner } from '~/composables/useFormQuestionsOwner'
import type { Product } from '~/server/types/products'
import type { LocationReservationConfig } from '~/server/utils/reservations'
import type { FormQuestion } from '~/shared/form-questions'
import { formQuestionCopy, formQuestionsSummary } from '~/utils/form-question-editing'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ owner: FormQuestionsOwner }>()
const open = defineModel<boolean>('open', { default: false })
interface Source { key: string; label: string; description: string; questions: FormQuestion[] }

const dashboardApi = useDashboardApi()
const dashboard = useDashboardOrganization()
const organizationId = await useDashboardOrganizationId()
const sources = ref<Source[]>([])
const chosenKey = ref<string | undefined>()
const chosen = computed(() => sources.value.find(source => source.key === chosenKey.value) ?? null)
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

// The organization's other forms are read when the sheet opens, so it offers what they ask now.
watch(open, async (isOpen) => {
  if (!isOpen) return
  chosenKey.value = undefined
  error.value = null
  loading.value = true
  try {
    const [settings, catalog, reservations] = await Promise.all([
      dashboardApi<{ settings: { inquiry_questions: FormQuestion[] } }>('/api/dashboard/settings', { validate: (value: unknown): value is { settings: { inquiry_questions: FormQuestion[] } } => isRecord(value) && isRecord(value.settings) && Array.isArray(value.settings.inquiry_questions) }),
      dashboardApi<{ products: Product[] }>(`/api/editor/organizations/${organizationId}/products`, { validate: (value: unknown): value is { products: Product[] } => isRecord(value) && Array.isArray(value.products) }),
      Promise.all(dashboard.locations.value.map(async location => ({
        location,
        config: (await dashboardApi<{ config: LocationReservationConfig | null }>(`/api/editor/organizations/${organizationId}/locations/${location.id}/reservation-config`, { validate: (value: unknown): value is { config: LocationReservationConfig | null } => isRecord(value) && (value.config === null || isRecord(value.config)) })).config,
      }))),
    ])
    sources.value = [
      { key: 'inquiry', label: 'Website inquiry form', description: formQuestionsSummary(settings.settings.inquiry_questions), questions: settings.settings.inquiry_questions },
      ...catalog.products.flatMap(product => [
        ...(product.booking ? [{ key: `booking:${product.id}`, label: product.name, description: `Booking · ${formQuestionsSummary(product.booking.questions)}`, questions: product.booking.questions }] : []),
        ...(product.stay ? [{ key: `stay:${product.id}`, label: product.name, description: `Home · ${formQuestionsSummary(product.stay.questions)}`, questions: product.stay.questions }] : []),
      ]),
      ...reservations.flatMap(({ location, config }) => config ? [{ key: `reservations:${location.id}`, label: location.title, description: `Reservations · ${formQuestionsSummary(config.questions)}`, questions: config.questions }] : []),
    ].filter(source => source.key !== props.owner.key && source.questions.length)
  } catch (failure) {
    error.value = getErrorMessage(failure, 'Your other forms could not be read')
  } finally {
    loading.value = false
  }
})

async function copy() {
  if (!chosen.value || saving.value) return
  saving.value = true
  error.value = null
  try {
    await props.owner.write([...props.owner.questions.value ?? [], ...chosen.value.questions.map(formQuestionCopy)])
    open.value = false
  } catch (failure) {
    error.value = getErrorMessage(failure, 'The questions could not be copied')
  } finally {
    saving.value = false
  }
}
</script>
