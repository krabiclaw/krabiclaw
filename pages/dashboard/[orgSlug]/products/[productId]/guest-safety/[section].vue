<template>
  <DashboardIndexPanel v-if="level.child.value" id="product-guest-safety-section" :title="group?.label ?? 'Guest safety'" column="leaf">
    <template #leading>
      <DashboardNavbarLeading :to="router.resolve({ path: level.path.value, query: route.query }).fullPath" :disabled="p.saving.value" />
    </template>
    <UAlert v-if="p.loadError.value || p.saveError.value" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.loadError.value || p.saveError.value || ''" />
    <EditorNavigationList v-if="group && !p.loadError.value" :groups="detailGroups" :active-item="level.child.value" />
  </DashboardIndexPanel>
  <DashboardLeafPanel
    v-else
    id="product-guest-safety-section"
    :title="group?.label ?? 'Guest safety'"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value || !section || Boolean(detailsError)"
    :error="p.loadError.value || p.saveError.value || detailsError"
    desktop-cancel
    @cancel="revert"
    @save="save"
  >
    <div v-if="group && p.product.value?.kind === 'stay' && !p.loadError.value" class="divide-y divide-default">
      <div v-for="field in fields" :key="field.key" class="py-6 first:pt-0">
        <div class="flex items-center justify-between gap-6">
          <div class="min-w-0">
            <p class="text-base text-highlighted">{{ field.name }}</p>
            <p class="mt-2 text-sm text-muted">{{ field.description }}</p>
          </div>
          <ToggleGroupRoot
            type="single"
            :model-value="p.form.details[field.key] === true ? 'yes' : p.form.details[field.key] === false ? 'no' : undefined"
            :disabled="p.saving.value"
            :aria-label="field.name"
            class="flex shrink-0 gap-3"
            @update:model-value="setFlag(field.key, $event)"
          >
            <ToggleGroupItem value="no" as-child>
              <UButton icon="i-lucide-x" aria-label="No" color="neutral" variant="outline" square class="size-12 justify-center rounded-full data-[state=on]:bg-inverted data-[state=on]:text-inverted" />
            </ToggleGroupItem>
            <ToggleGroupItem value="yes" as-child>
              <UButton icon="i-lucide-check" aria-label="Yes" color="neutral" variant="outline" square class="size-12 justify-center rounded-full data-[state=on]:bg-inverted data-[state=on]:text-inverted" />
            </ToggleGroupItem>
          </ToggleGroupRoot>
        </div>
        <div v-if="p.form.details[field.key] === true" class="mt-4">
          <p v-if="typeof p.form.details[field.detailsKey] === 'string'" class="mb-2 whitespace-pre-wrap break-words text-sm text-muted">{{ p.form.details[field.detailsKey] }}</p>
          <UButton :to="p.sectionPath(`guest-safety/${section}/${field.detailsKey}`)" :label="p.form.details[field.detailsKey] ? 'Edit details' : 'Add details'" :aria-label="`${field.name} details`" color="neutral" variant="link" :disabled="p.saving.value" class="px-0 underline" />
        </div>
      </div>
      <div v-if="textKey" class="py-6">
        <h2 class="text-base text-highlighted">{{ STAY_SAFETY_DETAIL_FIELDS[textKey].name }}</h2>
        <p v-if="typeof p.form.details[textKey] === 'string'" class="mt-2 whitespace-pre-wrap break-words text-sm text-muted">{{ p.form.details[textKey] }}</p>
        <UButton :to="p.sectionPath(`guest-safety/${section}/${textKey}`)" :label="p.form.details[textKey] ? 'Edit details' : 'Add details'" :aria-label="STAY_SAFETY_DETAIL_FIELDS[textKey].name" color="neutral" variant="link" :disabled="p.saving.value" class="mt-2 px-0 underline" />
      </div>
      <div v-if="section === 'devices'" class="space-y-5 py-6">
        <dl class="space-y-4">
          <div v-for="alarm in alarms" :key="alarm.code" class="flex items-center justify-between gap-6">
            <dt class="text-base text-highlighted">{{ alarm.label }}</dt>
            <dd class="text-sm text-muted">{{ alarm.reported ? 'Reported' : 'Not reported' }}</dd>
          </div>
        </dl>
        <UButton :to="alarmsTo" label="Edit alarms in Amenities" color="neutral" variant="link" :disabled="p.saving.value" class="px-0 underline" />
      </div>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { ToggleGroupItem, ToggleGroupRoot } from 'reka-ui'
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_SAFETY_SECTIONS, STAY_SAFETY_FIELDS, STAY_SAFETY_DETAIL_FIELDS, STAY_SAFETY_DETAILS_LIMIT, staySafetySectionKeys, type StaySafetyFlag, type StaySafetySection } from '~/shared/stay-safety'
import { STAY_AMENITIES } from '~/shared/stay-listing'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const section = computed<StaySafetySection | null>(() => Object.hasOwn(STAY_SAFETY_SECTIONS, String(route.params.section)) ? String(route.params.section) as StaySafetySection : null)
const group = computed(() => section.value ? STAY_SAFETY_SECTIONS[section.value] : null)
const fields = computed(() => group.value?.fields.map(key => ({ key, ...STAY_SAFETY_FIELDS[key] })) ?? [])
const textKey = computed(() => group.value && 'textKey' in group.value ? group.value.textKey : null)
const detailsError = computed(() => section.value && staySafetySectionKeys(section.value).some((key) => {
  const value = p.form.details[key]
  return typeof value === 'string' && value.length > STAY_SAFETY_DETAILS_LIMIT
})
  ? `Safety details must be ${STAY_SAFETY_DETAILS_LIMIT} characters or fewer.` : '')
