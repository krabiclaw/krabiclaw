<template>
  <Teleport v-if="actionsTarget && data?.inviteRoles.length" :to="'#' + actionsTarget" defer>
    <UButton icon="i-lucide-user-plus" color="neutral" variant="soft" square aria-label="Invite a team member" :to="level.path.value + '/invite'" />
  </Teleport>
  <p v-if="status === 'pending' && !data" role="status" class="py-3 text-sm text-muted">Loading team…</p>
  <UAlert v-else-if="loadError && !data" color="error" variant="soft" title="The team could not be loaded" :description="getErrorMessage(loadError, 'Members request failed')" :actions="[{ label: 'Retry', onClick: () => refresh() }]" />
  <div v-else-if="data" class="space-y-6">
    <section aria-labelledby="team-members">
      <h2 id="team-members" class="text-sm font-semibold text-highlighted">Members</h2>
      <ul v-if="data.members.length" class="divide-y divide-default">
        <li v-for="member in data.members" :key="member.id" class="py-2.5">
          <div class="flex items-start gap-2.5">
            <UAvatar :src="member.user.image || undefined" :alt="member.user.name || member.user.email" size="md" aria-hidden="true" class="mt-1.5 shrink-0" />
            <div class="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_auto] items-center">
              <NuxtLink :to="memberAvailabilityPath(member)" class="col-span-full col-start-1 row-span-2 row-start-1 grid min-w-0 grid-cols-subgrid grid-rows-subgrid">
                <span class="col-start-1 row-start-1 flex min-h-11 min-w-0 items-center pe-2 text-sm font-medium text-highlighted">
                  <span class="min-w-0 wrap-anywhere">{{ member.user.name || member.user.email }}<span v-if="member.isCurrentUser" class="text-muted"> (you)</span></span>
                </span>
                <span class="col-span-full row-start-2 -mt-2 wrap-anywhere text-xs text-muted">{{ member.user.email }}</span>
              </NuxtLink>
              <USelect
                v-if="member.roleChoices.length"
                :model-value="member.role"
                :items="member.roleChoices"
                color="neutral"
                variant="ghost"
                size="sm"
                class="z-10 col-start-2 row-start-1"
                :ui="{ base: 'min-h-11 px-2', trailing: 'end-1', value: 'pe-3' }"
                :aria-label="`Role for ${member.user.name || member.user.email}`"
                :loading="roleUpdatingId === member.id"
                :disabled="busy"
                @update:model-value="value => onRoleSelected(member, String(value))"
              >{{ member.roleLabel }}</USelect>
              <span v-else class="col-start-2 row-start-1 text-right text-sm text-muted">{{ member.roleLabel }}</span>
              <UDropdownMenu v-if="member.canRemove" :items="[{ label: 'Remove member', color: 'error', onSelect: () => { removing = member } }]" :content="{ align: 'end' }">
                <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" square class="z-10 col-start-3 row-start-1 -me-2 ms-2 size-11 justify-center" :aria-label="`Actions for ${member.user.name || member.user.email}`" :disabled="busy" />
              </UDropdownMenu>
            </div>
          </div>
          <UAlert v-if="roleUpdateError && roleUpdateErrorMemberId === member.id" class="mt-2" color="error" variant="soft" :description="roleUpdateError" />
        </li>
      </ul>
      <p v-else class="py-3 text-sm text-muted">No members found for this organization.</p>
      <UAlert v-if="memberError" class="mt-2" color="error" variant="soft" :description="memberError" />
    </section>

    <section v-if="data.canViewInvitations" aria-labelledby="team-invitations">
      <h2 id="team-invitations" class="text-sm font-semibold text-highlighted">Pending invitations</h2>
      <ul v-if="data.invitations.length" class="divide-y divide-default">
        <li v-for="invitation in data.invitations" :key="invitation.id" class="py-2.5">
          <div class="flex min-h-11 items-center gap-2">
            <p class="min-w-0 flex-1 wrap-anywhere text-sm font-medium text-highlighted">{{ invitation.email }}</p>
            <span class="text-right text-sm text-muted">{{ invitation.roleLabel }}</span>
            <UDropdownMenu v-if="invitation.canResend || invitation.canCancel" :items="invitationActions(invitation)" :content="{ align: 'end' }">
              <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" square class="-me-2 size-11 justify-center" :aria-label="`Actions for ${invitation.email}`" :disabled="busy" :loading="resendingInviteId === invitation.id || cancellingInviteId === invitation.id" />
            </UDropdownMenu>
          </div>
          <p class="-mt-2 text-xs text-muted">{{ invitation.statusLabel }} · Expires {{ formatDate(invitation.expiresAt) }}</p>
          <p class="mt-0.5 text-xs" :class="invitation.delivery.failed ? 'text-error' : 'text-muted'">{{ invitation.delivery.message }}</p>
        </li>
      </ul>
      <p v-else class="py-3 text-sm text-muted">No pending invitations.</p>
      <UAlert v-if="pendingInvitationError" class="mt-2" color="error" variant="soft" :description="pendingInvitationError" />
    </section>
  </div>
  <UModal :open="removing !== null" :title="`Remove ${removing?.user.name || removing?.user.email || 'member'}?`" description="They lose access to this workspace and its team conversations." @update:open="open => { if (!open) removing = null }">
    <template #footer>
      <UButton label="Cancel" color="neutral" variant="ghost" @click="removing = null" />
      <UButton label="Remove member" color="error" @click="confirmRemoval" />
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { dashboardPanelActionsKey } from '~/lib/components/workspace/dashboard/dashboardPanelContext'
import { formatTimestamp } from '~/utils/timezone'

