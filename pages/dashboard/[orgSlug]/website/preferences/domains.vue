<template>
  <DashboardIndexPanel
    id="organization-domains"
    title="Domains"
  >
    <div class="w-full py-2">

      <UAlert
        v-if="actionError"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        :description="actionError"
        class="mb-6"
      />
      <UAlert
        v-if="loadError"
        color="error"
        variant="soft"
        title="Domains could not be loaded"
        :description="loadError"
        class="mb-6"
      />

      <div class="space-y-6">
        <!-- Default Website Address (Design System Parity) -->
        <div class="rounded-3xl p-5 sm:p-6 bg-white dark:bg-neutral-900 shadow-[0_4px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.3)]">
          <div class="flex items-center justify-between gap-4">
            <a
              :href="defaultUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="font-mono text-base font-semibold text-primary hover:underline inline-flex items-center gap-1.5 truncate"
              data-testid="default-domain-link"
            >
              <span class="truncate">{{ defaultHostname }}</span>
              <UIcon name="i-lucide-external-link" class="size-4 shrink-0 text-muted" />
            </a>

            <span class="inline-flex items-center gap-1.5 text-xs text-muted shrink-0">
              <span class="size-2 rounded-full bg-emerald-500" />
              <span>Active</span>
            </span>
          </div>
        </div>

        <!-- Custom Domains Section -->
        <div>
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-base font-semibold text-highlighted">
              Custom domain
            </h3>
            <UButton
              v-if="domainGroups?.length"
              icon="i-lucide-plus"
              label="Connect domain"
              color="neutral"
              variant="ghost"
              size="sm"
              @click="openAddModal"
            />
          </div>

          <!-- Empty state when no custom domains connected -->
          <div
            v-if="!loadError && !domainGroups?.length"
            class="rounded-3xl p-6 sm:p-8 text-center bg-white dark:bg-neutral-900 shadow-[0_4px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.3)]"
          >
            <div class="size-12 rounded-full bg-accented flex items-center justify-center mx-auto mb-3">
              <UIcon name="i-lucide-globe" class="size-6 text-muted" />
            </div>
            <h4 class="text-sm sm:text-base font-semibold text-highlighted">
              Connect your own domain
            </h4>
            <p class="mt-1 text-xs sm:text-sm text-muted max-w-sm mx-auto leading-relaxed">
              Use your own web address (like yourbusiness.com) so clients and guests find you easily.
            </p>
            <div class="mt-5">
              <UButton
                label="Connect a custom domain"
                icon="i-lucide-plus"
                color="neutral"
                variant="outline"
                size="md"
                class="rounded-xl font-semibold border border-neutral-900 dark:border-white cursor-pointer"
                data-testid="empty-connect-domain-button"
                @click="openAddModal"
              />
            </div>
          </div>

          <!-- Custom domains list -->
          <div v-else class="space-y-4">
            <div
              v-for="group in domainGroups"
              :key="group.id"
              class="rounded-3xl p-5 sm:p-6 bg-white dark:bg-neutral-900 shadow-[0_4px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.3)]"
              :data-testid="`domain-card-${group.domain}`"
            >
              <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div class="min-w-0">
                  <div class="flex items-center gap-3 flex-wrap">
                    <a
                      :href="`https://${group.domain}`"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="font-mono text-base font-semibold text-primary hover:underline inline-flex items-center gap-1.5 truncate"
                    >
                      <span>{{ group.domain }}</span>
                      <UIcon name="i-lucide-external-link" class="size-4 shrink-0 text-muted" />
                    </a>
                    <span class="inline-flex items-center gap-1.5 text-xs text-muted">
                      <span
                        class="size-2 rounded-full"
                        :class="group.status === 'active' ? 'bg-emerald-500' : group.status === 'failed' ? 'bg-rose-500' : 'bg-amber-500'"
                      />
                      <span>{{ statusLabel(group.status) }}</span>
                    </span>
                  </div>
                  <p v-if="group.www_domain_id" class="mt-1 text-xs text-muted">
                    www.{{ group.root_domain }} redirects to {{ group.domain }}
                  </p>
                </div>

              <div class="flex items-center gap-2 shrink-0">
                <UButton
                  v-if="primaryAction(group)"
                  size="sm"
                  :icon="primaryAction(group)?.icon"
                  :color="primaryAction(group)?.color"
                  :variant="primaryAction(group)?.variant"
                  :loading="syncingGroupId === group.id || promotingGroupId === group.id"
                  @click="runPrimaryAction(group)"
                >
                  {{ primaryAction(group)?.label }}
                </UButton>

                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :icon="expandedGroups[group.id] ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                  @click="toggleGroup(group.id)"
                >
                  {{ expandedGroups[group.id] ? 'Hide DNS' : 'DNS Records' }}
                </UButton>

                <UDropdownMenu :items="domainMenuItems(group)" :content="{ align: 'end' }">
                  <UButton icon="i-lucide-more-horizontal" color="neutral" variant="ghost" size="sm" aria-label="Domain actions" />
                </UDropdownMenu>
              </div>
            </div>

            <!-- Expanded DNS Verification Details -->
            <div v-if="expandedGroups[group.id]" class="mt-5 pt-5 border-t border-default space-y-4">
              <UAlert
                v-if="group.warning || group.error"
                :color="group.error ? 'error' : 'warning'"
                variant="soft"
                :title="group.error ? 'Action required' : 'Needs attention'"
                :description="group.error || group.warning || undefined"
              />

              <div class="overflow-x-auto">
                <UTable :data="group.records" :columns="recordColumns">
                  <template #type-cell="{ row }">
                    <UBadge :label="row.original.type" color="neutral" variant="soft" size="xs" />
                  </template>
                  <template #name-cell="{ row }">
                    <code class="block break-all text-xs text-highlighted font-mono">{{ row.original.name }}</code>
                  </template>
                  <template #value-cell="{ row }">
                    <code class="block max-w-full break-all text-xs text-muted font-mono">{{ row.original.value }}</code>
                  </template>
                  <template #actions-cell="{ row }">
                    <UTooltip :text="copiedValue === row.original.value ? 'Copied' : 'Copy value'">
                      <UButton
                        :icon="copiedValue === row.original.value ? 'i-lucide-check' : 'i-lucide-copy'"
                        :color="copiedValue === row.original.value ? 'success' : 'neutral'"
                        variant="ghost"
                        size="xs"
                        @click="copy(row.original.value)"
                      />
                    </UTooltip>
                  </template>
                </UTable>
              </div>

              <div class="flex flex-col gap-2 text-xs text-muted sm:flex-row sm:items-center sm:justify-between pt-2">
                <span>{{ group.last_synced_at ? `Last checked ${formatDateTime(group.last_synced_at)}` : 'Not checked yet' }}</span>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="soft"
                  icon="i-lucide-refresh-cw"
                  :loading="syncingGroupId === group.id"
                  @click="syncGroup(group)"
                >
                  Check now
                </UButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>

    <!-- Add Custom Domain Modal (Airbnb Parity) -->
    <UModal v-model:open="addModalOpen" :ui="{ content: 'max-w-md p-6 sm:p-7 rounded-3xl' }">
      <template #content>
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-xl font-semibold text-highlighted">Connect a custom domain</h3>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            square
            size="sm"
            aria-label="Close"
            @click="closeAddModal"
          />
        </div>

        <p class="text-xs sm:text-sm text-muted mb-5 leading-relaxed">
          Enter the domain you purchased from your registrar (e.g. GoDaddy, Namecheap, Cloudflare).
        </p>

        <UForm :state="addForm" class="space-y-4" @submit="addDomain">
          <UFormField label="Domain name" name="domain" :error="addError">
            <UInput
              v-model="addForm.domain"
              placeholder="example.com"
              class="w-full"
              :disabled="adding"
              autofocus
            />
          </UFormField>

          <UAlert
            v-if="liveCutoverWarning"
            color="warning"
            variant="soft"
            title="This domain may already be live"
            :description="liveCutoverWarning.message"
          />

          <SettingRow
            v-if="liveCutoverWarning"
            v-model="addForm.acknowledge_live_cutover"
            label="I understand changing DNS can interrupt the current site until validation finishes."
          />

          <div class="flex items-center justify-between pt-6">
            <UButton
              color="neutral"
              variant="ghost"
              size="lg"
              class="font-semibold"
              :disabled="adding"
              @click="closeAddModal"
            >
              Cancel
            </UButton>
            <UButton
              type="submit"
              color="neutral"
              variant="solid"
              size="lg"
              class="px-6 rounded-xl font-semibold justify-center"
              :loading="adding"
              :disabled="!addForm.domain.trim() || Boolean(liveCutoverWarning && !addForm.acknowledge_live_cutover)"
              data-testid="submit-add-domain"
            >
              Connect domain
            </UButton>
          </div>
        </UForm>
      </template>
    </UModal>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { formatTimestamp } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })

