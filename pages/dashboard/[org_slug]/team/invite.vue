<template>
  <!-- Two steps, as Airbnb's co-host invite: the address first, then the role on a screen of its own, so the keyboard never hides the choice. -->
  <DashboardLeafPanel
    v-if="screen"
    id="organization-members-invite"
    :title="screen.title"
    :save-label="step === 'email' ? 'Next' : savedInvitation ? screen.resend_label : screen.save_label"
    :saving="inviting"
    :disabled="step === 'email' ? !validEmail : !selectedRoles.length"
    :error="inviteError"
    @cancel="resetInvite"
    @save="next"
  >
    <form v-if="step === 'email'" @submit.prevent="next">
      <UFormField :label="screen.email_label" required>
        <UInput v-model="email" type="email" autocomplete="email" enterkeyhint="next" autofocus class="w-full" />
      </UFormField>
    </form>
    <div v-else class="space-y-6">
      <button type="button" class="flex w-full items-center gap-3 rounded-lg border border-default p-3 text-left" :disabled="inviting" @click="step = 'email'">
        <span class="min-w-0 flex-1"><span class="block text-sm text-muted">{{ screen.email_label }}</span><span class="block truncate font-medium text-highlighted">{{ email.trim() }}</span></span>
        <span class="text-sm font-medium text-highlighted underline">Edit</span>
      </button>
      <fieldset class="space-y-2" :disabled="inviting">
        <legend class="mb-2 font-medium">{{ screen.role_label }}</legend>
        <label v-for="choice in screen.roles" :key="choice.value" class="flex cursor-pointer items-start gap-3 rounded-lg border border-default p-3">
          <input v-model="roles" type="checkbox" :value="choice.value" name="staff-role" class="mt-1">
          <span><span class="block font-medium">{{ choice.label }}</span><span class="text-sm text-muted">{{ choice.description }}</span></span>
        </label>
      </fieldset>
      <fieldset v-if="listingAccess.length && screen.listings.length" class="space-y-3" :disabled="inviting">
        <legend class="mb-2 font-medium">{{ screen.listing_label }}</legend>
        <UFormField v-for="listing in screen.listings" :key="listing.listing_id" :label="listing.label">
          <USelect v-model="grants[listing.listing_id]" :items="[{ value: 'none', label: screen.no_access_label }, ...listingAccess]" class="w-full" />
        </UFormField>
      </fieldset>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { staffInviteScreen } from '~/shared/staff-invite'
import { isOrganizationMembersData, organizationMembersKey, type OrganizationMembersData } from '~/utils/organization-members'

definePageMeta({ layout: 'dashboard' })
const route = useRoute()
const level = useRouteLevel()
const dashboard = useDashboardOrganization()
const dashboardApi = useDashboardApi()
const toast = useToast()
const rosterKey = organizationMembersKey(String(route.params.org_slug))
const { data: roster } = useNuxtData<OrganizationMembersData>(rosterKey)
const { data: screen, error } = await useAsyncData(
  () => `staff-invite:${String(route.params.org_slug)}`,
  () => dashboardApi('/api/dashboard/members', { query: { view: 'invite' }, validate: (value): value is ReturnType<typeof staffInviteScreen.parse> => staffInviteScreen.safeParse(value).success }),
)
if (error.value) throw error.value

const email = ref('')
const step = ref<'email' | 'role'>('email')
const validEmail = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()))
// No role is chosen for the owner: they pick one on its own step.
// A member may hold several roles; listing access offers what any chosen role allows.
const roles = ref<string[]>([])
const selectedRoles = computed(() => screen.value?.roles.filter(choice => roles.value.includes(choice.value)) ?? [])
const listingAccess = computed(() => [...new Map(selectedRoles.value.flatMap(choice => choice.access).map(access => [access.value, access])).values()])
const grants = ref<Record<string, string>>({})
const inviting = ref(false)
const inviteError = ref('')
const savedInvitation = ref<string | null>(null)
watch(roles, () => { grants.value = {} }, { deep: true })
watch([email, roles, grants], () => { savedInvitation.value = null }, { deep: true })

function next() {
  if (step.value === 'role') return sendInvite()
  if (validEmail.value) step.value = 'role'
}

function resetInvite() {
  email.value = ''
  step.value = 'email'
  roles.value = []
  grants.value = {}
  inviteError.value = ''
  savedInvitation.value = null
}

async function sendInvite() {
  inviting.value = true
  inviteError.value = ''
  try {
    const organizationId = screen.value?.organization_id
    if (!organizationId || organizationId !== dashboard.organization.value?.id || !selectedRoles.value.length) throw new Error('Invitation details are unavailable')
    const listingAccess = Object.entries(grants.value).filter(([, access]) => access !== 'none').map(([listing_id, access]) => ({ listing_id, access }))
    const result = await authClient.$fetch<{ id: string }>('/organization/invite-member', {
      method: 'POST', body: {
        email: email.value.trim(), role: selectedRoles.value.map(choice => choice.value), organizationId, resend: Boolean(savedInvitation.value),
        ...(listingAccess.length ? { listing_access: JSON.stringify(listingAccess) } : {}),
      },
    })
    if (result.error) throw new Error(result.error.message || 'Failed to send invite.')
    if (!result.data) throw new Error('The invitation could not be read back')
    savedInvitation.value = result.data.id
    const members = await dashboardApi('/api/dashboard/members', { validate: isOrganizationMembersData })
    roster.value = members
    const delivery = members.invitations.find(invitation => invitation.id === savedInvitation.value)?.delivery
    if (!delivery?.sent) throw new Error(delivery?.message ?? 'Invitation saved. Email delivery is unconfirmed.')
    toast.add({ title: 'Invitation sent', color: 'success' })
    await navigateTo(level.to.value ?? '/dashboard')
  } catch (error) {
    inviteError.value = error instanceof Error ? error.message : 'Failed to send invite.'
  } finally {
    inviting.value = false
  }
}
</script>
