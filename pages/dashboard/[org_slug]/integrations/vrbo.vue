<template>
  <DashboardLeafPanel
    id="integration-vrbo"
    icon="i-lucide-house"
    title="Vrbo sync"
    :lead="integrationDefinition('vrbo').purpose"
    :error="error || (loadError ? getErrorMessage(loadError, 'Could not load Vrbo.') : '')"
    :footer="false"
  >
    <p v-if="pending" role="status">Checking Vrbo…</p>
    <p v-else-if="data?.entitled === false">Vrbo sync is included with the Business plan.</p>
    <p v-else-if="data && !data.homes.length">Add a home in Catalog, then return here to connect it to Vrbo.</p>
    <template v-else-if="data">
      <template v-if="setupUrl">
        <UButton color="neutral" variant="outline" class="mb-4" :loading="closing" @click="closeSetup">Done with Channex</UButton>
        <iframe :src="setupUrl" class="min-h-[640px] w-full rounded-xl border border-default" title="Channex Vrbo setup" referrerpolicy="no-referrer" />
      </template>
      <template v-else>
        <UAlert class="mb-4" color="warning" variant="soft" description="Remove any iCal feeds from Airbnb or another property manager in Vrbo before you authenticate. Those feeds can overwrite calendar updates." />
        <ul class="divide-y divide-default">
          <li v-for="home in data.homes" :key="home.product_id" class="flex items-center justify-between gap-4 py-4">
            <div>
              <p class="font-medium">{{ home.name }}</p>
              <p class="text-sm text-muted">{{ states[home.status] }}</p>
            </div>
            <UButton :loading="opening === home.product_id" :disabled="opening !== null" @click="start(home.product_id)">
              {{ opening === home.product_id ? 'Preparing home…' : home.status === 'not_connected' ? 'Connect Vrbo' : 'Manage in Channex' }}
            </UButton>
          </li>
        </ul>
      </template>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { integrationDefinition } from '~/shared/integrations'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

type Status = 'not_connected' | 'connected' | 'needs_review'
const states: Record<Status, string> = {
  not_connected: 'Not connected',
  connected: 'Connected',
  needs_review: 'Needs review',
}
type VrboSetup = { entitled: boolean; homes: Array<{ product_id: string; name: string; status: Status }> }
const isVrboSetup = (value: unknown): value is VrboSetup =>
  isRecord(value) && typeof value.entitled === 'boolean' && Array.isArray(value.homes)
  && value.homes.every(home => isRecord(home) && typeof home.product_id === 'string'
    && typeof home.name === 'string' && typeof home.status === 'string' && Object.hasOwn(states, home.status))

const organizationId = useDashboardOrganizationId()
const dashboardApi = useDashboardApi()
const api = `/api/organizations/${encodeURIComponent(organizationId)}/integrations/vrbo`
const { data, pending, refresh, error: loadError } = await useAsyncData(
  `integration-vrbo:${organizationId}`,
  () => dashboardApi(api, { validate: isVrboSetup }),
)

const opening = ref<string | null>(null)
const setupUrl = ref<string | null>(null)
const setupHome = ref<string | null>(null)
const closing = ref(false)
const error = ref('')
async function start(productId: string) {
  opening.value = productId
  error.value = ''
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await dashboardApi(`${api}/start`, {
        method: 'POST',
        body: { product_id: productId },
        validate: (value): value is { url: string } | { preparing: true } => isRecord(value)
          && ((typeof value.url === 'string' && value.url.startsWith('https://')) || value.preparing === true),
      })
      if ('url' in response) {
        setupHome.value = productId
        setupUrl.value = response.url
        return
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    error.value = 'Channex is still confirming the calendar. Try again to continue setup.'
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not open Channex setup.')
  } finally {
    opening.value = null
  }
}

async function closeSetup() {
  if (setupHome.value === null) return
  closing.value = true
  error.value = ''
  try {
    await dashboardApi(`${api}/complete`, {
      method: 'POST',
      body: { product_id: setupHome.value },
      validate: (value): value is { success: true } => isRecord(value) && value.success === true,
    })
    setupUrl.value = null
    setupHome.value = null
    await refresh()
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Could not verify the updated Channex connection.')
  } finally {
    closing.value = false
  }
}
</script>