const confirmDialog = useOverlay().create(DashboardConfirmDialog)
const dashboardApi = useDashboardApi()
const dashboard = useDashboardOrganization()
const runtimeConfig = useRuntimeConfig()
const route = useRoute()
const { trackDomainConnected } = useAnalytics()

type DomainStatus = 'pending' | 'verifying' | 'active' | 'blocked' | 'failed' | 'disabled' | 'deleted'

interface DnsRecord {
  type: string
  name: string
  value: string
  purpose: string
}

interface DomainRow {
  id: string
  domain: string
  type: 'subdomain' | 'custom'
  role: 'canonical' | 'secondary'
  status: DomainStatus
}

interface DomainGroup {
  id: string
  domain: string
  root_domain: string
  role: 'canonical' | 'secondary'
  status: DomainStatus
  primary_domain_id: string | null
  apex_domain_id: string | null
  www_domain_id: string | null
  domains: DomainRow[]
  records: DnsRecord[]
  warning: string | null
  error: string | null
  last_synced_at: string | null
}

interface DomainsResponse {
  domains: DomainRow[]
  domain_groups: DomainGroup[]
}

interface AddDomainResponse extends DomainsResponse {
  requested_hostnames: string[]
}

interface LiveCutoverWarning {
  hostname: string
  records: Array<{ type: string; value: string }>
  message: string
}

