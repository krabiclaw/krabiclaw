<template>
  <DashboardLeafPanel
    id="product-team"
    :title="p.sectionLabels.team"
    lead="Choose the host responsible for this home’s stays."
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <ResponsibilityPicker v-if="p.isNew.value || p.product.value" v-model:member-id="p.form.stay_member_id" :organization-id="p.organizationId" :disabled="p.saving.value" required />
    <section v-if="canManageAccess" class="mt-8 space-y-4 border-t border-default pt-6" aria-labelledby="guest-messaging-access">
      <div>
        <h2 id="guest-messaging-access" class="font-semibold text-highlighted">Guest messaging access</h2>
        <p class="mt-1 text-sm text-muted">Choose which workspace members can read and reply to guest conversations for this listing.</p>
      </div>
      <UAlert v-if="accessError || saveAccessError" color="error" variant="soft" :description="saveAccessError || getErrorMessage(accessError, 'Guest messaging access could not be loaded')" />
      <p v-else-if="accessPending" class="text-sm text-muted" role="status">Loading access…</p>
      <p v-else-if="access && !access.members.length" class="text-sm text-muted">There are no co-hosts in this workspace.</p>
      <ul v-if="access" class="divide-y divide-default">
        <li v-for="member in access.members" :key="member.member_id" class="py-3">
          <USwitch
            :model-value="access.member_ids.includes(member.member_id)"
            :label="member.name"
            :description="member.email"
            :loading="savingAccess === member.member_id"
            :disabled="savingAccess !== null"
            @update:model-value="allowed => setAccess(member.member_id, allowed)"
          />
        </li>
      </ul>
    </section>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import ResponsibilityPicker from '~/components/dashboard/ResponsibilityPicker.vue'
import { isTeamMembersResponse } from '~/lib/components/workspace/messages/team-thread-client'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const dashboard = useDashboardOrganization()
const api = useDashboardApi()
const listingId = computed(() => p.product.value?.id)
const canManageAccess = computed(() => p.product.value?.kind === 'stay' && (dashboard.organization.value?.role ?? '').split(',').includes('owner'))
const grantPath = computed(() => `/api/messages/listings/${encodeURIComponent(listingId.value ?? '')}/participants`)
const grantQuery = computed(() => ({ organization_id: dashboard.organizationId.value }))

function isGrantList(value: unknown): value is { member_ids: string[] } {
  return isRecord(value) && Array.isArray(value.member_ids) && value.member_ids.every(id => typeof id === 'string' && id !== '')
}

const { data: access, pending: accessPending, error: accessError } = await useAsyncData(
  () => `listing-messaging-access:${grantQuery.value.organization_id}:${listingId.value}`,
  async (_app, { signal }) => {
    if (!canManageAccess.value || !listingId.value) return null
    const [grants, roster] = await Promise.all([
      applicationFetch(grantPath.value, { query: grantQuery.value, signal, validate: isGrantList }),
      api('/api/dashboard/team/members', { signal, validate: isTeamMembersResponse }),
    ])
    return { member_ids: grants.member_ids, members: roster.members.filter(member => !member.role.split(',').includes('owner')) }
  },
)
const savingAccess = ref<string | null>(null)
const saveAccessError = ref('')
async function setAccess(memberId: string, allowed: boolean) {
  if (!access.value || savingAccess.value !== null) return
  savingAccess.value = memberId
  saveAccessError.value = ''
  try {
    const saved = await applicationFetch(grantPath.value, {
      method: 'PUT', query: grantQuery.value, body: { member_id: memberId, allowed },
      validate: isGrantList,
    })
    if (saved.member_ids.includes(memberId) !== allowed) throw new Error('The server did not confirm the access change')
    access.value = { ...access.value, member_ids: saved.member_ids }
  } catch (cause) {
    saveAccessError.value = getErrorMessage(cause, 'Guest messaging access could not be saved')
  } finally {
    savingAccess.value = null
  }
}
</script>
