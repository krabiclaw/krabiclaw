<template>
  <!--
    The team as rows, the way Airbnb lists co-hosts: one hairline list, the
    role a pill on the row. Pending invitations are a second group under its
    own heading, not a second card.
  -->
  <div class="space-y-8">
    <section>
      <UAlert
        v-if="loadError"
        class="mt-3"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="The team could not be loaded"
        :description="getErrorMessage(loadError, 'Members request failed')"
      />
      <ul v-else-if="members.length">
        <li v-for="member in members" :key="member.id" class="border-b border-default py-6 last:border-b-0">
          <div class="flex items-center justify-between gap-4">
            <NuxtLink :to="memberAvailabilityPath(member)" class="flex min-w-0 items-center gap-3">
              <UAvatar :src="member.user.image || undefined" :alt="member.user.name || member.user.email" icon="i-lucide-user" size="lg" />
              <div class="min-w-0">
                <p class="truncate text-base text-highlighted">{{ member.user.name || member.user.email }}</p>
                <p class="truncate text-sm text-muted">{{ member.user.email }}</p>
              </div>
            </NuxtLink>
            <div class="flex shrink-0 items-center gap-2">
              <USelect
                v-if="canEditMemberRole(member)"
                :model-value="member.role"
                :items="roleOptions"
                variant="soft"
                size="sm"
                :ui="{ base: 'rounded-full capitalize' }"
                :aria-label="`Role for ${member.user.name || member.user.email}`"
                :loading="roleUpdatingId === member.id"
                @update:model-value="value => onRoleSelected(member, String(value))"
              />
              <UBadge v-else :label="member.role" color="neutral" variant="soft" size="lg" class="rounded-full capitalize" />
              <UButton
                v-if="member.role !== 'owner'"
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                size="sm"
                :loading="removingMemberId === member.id"
                :aria-label="`Remove ${member.user.name || member.user.email}`"
                @click="removeMember(member.id)"
              />
            </div>
          </div>
          <UAlert
            v-if="roleUpdateError && roleUpdateErrorMemberId === member.id"
            class="mt-3"
            color="error"
            variant="soft"
            :description="roleUpdateError"
          />
        </li>
      </ul>
      <p v-else class="mt-3 px-1 text-sm text-muted">No members found for this organization.</p>
      <UAlert v-if="memberError" class="mt-4" color="error" variant="soft" icon="i-lucide-circle-alert" :description="memberError" />
    </section>

    <section v-if="invitations.length || pendingInvitationError">
      <h2 class="text-sm font-semibold text-muted">Pending invitations</h2>
      <ul v-if="invitations.length">
        <li v-for="invitation in invitations" :key="invitation.id" class="flex items-center justify-between gap-4 border-b border-default py-6 last:border-b-0">
          <div class="min-w-0">
            <p class="truncate text-base text-highlighted">{{ invitation.email }}</p>
            <p class="truncate text-sm text-muted">
              Expires {{ formatDate(invitation.expiresAt) }}
            </p>
            <p class="text-sm" :class="invitation.delivery?.status === 'failed' ? 'text-error' : 'text-muted'">
              {{ invitation.delivery?.error || (invitation.delivery ? `Email: ${invitation.delivery.provider === 'log_only' ? 'recorded locally' : invitation.delivery.status}` : 'Email delivery is unconfirmed') }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <UBadge v-if="invitation.role" :label="invitation.role" color="neutral" variant="soft" size="lg" class="rounded-full capitalize" />
            <UButton v-if="currentUserRole === 'owner' || currentUserRole === 'admin'" color="neutral" variant="ghost" :loading="resendingInviteId === invitation.id" @click="resendInvitation(invitation)">Resend</UButton>
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="sm"
              :loading="cancellingInviteId === invitation.id"
              :aria-label="`Cancel invitation for ${invitation.email}`"
              @click="cancelInvitation(invitation.id)"
            />
          </div>
        </li>
      </ul>
      <UAlert v-if="pendingInvitationError" class="mt-4" color="error" variant="soft" icon="i-lucide-circle-alert" :description="pendingInvitationError" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { formatTimestamp } from '~/utils/timezone'

import { authClient } from '~/lib/auth-client'
import { getErrorMessage } from '~/utils/errors'
import { isOrganizationMembersData, organizationMembersKey, type OrganizationMembersData } from '~/utils/organization-members'

type MemberRow = OrganizationMembersData['members'][number]
type InvitationRow = OrganizationMembersData['invitations'][number]

const route = useRoute()
const dashboardApi = useDashboardApi()

const dashboard = useDashboardOrganization()
const { data, error: loadError, refresh } = await useAsyncData(
  () => organizationMembersKey(String(route.params.orgSlug)),
  () => dashboardApi('/api/dashboard/members', { validate: isOrganizationMembersData }),
)

const members = computed(() => data.value?.members ?? [])
const invitations = computed(() => data.value?.invitations ?? [])

const session = authClient.useSession()
const currentUser = computed(() => session.value.data?.user ?? null)
const currentUserRole = computed(() => dashboard.organization.value?.role)
const isOwner = computed(() => currentUserRole.value === 'owner')

function memberAvailabilityPath(member: MemberRow) {
  const organization = dashboard.organization.value
  if (!organization) throw createError({ statusCode: 503, statusMessage: 'Dashboard context not loaded' })
  return member.userId === currentUser.value?.id
    ? `/dashboard/account/profile/calendar/${encodeURIComponent(organization.id)}`
    : `/dashboard/${encodeURIComponent(organization.slug)}/team/${encodeURIComponent(member.id)}`
}

const BASE_ROLE_OPTIONS = [
  { label: 'Member', value: 'member' }, { label: 'Admin', value: 'admin' },
]
// Owner is only offered as a choice to an existing owner — mirrors Better
// Auth's own creatorRole rule (only an owner can grant/touch the owner role),
// enforced again server-side since this is just UI affordance.
const roleOptions = computed(() => (
  isOwner.value ? [...BASE_ROLE_OPTIONS, { label: 'Owner', value: 'owner' }] : BASE_ROLE_OPTIONS
))

function canEditMemberRole(member: MemberRow): boolean {
  if (currentUserRole.value !== 'owner' && currentUserRole.value !== 'admin') return false
  // Only an owner may touch another owner's role.
  if (member.role === 'owner' && !isOwner.value) return false
  return true
}

const removingMemberId = ref<string | null>(null)
const cancellingInviteId = ref<string | null>(null)
const resendingInviteId = ref<string | null>(null)
const memberError = ref<string | null>(null)
const pendingInvitationError = ref<string | null>(null)

const roleUpdatingId = ref<string | null>(null)
const roleUpdateError = ref<string | null>(null)
const roleUpdateErrorMemberId = ref<string | null>(null)

function onRoleSelected(member: MemberRow, role: string) {
  roleUpdateError.value = null
  roleUpdateErrorMemberId.value = null
  if (role === member.role) return
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
    if (member.userId === currentUser.value?.id) {
      await dashboard.refresh()
      if (dashboard.error.value) throw dashboard.error.value
      if (dashboard.organization.value?.role !== role) throw new Error('Your role change could not be verified')
      const permission = await authClient.organization.hasPermission({ organizationId, permissions: { members: ['read'] } })
      if (permission.error) throw new Error(permission.error.message)
      if (!permission.data.success) {
        await navigateTo(memberAvailabilityPath(member))
        return
      }
    }
    await refresh()
    if (loadError.value) throw loadError.value
    if (data.value?.members.find(saved => saved.id === member.id)?.role !== role) throw new Error('The member role change could not be verified')
  } catch (err: unknown) {
    roleUpdateError.value = getErrorMessage(err, 'Failed to update member role.')
    roleUpdateErrorMemberId.value = member.id
  } finally {
    roleUpdatingId.value = null
  }
}

