<template>
  <DashboardLeafPanel
    id="product-cancellation-policy"
    :title="shortTerm ? 'Short-term stays' : 'Long-term stays'"
    :lead="shortTerm ? 'For less than 28 nights' : 'For 28 nights or more'"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    desktop-cancel
    @cancel="p.revert"
    @save="p.save(level.to.value ?? undefined)"
  >
    <URadioGroup
      v-if="p.product.value && !p.loadError.value"
      :model-value="policy"
      :items="items"
      :aria-label="shortTerm ? 'Short-term cancellation policy' : 'Long-term cancellation policy'"
      :disabled="p.saving.value"
      variant="card"
      indicator="hidden"
      color="neutral"
      :ui="{ wrapper: 'block text-start' }"
      class="w-full"
      @update:model-value="selectPolicy"
    >
      <template #label="{ item }">
        <span class="flex items-center justify-between gap-3">
          <span>{{ item.label }}</span>
          <UPopover v-if="item.detail" :content="{ align: 'end', side: 'bottom' }">
            <UButton
              icon="i-lucide-info"
              :aria-label="`More about ${item.label}`"
              color="neutral"
              variant="ghost"
              square
              :disabled="p.saving.value"
              @click.stop
            />
            <template #content>
              <p class="max-w-72 p-4 text-sm text-highlighted">{{ item.detail }}</p>
            </template>
          </UPopover>
        </span>
      </template>
      <template #description="{ item }">
        <span role="list" class="mt-2 block space-y-2">
          <span v-for="term in item.terms" :key="term" role="listitem" class="flex gap-2">
            <span aria-hidden="true">•</span>
            <span>{{ term }}</span>
          </span>
        </span>
      </template>
    </URadioGroup>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_CANCELLATION_POLICIES, STAY_LONG_TERM_CANCELLATION_POLICIES, type StayCancellationPolicy, type StayLongTermCancellationPolicy } from '~/shared/stay-listing'

definePageMeta({
  layout: 'dashboard',
  validate: route => route.params.period === 'standard' || route.params.period === 'long-term',
})

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const shortTerm = computed(() => route.params.period === 'standard')
const items = computed(() => shortTerm.value
  ? Object.entries(STAY_CANCELLATION_POLICIES).map(([value, info]) => ({ value, label: info.label, terms: info.terms, detail: info.detail }))
  : Object.entries(STAY_LONG_TERM_CANCELLATION_POLICIES).map(([value, info]) => ({ value, label: info.label, terms: info.terms, detail: null })))
const policy = computed(() => (shortTerm.value ? p.form.stay_cancellation_policy : p.form.stay_long_term_cancellation_policy) ?? undefined)

function selectPolicy(value: unknown) {
  if (p.saving.value) return
  if (shortTerm.value) {
    p.form.stay_cancellation_policy = value as StayCancellationPolicy
  } else {
    p.form.stay_long_term_cancellation_policy = value as StayLongTermCancellationPolicy
  }
}

onBeforeRouteLeave(() => { p.revert() })
onBeforeRouteUpdate((to, from) => { if ('period' in to.params && 'period' in from.params && to.params.period !== from.params.period) p.revert() })
</script>
