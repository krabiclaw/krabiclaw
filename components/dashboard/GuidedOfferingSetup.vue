<template>
  <GuidedSetupShell id="guided-offering" :title="screen?.step.title" :detail="screen?.step.detail"
    :position="screen ? screen.step.position - 1 : 0" :total="screen?.step.total"
    :next-label="screen?.step.next_label" :back-label="screen?.back_label" :exit-label="screen?.exit_label"
    :busy="saving" :exit-disabled="uploading" :disabled="incomplete || uploading"
    @next="submit('next')" @back="goBack" @exit="submit('exit')">
    <USkeleton v-if="pending && !screen" class="h-12 w-3/4" />
    <fieldset v-if="screen" class="space-y-4" :disabled="saving">
      <template v-for="field in screen.step.fields" :key="field.key">
        <GuidedSetupPhotos v-if="field.kind === 'photo'" v-model="photos" v-model:uploading="uploading" :limit="1" :disabled="saving" />
        <URadioGroup v-else-if="field.kind === 'choice'" v-model="answers[field.key]" :aria-label="field.label"
          :items="field.choices?.map(choice => ({ ...choice, description: choice.detail }))" variant="card" />
        <UFormField v-else :label="field.label" :ui="{ label: screen.step.fields.length === 1 ? 'sr-only' : undefined }">
          <UTextarea v-if="field.kind === 'textarea'" v-model="answers[field.key]" :maxlength="field.max_length"
            :aria-label="field.label" :placeholder="field.placeholder" :rows="10" size="xl" class="w-full" />
          <USelectMenu v-else-if="field.kind === 'timezone'" v-model="answers[field.key]" :items="field.choices ?? timezones" value-key="value"
            :aria-label="field.label" placeholder="Select time zone" size="xl" class="w-full" />
          <div v-else-if="field.kind === 'money'" class="flex items-center gap-1 rounded-2xl border border-default bg-elevated/40 p-5">
            <span class="text-3xl font-bold sm:text-4xl" aria-hidden="true">{{ field.symbol }}</span>
            <UInput v-model="answers[field.key]" :aria-label="field.label" inputmode="decimal" placeholder="0" size="xl"
              variant="none" class="w-full" :ui="{ base: 'px-0 text-3xl font-bold sm:text-4xl' }" />
          </div>
          <UInput v-else v-model="answers[field.key]" :aria-label="field.label" :maxlength="field.max_length"
            :type="field.kind === 'date' || field.kind === 'time' ? field.kind : 'text'"
            :inputmode="field.kind === 'number' ? 'numeric' : undefined" :placeholder="field.placeholder"
            :min="field.min_date ?? field.min" :max="field.max" size="xl" class="w-full" />
          <p v-if="field.max_length" class="mt-2 text-sm text-muted" aria-hidden="true">
            {{ (answers[field.key] ?? '').length }}/{{ field.max_length }}
          </p>
        </UFormField>
      </template>
    </fieldset>
    <UAlert v-if="loadError || saveError" color="error" variant="soft" class="mt-5"
      :description="saveError || getErrorMessage(loadError, 'Setup could not be loaded.')" />
    <UButton v-if="loadError" type="button" color="neutral" variant="outline" class="mt-4" @click="refresh()">Try again</UButton>
  </GuidedSetupShell>
</template>

<script setup lang="ts">
import GuidedSetupShell from './GuidedSetupShell.vue'
import GuidedSetupPhotos from './GuidedSetupPhotos.vue'
import { isNavigationFailure } from 'vue-router'
import { offeringSetupResponse, type OfferingSetupResponse } from '~/shared/offering-setup'
import { getErrorMessage } from '~/utils/errors'
import { TIMEZONE_OPTIONS, timezoneLabel } from '~/utils/timezone'

const route = useRoute()
const api = useDashboardApi()
const organizationId = useDashboardOrganizationId()
const router = useRouter()
const endpoint = '/api/dashboard/onboarding/offering'
const query = {
  location_id: route.query.location_id,
  product_id: route.params.product_id,
  step: route.query.step,
}
const validate = (value: unknown): value is OfferingSetupResponse => offeringSetupResponse.safeParse(value).success
const { data, error: loadError, pending, refresh } = await useAsyncData('offering-setup:' + route.fullPath,
  () => api(endpoint, { query, validate }),
)
const screen = computed(() => data.value && 'step' in data.value ? data.value : undefined)
const answers = ref<Record<string, string>>({})
const photos = ref<{ asset_id: string; public_url: string }[]>([])
const uploading = ref(false)
const saving = ref(false)
const saveError = ref('')
const timezones = TIMEZONE_OPTIONS.map(value => ({ value, label: timezoneLabel(value) }))

watch(screen, (value) => {
  answers.value = Object.fromEntries(value?.step.fields.map(field => [field.key, field.value]) ?? [])
  const photo = value?.step.fields.find(field => field.kind === 'photo')
  photos.value = photo?.value && photo.display_url ? [{ asset_id: photo.value, public_url: photo.display_url }] : []
}, { immediate: true })

const incomplete = computed(() => screen.value?.step.fields.some(field => !field.optional && !answer(field.key, field.kind)))

function answer(key: string, kind: string) {
  return kind === 'photo' ? photos.value[0]?.asset_id ?? '' : (answers.value[key] ?? '').trim()
}

async function goTo(to: string) {
  try {
    if (router.resolve(to).fullPath === route.fullPath) {
      await refresh()
      return
    }
    const navigation = await navigateTo(to, { replace: true })
    if (isNavigationFailure(navigation)) throw navigation
  } catch (cause) {
    saveError.value = getErrorMessage(cause, 'The next screen could not be opened.')
  }
}

async function goBack() {
  if (screen.value) await goTo(screen.value.back_to)
}

async function submit(action: 'next' | 'exit') {
  const current = screen.value
  if (!current || saving.value || uploading.value || action === 'next' && incomplete.value) return
  saving.value = true
  saveError.value = ''
  try {
    const result = await api(endpoint, {
      method: 'POST',
      query,
      body: {
        action, step: current.step.id, revision: current.revision,
        values: Object.fromEntries(current.step.fields.map(field => [field.key, answer(field.key, field.kind)])),
      },
      validate,
    })
    if (!('to' in result)) throw new Error('The server did not return a setup destination.')
    clearNuxtData('product-catalog:' + organizationId)
    await goTo(result.to)
  } catch (cause) {
    saveError.value = getErrorMessage(cause, 'Could not save your answer.')
  } finally {
    saving.value = false
  }
}

watch(data, value => {
  if (value && 'to' in value) void goTo(value.to)
}, { immediate: true })
</script>
