<template>
  <UDashboardPanel id="website-onboarding-saved" :ui="{ root: 'min-h-0', body: 'items-center justify-center-safe px-6 py-10 text-center' }">
    <template #body>
      <div v-if="setup?.resume_action" class="flex max-w-sm flex-col items-center gap-6 sm:max-w-lg">
        <span class="grid size-16 place-items-center rounded-full bg-accented text-highlighted" aria-hidden="true">
          <UIcon name="i-lucide-check" class="size-7" />
        </span>
        <h1 class="text-3xl font-semibold leading-tight text-balance text-highlighted sm:text-4xl">{{ setup.resume_action.title }}</h1>
        <UButton :to="setup.resume_action.to" :label="setup.resume_action.label" color="neutral" size="lg" class="px-6" replace />
      </div>
      <UAlert v-else-if="error" color="error" variant="soft" class="max-w-md" title="Website setup could not be loaded"
        :description="getErrorMessage(error, 'Try again to load your saved setup.')">
        <template #actions><UButton color="error" variant="soft" size="xs" @click="retry">Retry</UButton></template>
      </UAlert>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
import { readActiveWebsiteDraft } from '~/composables/useOnboardingDraft'
import { WEBSITE_ONBOARDING_PATH } from '~/shared/onboarding-flow'

definePageMeta({ path: '/dashboard/onboarding/saved', layout: 'dashboard', tabs: false })

const { data: setup, error, refresh } = await useAsyncData('saved-website-setup', async () => {
  const { resume_action } = await readActiveWebsiteDraft()
  return { resume_action }
})

async function goToSetupIfNoDraft() {
  if (setup.value?.resume_action === null) await navigateTo(WEBSITE_ONBOARDING_PATH, { replace: true })
}

await goToSetupIfNoDraft()

async function retry() {
  await refresh()
  await goToSetupIfNoDraft()
}
</script>