import { authClient } from '~/lib/auth-client'
import { getErrorMessage } from '~/utils/errors'
import { isOrganizationMembersData, organizationMembersKey, type OrganizationMembersData } from '~/utils/organization-members'

type MemberRow = OrganizationMembersData['members'][number]
type InvitationRow = OrganizationMembersData['invitations'][number]

const route = useRoute()
const level = useRouteLevel()
const actionsTarget = inject(dashboardPanelActionsKey)
const dashboardApi = useDashboardApi()
const toast = useToast()

const dashboard = useDashboardOrganization()
const { data, error: loadError, status, refresh } = await useAsyncData(
  () => organizationMembersKey(String(route.params.org_slug)),
  () => dashboardApi('/api/dashboard/members', { validate: isOrganizationMembersData }),
)

function memberAvailabilityPath(member: MemberRow) {
  const organization = dashboard.organization.value
  if (!organization) throw createError({ statusCode: 503, statusMessage: 'Dashboard context not loaded' })
  return member.isCurrentUser
    ? `/dashboard/account/profile/calendar/${encodeURIComponent(organization.id)}`
    : `/dashboard/${encodeURIComponent(organization.slug)}/team/${encodeURIComponent(member.id)}`
}

const removing = ref<MemberRow | null>(null)
const removingMemberId = ref<string | null>(null)
const cancellingInviteId = ref<string | null>(null)
const resendingInviteId = ref<string | null>(null)
const memberError = ref<string | null>(null)
const pendingInvitationError = ref<string | null>(null)

const roleUpdatingId = ref<string | null>(null)
const roleUpdateError = ref<string | null>(null)
const roleUpdateErrorMemberId = ref<string | null>(null)

const busy = computed(() => Boolean(roleUpdatingId.value || removingMemberId.value || cancellingInviteId.value || resendingInviteId.value))

function invitationActions(invitation: InvitationRow): DropdownMenuItem[] {
  const actions: DropdownMenuItem[] = []
  if (invitation.canResend) actions.push({ label: 'Resend invitation', onSelect: () => resendInvitation(invitation) })
  if (invitation.canCancel) actions.push({ label: 'Revoke invitation', color: 'error', onSelect: () => cancelInvitation(invitation.id) })
  return actions
}

function confirmRemoval() {
  const member = removing.value
  removing.value = null
  if (member) void removeMember(member.id)
}

function onRoleSelected(member: MemberRow, role: string) {
  roleUpdateError.value = null
  roleUpdateErrorMemberId.value = null
  if (busy.value || role === member.role) return
  void submitRoleChange(member, role)
}

