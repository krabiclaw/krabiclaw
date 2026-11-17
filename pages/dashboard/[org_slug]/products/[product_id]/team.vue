<template>
  <DashboardLeafPanel
    id="product-team"
    :title="p.product.value?.kind === 'stay' ? p.sectionLabels.team : 'Listing access'"
    :lead="p.product.value?.kind === 'stay' ? 'Choose the host responsible for this home’s stays and guest conversations.' : undefined"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <ResponsibilityPicker v-if="p.isNew.value || p.product.value?.kind === 'stay'" v-model:member-id="p.form.stay_member_id" :organization-id="p.organizationId" :disabled="p.saving.value" required />
    <section v-if="canManageAccess" class="mt-8 space-y-4 border-t border-default pt-6" aria-labelledby="guest-messaging-access">
      <h2 id="guest-messaging-access" class="font-semibold text-highlighted">Listing access</h2>
      <UAlert v-if="accessError || saveAccessError" color="error" variant="soft" :description="saveAccessError || getErrorMessage(accessError, 'Listing access could not be loaded')" />
      <p v-else-if="accessPending" class="text-sm text-muted" role="status">Loading access…</p>
      <ul v-if="access" class="divide-y divide-default">
        <li v-for="member in cohosts" :key="member.member_id" class="py-3">
          <UFormField :label="member.name" :description="member.email">
            <USelect
              :model-value="access.grants.find(grant => grant.member_id === member.member_id)?.access ?? 'none'"
              :items="accessChoices(member)"
              :loading="savingAccess === member.member_id"
              :disabled="savingAccess !== null"
              @update:model-value="value => setAccess(member.member_id, value)"
            />
          </UFormField>
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
import { isOrganizationRole, listingAccessLevels, organizationRoleCards, type StoredListingAccess } from '~/utils/organization-access'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const dashboard = useDashboardOrganization()
const api = useDashboardApi()
const listingId = computed(() => p.product.value?.id)
const canManageAccess = computed(() => Boolean(p.product.value && ['stay', 'table', 'service', 'experience'].includes(p.product.value.kind)) && (dashboard.organization.value?.role ?? '').split(',').includes('owner'))
const grantPath = computed(() => `/api/messages/listings/${encodeURIComponent(listingId.value ?? '')}/participants`)
const grantQuery = computed(() => ({ organization_id: dashboard.organizationId.value }))

function isGrantList(value: unknown): value is { grants: Array<{ member_id: string; access: StoredListingAccess }> } {
  return isRecord(value) && Array.isArray(value.grants) && value.grants.every(grant => isRecord(grant) && typeof grant.member_id === 'string'
    && typeof grant.access === 'string' && (grant.access === 'messaging' || Object.hasOwn(listingAccessLevels, grant.access)))
}

const { data: access, pending: accessPending, error: accessError } = await useAsyncData(
  () => `listing-messaging-access:${grantQuery.value.organization_id}:${listingId.value}`,
  async (_app, { signal }) => {
    if (!canManageAccess.value || !listingId.value) return null
    const [grants, roster] = await Promise.all([
      applicationFetch(grantPath.value, { query: grantQuery.value, signal, validate: isGrantList }),
      api('/api/dashboard/team/members', { signal, validate: isTeamMembersResponse }),
    ])
    return { grants: grants.grants, members: roster.members }
  },
)
const cohosts = computed(() => access.value?.members.filter(member => accessChoices(member).length > 1) ?? [])
function accessChoices(member: { member_id: string; role: string }) {
  const saved = access.value?.grants.find(grant => grant.member_id === member.member_id)?.access
  const levels = new Set(member.role.split(',').flatMap(role => isOrganizationRole(role.trim()) ? organizationRoleCards[role.trim() as keyof typeof organizationRoleCards].access : []))
  return [{ value: 'none', label: 'No additional access' }, ...[...levels].map(value => ({ value, label: listingAccessLevels[value] })),
    ...(saved === 'messaging' ? [{ value: 'messaging', label: 'Messaging' }] : [])]
}
const savingAccess = ref<string | null>(null)
const saveAccessError = ref('')
async function setAccess(memberId: string, value: string) {
  if (!access.value || savingAccess.value !== null) return
  savingAccess.value = memberId
  saveAccessError.value = ''
  try {
    const saved = await applicationFetch(grantPath.value, {
      method: 'PUT', query: grantQuery.value, body: { member_id: memberId, access: value === 'none' ? null : value },
      validate: isGrantList,
    })
    if ((saved.grants.find(grant => grant.member_id === memberId)?.access ?? 'none') !== value) throw new Error('The server did not confirm the access change')
    access.value = { ...access.value, grants: saved.grants }
  } catch (cause) {
    saveAccessError.value = getErrorMessage(cause, 'Listing access could not be saved')
  } finally {
    savingAccess.value = null
  }
}
</script>