const isDomainRow = (value: unknown): value is DomainRow =>
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.domain === 'string'
  && (value.type === 'subdomain' || value.type === 'custom')
  && (value.role === 'canonical' || value.role === 'secondary')
  && typeof value.status === 'string'

const isDomainGroup = (value: unknown): value is DomainGroup =>
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.domain === 'string'
  && Array.isArray(value.domains)
  && value.domains.every(isDomainRow)
  && Array.isArray(value.records)

const isDomainsResponse = (value: unknown): value is DomainsResponse =>
  isRecord(value)
  && Array.isArray(value.domains)
  && value.domains.every(isDomainRow)
  && Array.isArray(value.domain_groups)
  && value.domain_groups.every(isDomainGroup)

const organizationId = computed(() => dashboard.organization.value?.id ?? null)
if (!organizationId.value) {
  throw createError({ statusCode: 404, statusMessage: 'Organization not found' })
}

const freeOrganizationDomain = computed(() =>
  String(runtimeConfig.public.freeOrganizationDomain || 'krabiclaw.com').replace(/^https?:\/\//, ''),
)

const defaultHostname = computed(() => {
  const subdomain = dashboard.organization.value?.subdomain
  if (!subdomain) return freeOrganizationDomain.value
  return `${subdomain}.${freeOrganizationDomain.value}`
})

const defaultUrl = computed(() => `https://${defaultHostname.value}`)

const { data: domainGroups, error: domainsError, refresh: loadDomains } = await useAsyncData(
  () => `organization-domains:${organizationId.value}`,
  async () => (await dashboardApi<DomainsResponse>(`/api/organizations/${organizationId.value}/domains`, { validate: isDomainsResponse })).domain_groups,
)

const loadError = computed(() => domainsError.value ? getErrorMessage(domainsError.value, 'Failed to load domains') : null)

const copiedValue = ref<string | null>(null)
const actionError = ref<string | null>(null)
const adding = ref(false)
const syncingGroupId = ref<string | null>(null)
const promotingGroupId = ref<string | null>(null)
const deletingGroupId = ref<string | null>(null)
const expandedGroups = ref<Record<string, boolean>>({})
const addModalOpen = ref(false)
const addError = ref('')
const liveCutoverWarning = ref<LiveCutoverWarning | null>(null)
const addForm = reactive({
  domain: '',
  acknowledge_live_cutover: false,
})

const recordColumns = [
  { accessorKey: 'type', header: 'Type' },
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'value', header: 'Value' },
  { id: 'actions', header: '' },
]