async function cancelInvitation(invitationId: string) {
  cancellingInviteId.value = invitationId
  pendingInvitationError.value = null

  try {
    const { error } = await authClient.organization.cancelInvitation({ invitationId })

    if (error) {
      pendingInvitationError.value = error.message ?? 'Failed to cancel invitation.'
      return
    }

    await refresh()
  } catch (err) {
    pendingInvitationError.value = err instanceof Error ? err.message : 'Failed to cancel invitation.'
  } finally {
    cancellingInviteId.value = null
  }
}

async function resendInvitation(invitation: InvitationRow) {
  resendingInviteId.value = invitation.id
  pendingInvitationError.value = null
  try {
    const organizationId = dashboard.organization.value?.id
    if (!organizationId || !['admin','owner','member'].includes(invitation.role ?? '')) throw new Error('Invitation details are unavailable')
    const result = await authClient.organization.inviteMember({ organizationId, email: invitation.email, role: invitation.role as 'admin' | 'owner' | 'member', resend: true })
    if (result.error) throw new Error(result.error.message || 'Failed to resend invitation')
    await refresh()
  } catch (error) {
    pendingInvitationError.value = getErrorMessage(error, 'Failed to resend invitation')
  } finally {
    resendingInviteId.value = null
  }
}

async function removeMember(memberId: string) {
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
