<template>
  <DashboardIndexPanel v-if="level.child.value" id="product-house-rules" title="House rules" column="leaf">
    <template #leading>
      <DashboardNavbarLeading :to="router.resolve({ path: level.path.value, query: route.query }).fullPath" :disabled="p.saving.value" />
    </template>
    <UAlert v-if="p.loadError.value || p.saveError.value" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.loadError.value || p.saveError.value || ''" />
    <template v-if="p.product.value && !p.loadError.value">
      <ul v-if="savedRules.length" class="mb-8 space-y-3 text-base text-muted">
        <li v-for="(line, index) in savedRules" :key="index" class="whitespace-pre-wrap break-words">{{ line }}</li>
      </ul>
      <EditorNavigationList :groups="groups" :active-item="level.child.value" />
    </template>
  </DashboardIndexPanel>
  <DashboardLeafPanel
    v-else
    id="product-house-rules"
    title="House rules"
    desktop-cancel
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value || Boolean(quietError) || !guestsValid"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save(undefined, 'house-rules')"
  >
    <div v-if="p.product.value?.kind === 'stay' && !p.loadError.value" class="divide-y divide-default">
      <div v-for="rule in toggles" :key="rule.key" class="py-6 first:pt-0">
        <div class="flex items-center justify-between gap-6">
          <p class="text-base text-highlighted">{{ rule.name }}</p>
          <ToggleGroupRoot
            type="single"
            :model-value="p.form.details[rule.key] === true ? 'yes' : p.form.details[rule.key] === false ? 'no' : undefined"
            :disabled="p.saving.value"
            :aria-label="rule.name"
            class="flex shrink-0 gap-3"
            @update:model-value="setRule(rule.key, $event)"
          >
            <ToggleGroupItem value="no" as-child>
              <UButton icon="i-lucide-x" aria-label="No" color="neutral" variant="outline" square class="size-12 justify-center rounded-full data-[state=on]:bg-inverted data-[state=on]:text-inverted" />
            </ToggleGroupItem>
            <ToggleGroupItem value="yes" as-child>
              <UButton icon="i-lucide-check" aria-label="Yes" color="neutral" variant="outline" square class="size-12 justify-center rounded-full data-[state=on]:bg-inverted data-[state=on]:text-inverted" />
            </ToggleGroupItem>
          </ToggleGroupRoot>
        </div>
        <UFormField v-if="rule.key === 'quiet_hours' && p.form.details.quiet_hours === true" :error="quietError" class="mt-5">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label for="stay-quiet-hours-start" class="mb-2 block text-sm font-medium text-highlighted">Start time</label>
              <USelect id="stay-quiet-hours-start" v-model="quietStart" :items="timeItems" placeholder="Choose time" aria-label="Quiet hours start" :disabled="p.saving.value" size="xl" class="w-full" />
            </div>
            <div>
              <label for="stay-quiet-hours-end" class="mb-2 block text-sm font-medium text-highlighted">End time</label>
              <USelect id="stay-quiet-hours-end" v-model="quietEnd" :items="timeItems" placeholder="Choose time" aria-label="Quiet hours end" :disabled="p.saving.value" size="xl" class="w-full" />
            </div>
          </div>
        </UFormField>
      </div>
      <UFormField :error="guestsValid ? undefined : 'Choose between 1 and 99 guests.'" class="py-6">
        <div class="flex items-center justify-between gap-6">
          <label for="house-rules-guests" class="text-base text-highlighted">Number of guests</label>
          <UInputNumber
            id="house-rules-guests"
            :model-value="Number(p.form.max_guests)"
            :min="1"
            :max="99"
            :step="1"
            :disabled="p.saving.value"
            :increment="{ color: 'neutral', variant: 'outline', class: 'rounded-full' }"
            :decrement="{ color: 'neutral', variant: 'outline', class: 'rounded-full' }"
            variant="none"
            class="w-36 shrink-0"
            aria-label="Number of guests"
            @update:model-value="p.form.max_guests = $event == null ? '' : String($event)"
          />
        </div>
      </UFormField>
      <EditorNavigationList :groups="groups" class="[&_.group]:border-0 [&_.group]:py-6" />
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { ToggleGroupItem, ToggleGroupRoot } from 'reka-ui'
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_HOUSE_RULE_TOGGLES, STAY_QUIET_HOUR_TIMES, stayHouseRuleLines } from '~/shared/product-details'
import { stayCheckInWindow } from '~/shared/stay-arrival'
import { formatTime } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const { locale } = useI18n()
type RuleKey = keyof typeof STAY_HOUSE_RULE_TOGGLES
const toggles = Object.entries(STAY_HOUSE_RULE_TOGGLES).map(([key, rule]) => ({ key: key as RuleKey, ...rule }))
const timeItems = STAY_QUIET_HOUR_TIMES.map(value => ({ value, label: value }))
const savedRules = computed(() => p.product.value ? stayHouseRuleLines(p.product.value.details, value => formatTime(value, locale.value)) : [])
const quietError = computed(() => p.form.details.quiet_hours === true && (!STAY_QUIET_HOUR_TIMES.includes(String(p.form.details.quiet_hours_start ?? '')) || !STAY_QUIET_HOUR_TIMES.includes(String(p.form.details.quiet_hours_end ?? '')))
  ? 'Choose a start time and an end time for quiet hours.' : undefined)
const guestsValid = computed(() => Number.isInteger(Number(p.form.max_guests)) && Number(p.form.max_guests) >= 1 && Number(p.form.max_guests) <= 99)
const quietStart = computed({
  get: () => typeof p.form.details.quiet_hours_start === 'string' ? p.form.details.quiet_hours_start : undefined,
  set: (value: string | undefined) => {
    if (value) p.form.details.quiet_hours_start = value
    else Reflect.deleteProperty(p.form.details, 'quiet_hours_start')
  },
})
const quietEnd = computed({
  get: () => typeof p.form.details.quiet_hours_end === 'string' ? p.form.details.quiet_hours_end : undefined,
  set: (value: string | undefined) => {
    if (value) p.form.details.quiet_hours_end = value
    else Reflect.deleteProperty(p.form.details, 'quiet_hours_end')
  },
})
const groups = computed<EditorNavigationGroup[]>(() => [{ id: 'house-rules', items: [
  { id: 'arrival-time', label: 'Check-in & checkout', summary: p.product.value?.stay ? `${stayCheckInWindow(p.product.value.stay.check_in_time, p.product.value.stay.check_in_end_time)} · ${p.product.value.stay.check_out_time}` : undefined, to: p.sectionPath('house-rules/arrival-time') },
  { id: 'additional-rules', label: 'Additional rules', summary: typeof p.product.value?.details.house_rules === 'string' ? p.product.value.details.house_rules : 'Add details', to: p.sectionPath('house-rules/additional-rules') },
] }])

function setRule(key: RuleKey, value: unknown) {
  if (value === 'yes' || value === 'no') p.form.details[key] = value === 'yes'
  else Reflect.deleteProperty(p.form.details, key)
  if (key === 'quiet_hours' && value !== 'yes') {
    Reflect.deleteProperty(p.form.details, 'quiet_hours_start')
    Reflect.deleteProperty(p.form.details, 'quiet_hours_end')
  }
}

watchEffect(() => {
  if (p.product.value && !p.loadError.value && (p.product.value.kind !== 'stay' || level.child.value && !['additional-rules', 'arrival-time'].includes(level.child.value))) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
onBeforeRouteLeave(() => p.revert())
</script>
