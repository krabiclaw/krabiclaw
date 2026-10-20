<template>
  <DashboardLeafPanel
    id="organization-members-invite"
    title="Invite a team member"
    :save-label="savedInvitation ? 'Resend invite' : 'Send invite'"
    :saving="inviting"
    :disabled="!inviteForm.email.trim()"
    :error="inviteError ?? ''"
    @cancel="resetInvite"
    @save="sendInvite"
  >
    <div class="space-y-6">
      <UFormField label="Email address" required>
        <UInput v-model="inviteForm.email" type="email" placeholder="teammate@example.com" autofocus class="w-full" />
      </UFormField>
      <UFormField label="Role">
        <USelect v-model="inviteForm.role" :items="roleOptions" class="w-full" />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { isOrganizationMembersData, organizationMembersKey } from '~/utils/organization-members'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const level = useRouteLevel()
const dashboard = useDashboardOrganization()
const dashboardApi = useDashboardApi()

const isOwner = computed(() => dashboard.organization.value?.role === 'owner')
const BASE_ROLE_OPTIONS = [
  { label: 'Member — own scheduling', value: 'member' },
  { label: 'Admin', value: 'admin' },
]
// Owner is offered only to an owner, as Better Auth's creatorRole rule has it; enforced again server-side.
const roleOptions = computed(() => (isOwner.value ? [...BASE_ROLE_OPTIONS, { label: 'Owner', value: 'owner' }] : BASE_ROLE_OPTIONS))

const inviteForm = reactive({ email: '', role: 'admin' })
const inviting = ref(false)
const inviteError = ref<string | null>(null)
const savedInvitation = ref<string | null>(null)
watch(() => [inviteForm.email,inviteForm.role], () => { savedInvitation.value = null })

function resetInvite() {
  Object.assign(inviteForm, { email: '', role: 'admin' })
  inviteError.value = null
  savedInvitation.value = null
}

async function sendInvite() {
  inviting.value = true
  inviteError.value = null
  try {
    const organizationId = dashboard.organization.value?.id
    if (!organizationId) throw new Error('Organization context is unavailable')
    const result = await authClient.organization.inviteMember({
      email: inviteForm.email,
      role: inviteForm.role as 'admin' | 'owner' | 'member',
      organizationId,
      resend: Boolean(savedInvitation.value),
    })
    if (result.error) throw new Error(result.error.message || 'Failed to send invite.')
    if (!result.data) throw new Error('The invitation could not be read back')
    savedInvitation.value = result.data.id
    const members = await dashboardApi('/api/dashboard/members', {validate:isOrganizationMembersData})
    const delivery = members.invitations.find(invitation => invitation.id === result.data!.id)?.delivery
    await refreshNuxtData(organizationMembersKey(String(route.params.orgSlug ?? '')))
    if (!delivery || ['pending','failed'].includes(delivery.status)) throw new Error(delivery?.error || 'Invitation is saved, but email delivery is unconfirmed. You can resend it.')
    resetInvite()
    await navigateTo(level.to.value ?? '/dashboard')
  } catch (error) {
    inviteError.value = error instanceof Error ? error.message : 'Failed to send invite.'
  } finally {
    inviting.value = false
  }
}
</script>
