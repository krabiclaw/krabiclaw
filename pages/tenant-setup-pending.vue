<template>
  <div class="min-h-screen bg-muted flex items-center justify-center px-4">
    <div class="max-w-md w-full text-center">
      <!-- Setup Icon -->
      <div class="mb-8">
        <div class="mx-auto w-24 h-24 bg-blue-100 rounded-full flex items-center justify-center">
          <svg class="animate-spin w-12 h-12 text-blue-600" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>
      </div>

      <!-- Setup Message -->
      <h1 class="text-3xl font-bold text-highlighted mb-4">
        Setting Up Your Site
      </h1>
      
      <p class="text-muted mb-8">
        We're creating your restaurant website. This usually takes just a few seconds.
      </p>

      <!-- Progress -->
      <div class="bg-default rounded-lg p-6 border border-default">
        <div class="space-y-4">
          <div class="flex items-center">
            <div class="w-4 h-4 bg-green-500 rounded-full mr-3"></div>
            <span class="text-sm text-stone-700">Site created</span>
          </div>
          <div class="flex items-center">
            <div class="w-4 h-4 bg-blue-500 rounded-full animate-pulse mr-3"></div>
            <span class="text-sm text-stone-700">Setting up content...</span>
          </div>
          <div class="flex items-center">
            <div class="w-4 h-4 bg-stone-300 rounded-full mr-3"></div>
            <span class="text-sm text-stone-500">Finalizing</span>
          </div>
        </div>
      </div>

      <!-- Refresh Message -->
      <div v-if="!setupFailed" class="mt-8 text-sm text-stone-500">
        This page will automatically update when setup is complete.<br>
        You can also refresh this page to check the status.
      </div>

      <!-- Failure state: a real error, not "still provisioning" -->
      <UAlert
        v-else
        class="mt-8 text-left"
        color="error"
        variant="soft"
        title="Setup could not be verified"
        :description="setupFailedMessage"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'saya' })
// A page about the business: its image is the organization's.
const { socialImage: organizationSocialImage } = useTenantOrganization()
useSocialMetadata({
  schema: false,
  path: '/tenant-setup-pending',
  socialImage: organizationSocialImage,
  title: 'Setting up your site',
  description: 'This site is still being set up and will be available shortly.',
  discoverability: 'private',
})

const setupFailed = ref(false)
const setupFailedMessage = ref('')

// Auto-refresh every 5 seconds to check status. A 404 here means the site is
// genuinely still provisioning — expected, keep polling. Any other failure
// (500, network error) is a real problem, not a "not ready yet" signal, so it
// stops the loop and surfaces an error instead of polling silently forever.
onMounted(() => {
  const interval = setInterval(async () => {
    try {
      await publicApiRequest<{ status: 'ready'; onboarding_status: string }>('/api/organization-status', {
        validate: (value): value is { status: 'ready'; onboarding_status: string } =>
          isRecord(value)
          && value.status === 'ready'
          && typeof value.onboarding_status === 'string',
      })
      await navigateTo('/')
    } catch (error) {
      if (error instanceof ApiClientError && error.statusCode === 404) return
      clearInterval(interval)
      setupFailed.value = true
      setupFailedMessage.value = error instanceof Error ? error.message : 'Could not check setup status.'
    }
  }, 5000)

  onUnmounted(() => {
    clearInterval(interval)
  })
})
</script>
