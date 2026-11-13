<template>
  <TodayPage personal-scope>
    <template #personal-setup>
      <UButton v-if="setup?.resume_action" :to="setup.resume_action.to" :label="setup.resume_action.label"
        color="neutral" icon="i-lucide-arrow-right" trailing class="mb-6" />
      <UAlert v-else-if="error" color="error" variant="soft" class="mb-6" title="Website setup could not be loaded"
        :description="getErrorMessage(error, 'Try again to load your saved setup.')">
        <template #actions><UButton color="error" variant="soft" size="xs" @click="() => refresh()">Retry</UButton></template>
      </UAlert>
    </template>
  </TodayPage>
</template>

<script setup lang="ts">
import TodayPage from '~/components/dashboard/TodayPage.vue'
import { readActiveWebsiteDraft } from '~/composables/useOnboardingDraft'

definePageMeta({ layout: 'dashboard', tab: 'today' })
const { data: setup, error, refresh } = await useAsyncData('personal-website-setup', async () => {
  const { resume_action } = await readActiveWebsiteDraft()
  return { resume_action }
})
</script>
