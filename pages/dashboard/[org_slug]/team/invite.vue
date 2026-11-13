<template>
  <DashboardLeafPanel
    id="organization-members-invite"
    title="Invite a team member"
    :save-label="savedInvitation ? 'Resend invite' : 'Send invite'"
    :saving="inviting"
    :disabled="!inviteForm.email.trim() || !inviteForm.role"
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
const toast = useToast()

const { data, error } = await useAsyncData(
  () => organizationMembersKey(String(route.params.org_slug)),
  () => dashboardApi('/api/dashboard/members', { validate: isOrganizationMembersData }),
)
if (error.value) throw error.value
const roleOptions = computed(() => data.value?.inviteRoles ?? [])
const inviteForm = reactive({ email: '', role: roleOptions.value[0]?.value })
const inviting = ref(false)
const inviteError = ref<string | null>(null)
const savedInvitation = ref<string | null>(null)
watch(() => [inviteForm.email,inviteForm.role], () => { savedInvitation.value = null })

function resetInvite() {
  Object.assign(inviteForm, { email: '', role: roleOptions.value[0]?.value })
  inviteError.value = null
  savedInvitation.value = null
}

async function sendInvite() {
  inviting.value = true
  inviteError.value = null
  try {
    const organizationId = dashboard.organization.value?.id
    if (!organizationId || !inviteForm.role) throw new Error('Invitation details are unavailable')
    const result = await authClient.organization.inviteMember({
      email: inviteForm.email,
      role: inviteForm.role,
      organizationId,
      resend: Boolean(savedInvitation.value),
    })
    if (result.error) throw new Error(result.error.message || 'Failed to send invite.')
    if (!result.data) throw new Error('The invitation could not be read back')
    savedInvitation.value = result.data.id
    const members = await dashboardApi('/api/dashboard/members', {validate:isOrganizationMembersData})
    const delivery = members.invitations.find(invitation => invitation.id === result.data!.id)?.delivery
    await refreshNuxtData(organizationMembersKey(String(route.params.org_slug ?? '')))
    if (!delivery?.sent) throw new Error(delivery?.message ?? 'Invitation saved. Email delivery is unconfirmed.')
    toast.add({ title: 'Invitation sent', color: 'success' })
    resetInvite()
    await navigateTo(level.to.value ?? '/dashboard')
  } catch (error) {
    inviteError.value = error instanceof Error ? error.message : 'Failed to send invite.'
  } finally {
    inviting.value = false
  }
}
</script>