function openAddModal() {
  addModalOpen.value = true
}

function resetAddModal() {
  addError.value = ''
  liveCutoverWarning.value = null
  addForm.domain = ''
  addForm.acknowledge_live_cutover = false
}

function closeAddModal() {
  addModalOpen.value = false
  resetAddModal()
}

async function addDomain() {
  if (!organizationId.value || !addForm.domain.trim()) return
  adding.value = true
  addError.value = ''
  try {
    const response = await dashboardApi<AddDomainResponse>(`/api/organizations/${organizationId.value}/domains`, {
      method: 'POST',
      body: {
        domain: addForm.domain.trim(),
        include_www: true,
        acknowledge_live_cutover: addForm.acknowledge_live_cutover,
      },
      validate: (value): value is AddDomainResponse => {
        const requestedHostnames = isRecord(value) ? value.requested_hostnames : null
        return isDomainsResponse(value)
          && Array.isArray(requestedHostnames)
          && requestedHostnames.every(hostname => typeof hostname === 'string')
      },
    })
    domainGroups.value = mergeGroups(domainGroups.value ?? [], response.domain_groups ?? [])
    const newGroup = response.domain_groups?.[0]
    if (newGroup) expandedGroups.value[newGroup.id] = true
    trackDomainConnected(addForm.domain.trim(), organizationId.value)
    closeAddModal()
  } catch (error) {
    const data = error instanceof ApiClientError && isRecord(error.data) ? error.data : {}
    if (data.live_cutover_warning && typeof data.live_cutover_warning === 'object') {
      liveCutoverWarning.value = data.live_cutover_warning as LiveCutoverWarning
      addError.value = ''
    } else {
      liveCutoverWarning.value = null
      addError.value = typeof data.error === 'string'
        ? data.error
        : error instanceof Error ? error.message : 'Failed to add domain'
    }
  } finally {
    adding.value = false
  }
}

function mergeGroups(current: DomainGroup[], incoming: DomainGroup[]) {
  const byId = new Map(current.map((group) => [group.id, group]))
  for (const group of incoming) byId.set(group.id, group)
  return Array.from(byId.values()).sort((a, b) => a.domain.localeCompare(b.domain))
}

function toggleGroup(groupId: string) {
  expandedGroups.value[groupId] = !expandedGroups.value[groupId]
}

async function copy(value: string) {
  actionError.value = null
  try {
    await navigator.clipboard.writeText(value)
    copiedValue.value = value
    setTimeout(() => {
      if (copiedValue.value === value) copiedValue.value = null
    }, 1500)
  } catch {
    actionError.value = 'Failed to copy to clipboard'
  }
}

function statusLabel(status: DomainStatus) {
  return {
    active: 'Active',
    pending: 'DNS required',
    verifying: 'Checking',
    stuck: 'Needs attention',
    failed: 'Failed',
    blocked: 'Blocked',
    disabled: 'Disabled',
    deleted: 'Deleted',
  }[status] ?? status
}

