<template>
  <DashboardLeafPanel
    id="product-guest-safety-detail"
    :title="detail?.title ?? 'Safety details'"
    :lead="detail?.description"
    :saving="continuing || p.saving.value"
    :disabled="!detail || draft.length > STAY_SAFETY_DETAILS_LIMIT || Boolean(p.loadError.value)"
    :error="p.loadError.value || error"
    save-label="Continue"
    desktop-cancel
    @cancel="cancel"
    @save="continueDraft"
  >
    <template v-if="detail && !p.loadError.value">
      <UFormField :label="detail.title" :hint="`${draft.length}/${STAY_SAFETY_DETAILS_LIMIT}`">
        <UTextarea v-model="draft" :aria-label="detail.title" :rows="6" :maxlength="STAY_SAFETY_DETAILS_LIMIT" :disabled="continuing || p.saving.value" autofocus class="w-full" />
      </UFormField>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { isNavigationFailure } from 'vue-router'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_SAFETY_SECTIONS, STAY_SAFETY_FIELDS, STAY_SAFETY_DETAIL_FIELDS, STAY_SAFETY_DETAILS_LIMIT, type StaySafetyDetailKey, type StaySafetySection } from '~/shared/stay-safety'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const detail = computed(() => {
  const section = String(route.params.section)
  if (!Object.hasOwn(STAY_SAFETY_SECTIONS, section)) return null
  const group = STAY_SAFETY_SECTIONS[section as StaySafetySection]
  const key = String(route.params.field)
  const flag = group.fields.find(flag => STAY_SAFETY_FIELDS[flag].detailsKey === key)
  if (flag && p.form.details[flag] === true) return { key: STAY_SAFETY_FIELDS[flag].detailsKey, title: STAY_SAFETY_FIELDS[flag].name, description: STAY_SAFETY_FIELDS[flag].description }
  if ('textKey' in group && group.textKey === key) return { key: group.textKey, title: STAY_SAFETY_DETAIL_FIELDS[group.textKey].name, description: STAY_SAFETY_DETAIL_FIELDS[group.textKey].description }
  return null
})
const entry = ref<string | undefined>()
const draft = ref('')
const error = ref('')
const continuing = ref(false)
watch(() => [route.params.productId, detail.value?.key], () => {
  const value = detail.value ? p.form.details[detail.value.key] : undefined
  entry.value = typeof value === 'string' ? value : undefined
  draft.value = entry.value ?? ''
  error.value = ''
}, { immediate: true })

function restoreEntry(key: StaySafetyDetailKey) {
  if (entry.value === undefined) Reflect.deleteProperty(p.form.details, key)
  else p.form.details[key] = entry.value
}
function cancel() {
  if (detail.value) restoreEntry(detail.value.key)
  draft.value = entry.value ?? ''
  error.value = ''
}
async function continueDraft() {
  if (!detail.value || draft.value.length > STAY_SAFETY_DETAILS_LIMIT || continuing.value) return
  const key = detail.value.key
  const text = draft.value
  continuing.value = true
  error.value = ''
  if (text.trim()) p.form.details[key] = text
  else Reflect.deleteProperty(p.form.details, key)
  try {
    if (!level.to.value) throw new Error('The safety section could not be found.')
    const result = await navigateTo(level.to.value)
    if (isNavigationFailure(result)) throw result
  } catch (cause) {
    restoreEntry(key)
    error.value = getErrorMessage(cause, 'The safety details could not be continued')
  } finally {
    continuing.value = false
  }
}
watchEffect(() => {
  if (p.product.value && !p.loadError.value && (p.product.value.kind !== 'stay' || !detail.value)) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
</script>