async function submitRoleChange(member: MemberRow, role: string) {
  roleUpdatingId.value = member.id
  roleUpdateError.value = null
  roleUpdateErrorMemberId.value = null
  try {
    const organizationId = dashboard.organization.value?.id
    if (!organizationId) throw new Error('Organization context is unavailable')
    const result = await authClient.organization.updateMemberRole({ organizationId, memberId: member.id, role })
    if (result.error) throw new Error(result.error.message)
    if (member.isCurrentUser) {
      await dashboard.refresh()
      if (dashboard.error.value) throw dashboard.error.value
      if (dashboard.organization.value?.role !== role) throw new Error('Your role change could not be verified')
      const permission = await authClient.organization.hasPermission({ organizationId, permissions: { members: ['read'] } })
      if (permission.error) throw new Error(permission.error.message)
      if (!permission.data.success) {
        toast.add({ title: 'Role updated', color: 'success' })
        await navigateTo(memberAvailabilityPath(member))
        return
      }
    }
    await refresh()
    if (loadError.value) throw loadError.value
    if (data.value?.members.find(saved => saved.id === member.id)?.role !== role) throw new Error('The member role change could not be verified')
    toast.add({ title: 'Role updated', color: 'success' })
  } catch (err: unknown) {
    roleUpdateError.value = getErrorMessage(err, 'Failed to update member role.')
    roleUpdateErrorMemberId.value = member.id
  } finally {
    roleUpdatingId.value = null
  }
}

async function cancelInvitation(invitationId: string) {
  if (busy.value) return
  cancellingInviteId.value = invitationId
  pendingInvitationError.value = null

  try {
    const { error } = await authClient.organization.cancelInvitation({ invitationId })

    if (error) {
      pendingInvitationError.value = error.message ?? 'Failed to cancel invitation.'
      return
    }

    await refresh()
    if (loadError.value) throw loadError.value
    if (!data.value || data.value.invitations.some(item => item.id === invitationId)) throw new Error('The revoked invitation could not be verified')
    toast.add({ title: 'Invitation revoked', color: 'success' })
  } catch (err) {
    pendingInvitationError.value = err instanceof Error ? err.message : 'Failed to cancel invitation.'
  } finally {
    cancellingInviteId.value = null
  }
}

async function resendInvitation(invitation: InvitationRow) {
  if (busy.value) return
  resendingInviteId.value = invitation.id
  pendingInvitationError.value = null
  try {
    const organizationId = dashboard.organization.value?.id
    if (!organizationId || !invitation.canResend) throw new Error('Invitation details are unavailable')
    const result = await authClient.organization.inviteMember({ organizationId, email: invitation.email, role: invitation.role as 'admin' | 'owner' | 'member', resend: true })
    if (result.error) throw new Error(result.error.message || 'Failed to resend invitation')
    await refresh()
    if (loadError.value) throw loadError.value
    const delivery = data.value?.invitations.find(item => item.id === invitation.id)?.delivery
    if (!delivery?.sent) throw new Error(delivery?.message ?? 'Email delivery is unconfirmed')
    toast.add({ title: 'Invitation resent', color: 'success' })
  } catch (error) {
    pendingInvitationError.value = getErrorMessage(error, 'Failed to resend invitation')
  } finally {
    resendingInviteId.value = null
  }
}

async function removeMember(memberId: string) {
  if (busy.value) return
  removingMemberId.value = memberId
  memberError.value = null

  try {
    const organizationId = dashboard.organization.value?.id
    if (!organizationId) throw new Error('Organization context is unavailable')
    const { error } = await authClient.organization.removeMember({
      memberIdOrEmail: memberId,
      organizationId,
    })
    if (error) throw new Error(error.message || 'Failed to remove member.')
    await refresh()
    if (loadError.value) throw loadError.value
    if (!data.value || data.value.members.some(member => member.id === memberId)) throw new Error('The member removal could not be verified')
    toast.add({ title: 'Member removed', color: 'success' })
  } catch (err: unknown) {
    memberError.value = err instanceof Error ? err.message : 'Failed to remove member.'
  } finally {
    removingMemberId.value = null
  }
}

function formatDate(value: string) {
  return formatTimestamp(value, 'en', 'UTC', { dateStyle: 'medium' })
}


</script>
