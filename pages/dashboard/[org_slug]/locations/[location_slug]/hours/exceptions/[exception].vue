<template>
  <DashboardLeafPanel
    id="location-hours-exception"
    :title="entry ? exceptionLabel(entry) : ''"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? editor.validationMessage.value ?? ''"
    @cancel="editor.revert"
    @save="save"
  >
    <template v-if="entry && !removing">
      <LocationHoursException v-model:entry="editor.hoursForm.value.specialHours![index!]!" />
      <UButton v-if="!creating" class="mt-8" color="error" variant="soft" icon="i-lucide-trash-2" label="Remove exception" :loading="editor.saving.value" @click="remove" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import LocationHoursException from '~/lib/components/workspace/location/LocationHoursException.vue'
import { exceptionLabel } from '~/lib/components/workspace/location/hours'
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'
import { localNow } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const level = useRouteLevel()
const dashboardLocation = useDashboardLocation()
const organizationId = useDashboardOrganizationId()
const editor = await useLocationEditor(organizationId, dashboardLocation.currentLocationId, 'hours')

const param = computed(() => String(route.params.exception))
const creating = computed(() => param.value === 'new-closure' || param.value === 'new-hours')
const index = ref<number | null>(null)
const entry = computed(() => index.value === null ? null : editor.hoursForm.value.specialHours?.[index.value] ?? null)
const removing = ref(false)

// A new exception is a draft entry until Save; an existing one is named by its position.
watch(param, () => {
  if (!creating.value) {
    index.value = Number(param.value)
    return
  }
  // Once: a save refreshes the location's shared read, which reloads, and the draft is already there.
  if (index.value !== null) return
  const form = editor.hoursForm.value
  const date = form.timezone ? localNow(form.timezone).date : ''
  form.specialHours ??= []
  form.specialHours.push(param.value === 'new-closure'
    ? { kind: 'closure', starts_on: date, ends_on: null, note: null }
    : { kind: 'hours', date, periods: [{ open_time: '09:00', close_time: '17:00', close_day_offset: 0 }], note: null })
  index.value = form.specialHours.length - 1
}, { immediate: true })

// A date the location does not have is not a page (DESIGN.md).
watchEffect(() => {
  if (index.value !== null && !entry.value && !removing.value) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})

async function save() {
  await editor.save()
  if (editor.editorError.value || !creating.value) return
  // Saved, it is a date like the others: its own address, not `new`.
  await navigateTo(route.path.replace(/[^/]+$/, String(index.value)), { replace: true })
}

async function remove() {
  removing.value = true
  const exceptions = [...editor.hoursForm.value.specialHours!]
  editor.hoursForm.value.specialHours!.splice(index.value!, 1)
  await editor.save()
  // A refused save stays here with its reason; Cancel puts the date back.
  if (editor.editorError.value) {
    editor.hoursForm.value.specialHours = exceptions
    removing.value = false
    return
  }
  await navigateTo(level.to.value ?? '/dashboard')
}
</script>
