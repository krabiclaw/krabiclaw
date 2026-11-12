<template>
  <UDashboardPanel id="guided-experience" :ui="{ root: 'min-h-0', body: 'p-0 sm:p-0' }">
    <template #header>
      <div v-if="screen && screen.step !== 'complete'" class="flex justify-end px-6 py-4 sm:px-10">
        <UButton type="button" color="neutral" variant="outline" class="rounded-full" :disabled="saving" @click="save('exit')">
          {{ screen.exit_label }}
        </UButton>
      </div>
    </template>
    <template #body>
      <form id="guided-experience-form" class="mx-auto w-full max-w-xl px-6 pb-8 pt-[clamp(2rem,8svh,4rem)] sm:px-8 sm:pt-[clamp(4rem,17svh,11rem)]" @submit.prevent="save('next')">
        <USkeleton v-if="pending && !screen" class="h-12 w-3/4" />
        <template v-if="screen">
          <h1 class="text-3xl font-semibold leading-tight text-highlighted sm:text-4xl">{{ screen.title }}</h1>
          <p v-if="screen.detail" class="mt-2 text-muted">{{ screen.detail }}</p>

          <p v-if="screen.step === 'complete' && screen.value" class="mt-3 font-medium">{{ screen.value }}</p>
          <UFormField v-else-if="screen.max_length" :label="screen.label" :ui="{ label: 'sr-only' }" class="mt-6">
            <UTextarea v-model="answer" :aria-label="screen.label" :maxlength="screen.max_length" :disabled="saving"
              :rows="screen.step === 'title' ? 4 : 7" size="xl" class="w-full" :ui="{ base: 'min-h-32' }" />
            <p class="mt-2 text-sm text-muted" aria-hidden="true">{{ answer.length }}/{{ screen.max_length }}</p>
          </UFormField>
          <UFormField v-else-if="screen.step === 'location' || screen.step === 'host'" :label="screen.label" :ui="{ label: 'sr-only' }" class="mt-6">
            <URadioGroup v-if="screen.choices.length" v-model="answer" :items="choices" variant="card" :disabled="saving" />
            <UAlert v-else color="warning" variant="soft" :description="screen.step === 'location'
              ? 'Add an active location with a time zone in your workspace settings.'
              : 'Add a host to your workspace before continuing.'" />
          </UFormField>
          <div v-else-if="screen.step === 'session'" class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <UFormField label="Date">
              <UInput v-model="date" aria-label="Date" type="date" :min="screen.today" :disabled="saving" size="xl" class="w-full" />
            </UFormField>
            <UFormField label="Start time">
              <UInput v-model="time" aria-label="Start time" type="time" step="60" :disabled="saving" size="xl" class="w-full" />
            </UFormField>
          </div>
          <UFormField v-else-if="screen.step !== 'complete'" :label="screen.label" class="mt-6">
            <UInput v-model="answer" :aria-label="screen.label" :inputmode="screen.step === 'price' ? 'decimal' : 'numeric'" :disabled="saving" size="xl" class="w-full">
              <template v-if="screen.currency" #leading><span :aria-label="screen.currency">{{ currencySymbol }}</span></template>
            </UInput>
          </UFormField>
          <UButton v-if="screen.calendar_to" :to="screen.calendar_to" color="neutral" variant="link" label="View in Calendar" class="mt-5 px-0" />
        </template>

        <UAlert v-if="loadError || saveError" color="error" variant="soft" class="mt-5"
          :description="saveError || getErrorMessage(loadError, 'Experience setup could not be loaded')" />
        <UButton v-if="loadError" type="button" color="neutral" variant="outline" class="mt-4" @click="refresh()">Try again</UButton>
      </form>
    </template>
    <template v-if="screen" #footer>
      <div class="shrink-0 bg-default">
        <div v-if="screen.step !== 'complete'" class="grid h-1 gap-1" :style="{ gridTemplateColumns: `repeat(${screen.total}, 1fr)` }"
          role="progressbar" aria-label="Experience setup" :aria-valuemin="0" :aria-valuemax="screen.total" :aria-valuenow="screen.position - 1">
          <span v-for="position in screen.total" :key="position" :class="position < screen.position ? 'bg-inverted' : 'bg-elevated'" />
        </div>
        <div class="px-6 py-4 sm:px-10">
          <div v-if="screen.preview_to" class="flex items-center justify-between">
            <UButton :to="screen.exit_to" color="neutral" variant="link" label="Done" class="px-0" />
            <UButton :to="screen.preview_to" color="neutral" size="lg" label="Preview experience" />
          </div>
          <DashboardPanelFooter v-else :cancel-label="screen.back_label" :save-label="screen.next_label" :loading="saving" :disabled="!value"
            @cancel="goTo(screen.back_to)" @save="save('next')" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
import { isNavigationFailure } from 'vue-router'
import { experienceSetupScreen, experienceSetupStep } from '~/shared/experience-setup'
import type { z } from 'zod'
import { getErrorMessage } from '~/utils/errors'

const route = useRoute()
const organizationId = useDashboardOrganizationId()
const dashboardApi = useDashboardApi()
const endpoint = `/api/editor/organizations/${encodeURIComponent(organizationId)}/experience-setup`
const requestedStep = experienceSetupStep.safeParse(route.query.step)
if (route.query.step !== undefined && !requestedStep.success) throw createError({ statusCode: 400, statusMessage: 'Unknown experience setup question' })
const { data: screen, error: loadError, pending, refresh } = await useAsyncData(
  `experience-setup:${organizationId}:${requestedStep.data ?? 'resume'}`,
  () => dashboardApi(endpoint, {
    method: 'POST', body: { action: 'open', step: requestedStep.data },
    validate: (value): value is z.infer<typeof experienceSetupScreen> => experienceSetupScreen.safeParse(value).success,
  }),
)

const answer = ref('')
const date = ref('')
const time = ref('')
watch(screen, (step) => {
  answer.value = step?.value ?? ''
  date.value = ''
  time.value = ''
}, { immediate: true })
const value = computed(() => screen.value?.step === 'session'
  ? date.value && time.value ? `${date.value}T${time.value}` : ''
  : answer.value.trim())
const choices = computed(() => screen.value?.choices.map(choice => ({ value: choice.value, label: choice.label, description: choice.detail })))
const currencySymbol = computed(() => {
  const currency = screen.value?.currency
  if (!currency) return
  return new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
    .formatToParts(0).find(part => part.type === 'currency')!.value
})
const saving = ref(false)
const saveError = ref('')

async function goTo(to: string) {
  try {
    if (to === route.fullPath) {
      await refresh()
      return
    }
    const navigation = await navigateTo(to)
    if (isNavigationFailure(navigation)) throw navigation
  } catch (error) {
    saveError.value = getErrorMessage(error, 'The next screen could not be opened')
  }
}

async function save(action: 'next' | 'exit') {
  if (!screen.value || saving.value || action === 'next' && !value.value) return
  saveError.value = ''
  if (screen.value.step === 'session' && Boolean(date.value) !== Boolean(time.value)) {
    saveError.value = 'Choose a date and start time before saving this session.'
    return
  }
  saving.value = true
  try {
    const result = await dashboardApi(endpoint, {
      method: 'POST', body: { action, step: screen.value.step, value: value.value || undefined },
      validate: (value): value is { to: string } => isRecord(value) && typeof value.to === 'string' && value.to.startsWith('/dashboard/'),
    })
    await goTo(result.to)
  } catch (error) {
    saveError.value = getErrorMessage(error, 'The experience setup could not be saved')
  } finally {
    saving.value = false
  }
}
</script>
