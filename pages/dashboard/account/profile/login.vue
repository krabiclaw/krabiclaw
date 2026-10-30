<template>
  <DashboardLeafPanel id="account-login" title="Login & security" :footer="false">
    <div class="space-y-10">
      <section>
        <h2 class="text-lg font-semibold text-highlighted">Login</h2>
        <div class="mt-2 divide-y divide-default">
          <div class="flex items-start justify-between gap-4 py-4">
            <div class="min-w-0">
              <p class="font-semibold text-highlighted">Email</p>
              <p class="mt-1 truncate text-sm text-muted">{{ account.sessionData.value?.user?.email }}</p>
            </div>
            <UBadge v-if="account.sessionData.value?.user?.emailVerified" color="success" variant="subtle">Verified</UBadge>
            <UBadge v-else color="warning" variant="subtle">Not verified</UBadge>
          </div>
          <div class="flex items-start justify-between gap-4 py-4">
            <div>
              <p class="font-semibold text-highlighted">Password</p>
              <p class="mt-1 text-sm text-muted">Sent to your email as a reset link.</p>
            </div>
            <NuxtLink to="/forgot-password" class="shrink-0 text-sm font-semibold text-highlighted underline underline-offset-4">Update</NuxtLink>
          </div>
          <div v-for="provider in LOGIN_PROVIDERS" :key="provider.id" class="flex items-start justify-between gap-4 py-4">
            <div>
              <p class="font-semibold text-highlighted">{{ provider.label }}</p>
              <p class="mt-1 text-sm text-muted">{{ STATUS_LABELS[account.loginProviderStatus(provider.id)] }}</p>
            </div>
            <UButton
              v-if="account.loginProviderStatus(provider.id) === 'not-connected'"
              variant="link"
              color="neutral"
              :label="`Connect ${provider.label}`"
              :loading="account.connectingProvider.value === provider.id"
              :disabled="account.connectingProvider.value !== null"
              @click="account.connectProvider(provider.id)"
            />
          </div>
        </div>
        <UAlert v-if="account.connectError.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="account.connectError.value" class="mt-3" />
      </section>

      <section>
        <h2 class="text-lg font-semibold text-highlighted">Device history</h2>
        <UAlert v-if="account.sessionsError.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="account.sessionsError.value" class="mt-3" />
        <div v-else class="mt-2 divide-y divide-default">
          <div v-for="device in account.sessions.value" :key="device.token" class="flex items-start justify-between gap-4 py-4">
            <div class="min-w-0">
              <p class="font-semibold text-highlighted">{{ account.describeDevice(device.userAgent) }}</p>
              <UBadge v-if="device.current" color="neutral" variant="subtle" size="sm" class="mt-1">Current session</UBadge>
              <p class="mt-1 text-sm text-muted">{{ device.ipAddress ? `${device.ipAddress} · ` : '' }}{{ account.formatExactDateTime(device.updatedAt, { includeTime: true }) }}</p>
            </div>
            <UButton
              v-if="!device.current"
              variant="link"
              color="neutral"
              label="Log out"
              :loading="account.revoking.value === device.token"
              @click="account.revokeDevice(device.token)"
            />
          </div>
        </div>
      </section>

      <section>
        <h2 class="text-lg font-semibold text-highlighted">Delete account</h2>
        <div class="mt-3 space-y-4">
          <p class="text-sm text-muted">Permanently deletes your account and the cards you saved with businesses. Businesses keep their records of your payments. Organizations are managed separately. This cannot be undone.</p>
          <UAlert v-if="account.deleteError.value" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="account.deleteError.value" />
          <UFormField label="Type DELETE to confirm">
            <UInput v-model="account.deleteConfirmText.value" placeholder="DELETE" :disabled="account.deleting.value" class="w-full" />
          </UFormField>
          <UButton color="error" variant="soft" label="Delete account" :disabled="account.deleteConfirmText.value !== 'DELETE'" :loading="account.deleting.value" @click="account.confirmDeleteAccount" />
        </div>
      </section>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { accountEditorKey, LOGIN_PROVIDERS } from '~/components/dashboard/AccountProfilePage.vue'

const STATUS_LABELS = { 'connected': 'Connected', 'not-connected': 'Not connected', 'error': 'Could not be checked' } as const

definePageMeta({ layout: 'dashboard' })

const account = inject(accountEditorKey)!
</script>