function primaryAction(group: DomainGroup) {
  if (group.status === 'active' && group.role === 'canonical') return null
  if (group.status === 'active') return { label: 'Make primary', icon: 'i-lucide-star', color: 'neutral' as const, variant: 'soft' as const }
  if (group.status === 'pending') return { label: 'Configure', icon: 'i-lucide-list-checks', color: 'neutral' as const, variant: 'soft' as const }
  if (group.status === 'verifying') return { label: 'Check now', icon: 'i-lucide-refresh-cw', color: 'neutral' as const, variant: 'soft' as const }
  if (group.status === 'failed') return { label: 'Retry', icon: 'i-lucide-rotate-cw', color: 'error' as const, variant: 'soft' as const }
  return { label: 'Resolve', icon: 'i-lucide-circle-alert', color: 'error' as const, variant: 'soft' as const }
}

async function runPrimaryAction(group: DomainGroup) {
  if (group.status === 'active' && group.role !== 'canonical') {
    await makePrimary(group)
    return
  }
  if (group.status === 'pending' || group.status === 'blocked') {
    expandedGroups.value[group.id] = true
    return
  }
  await syncGroup(group)
}

async function syncGroup(group: DomainGroup) {
  if (!organizationId.value || !group.primary_domain_id) return
  syncingGroupId.value = group.id
  actionError.value = null
  try {
    await dashboardApi(`/api/organizations/${organizationId.value}/domains/${group.primary_domain_id}/sync`, {
      method: 'POST',
      validate: (value): value is { success: true; domain: ApiRecord } =>
        isRecord(value) && value.success === true && isRecord(value.domain),
    })
    await loadDomains()
  } catch {
    actionError.value = 'Domain check failed'
  } finally {
    syncingGroupId.value = null
  }
}

async function makePrimary(group: DomainGroup) {
  if (!organizationId.value || !group.primary_domain_id) return
  promotingGroupId.value = group.id
  actionError.value = null
  try {
    await dashboardApi(`/api/organizations/${organizationId.value}/domains/${group.primary_domain_id}`, {
      method: 'PATCH',
      body: { role: 'canonical' },
      validate: (value): value is { success: true; domain: ApiRecord } =>
        isRecord(value) && value.success === true && isRecord(value.domain),
    })
    await loadDomains()
  } catch {
    actionError.value = 'Failed to update primary domain'
  } finally {
    promotingGroupId.value = null
  }
}

async function deleteGroup(group: DomainGroup) {
  if (!organizationId.value || !group.primary_domain_id || deletingGroupId.value) return
  if (!await confirmDialog.open({ title: `Remove ${group.domain}`, description: 'The domain stops serving this site.', confirmLabel: 'Remove domain', cancelLabel: 'Keep domain' })) return
  deletingGroupId.value = group.id
  actionError.value = null
  try {
    for (const domain of group.domains.filter((domain) => domain.type === 'custom')) {
      await dashboardApi(`/api/organizations/${organizationId.value}/domains/${domain.id}`, {
        method: 'DELETE',
        validate: (value): value is { success: true } =>
          isRecord(value) && value.success === true,
      })
    }
    domainGroups.value = domainGroups.value?.filter((candidate) => candidate.id !== group.id)
  } catch {
    await loadDomains()
    actionError.value = 'Failed to remove domain'
  } finally {
    deletingGroupId.value = null
  }
}

function domainMenuItems(group: DomainGroup) {
  return [[
    { label: 'Visit', icon: 'i-lucide-external-link', to: `https://${group.domain}`, target: '_blank' },
    { label: copiedValue.value === group.domain ? 'Copied' : 'Copy domain', icon: copiedValue.value === group.domain ? 'i-lucide-check' : 'i-lucide-copy', onSelect: () => copy(group.domain) },
    { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => deleteGroup(group) },
  ]]
}

function formatDateTime(value: string) {
  return formatTimestamp(value, 'en', 'UTC') + ' UTC'
}

watch(() => route.params.orgSlug, () => {
  expandedGroups.value = {}
})

watch(addModalOpen, (open) => {
  if (!open) resetAddModal()
})

useSeoMeta({ title: 'Domains | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