const alarms = computed(() => (['smoke_detector', 'carbon_monoxide_detector'] as const).map(code => ({ code, label: STAY_AMENITIES[code].label, reported: p.product.value?.stay?.amenities.includes(code) === true })))
const alarmsTo = computed(() => {
  const target = router.resolve(p.sectionPath('amenities/add'))
  return { path: target.path, query: { ...target.query, amenity_group: 'home_safety' } }
})
const detailGroups = computed<EditorNavigationGroup[]>(() => {
  const items: EditorNavigationGroup['items'] = fields.value.filter(field => p.form.details[field.key] === true).map((field) => {
    const value = p.form.details[field.detailsKey]
    return { id: field.detailsKey, label: field.name, summary: typeof value === 'string' ? value : 'Add details', to: p.sectionPath(`guest-safety/${section.value}/${field.detailsKey}`) }
  })
  const key = textKey.value
  if (key) {
    const value = p.form.details[key]
    items.push({ id: key, label: STAY_SAFETY_DETAIL_FIELDS[key].name, summary: typeof value === 'string' ? value : 'Add details', to: p.sectionPath(`guest-safety/${section.value}/${key}`) })
  }
  return [{ id: 'safety-details', items }]
})

function setFlag(key: StaySafetyFlag, value: unknown) {
  if (value === 'yes' || value === 'no') p.form.details[key] = value === 'yes'
  else Reflect.deleteProperty(p.form.details, key)
  if (value !== 'yes') Reflect.deleteProperty(p.form.details, STAY_SAFETY_FIELDS[key].detailsKey)
}
function revert() {
  if (section.value) p.revert(section.value)
}
async function save() {
  if (section.value && !detailsError.value) await p.save(level.to.value ?? undefined, section.value)
}
watchEffect(() => {
  if (p.product.value && !p.loadError.value && (p.product.value.kind !== 'stay' || !section.value)) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
onBeforeRouteLeave(revert)
onBeforeRouteUpdate((to, from) => {
  const previousSection = 'section' in from.params ? String(from.params.section) : ''
  const nextSection = 'section' in to.params ? String(to.params.section) : ''
  if (nextSection !== previousSection && Object.hasOwn(STAY_SAFETY_SECTIONS, previousSection)) p.revert(previousSection as StaySafetySection)
})
</script>
