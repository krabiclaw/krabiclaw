<template>
  <DashboardLeafPanel
    id="organization-delete"
    title="Delete organization"
    :footer="false"
  >
    <p class="text-base text-muted">
      Permanently deletes this organization, its site, locations, content and media, and removes access for its other members. Your Stripe account stays open so you can still manage payments already taken in Stripe; no new payments are accepted. This cannot be undone.
    </p>
    <UAlert v-if="permissionError || deletionError" class="mt-4" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="permissionError || deletionError" />
    <UFormField class="mt-6" label="Type DELETE to confirm">
      <UInput v-model="confirmText" placeholder="DELETE" :disabled="deleting || !canDelete" class="w-full" />
    </UFormField>
    <UButton class="mt-6" color="error" variant="solid" size="lg" :disabled="confirmText !== 'DELETE' || !canDelete" :loading="deleting" @click="deleteOrganization">Delete permanently</UButton>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { useOrganizationDeletePermission } from '~/composables/useOrganizationDeletePermission'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const level = useRouteLevel()
const organizationId = computed(() => String(route.params.organizationId))
const { deletable, permissionError } = await useOrganizationDeletePermission(computed(() => [organizationId.value]))
const canDelete = computed(() => deletable.value.has(organizationId.value))
const confirmText = ref('')
const deleting = ref(false)
const deletionError = ref('')

// Better Auth decides who may delete; a member it refuses has no such page.
watchEffect(() => {
  if (level.mode.value === 'yield' || permissionError.value) return
  if (!canDelete.value) showError(createError({ statusCode: 403, statusMessage: 'Only an owner can delete this organization' }))
})

// Better Auth owns the deletion, its owner permission and the Stripe gate;
// KrabiClaw contributes only its registered external-resource cleanup hook.
// The organization deleted is the one this URL names, never the active one.
async function deleteOrganization() {
  if (confirmText.value !== 'DELETE' || !canDelete.value) return
  deleting.value = true
  deletionError.value = ''
  try {
    const { error } = await authClient.organization.delete({ organizationId: organizationId.value })
    if (error) throw new Error(error.message || 'Deletion failed. Please try again.')
    // Better Auth's client refreshes its organization list and the session (whose
    // active organization the delete may have cleared) on its own.
    await navigateTo('/dashboard/account/profile/organizations', { replace: true })
  } catch (error) {
    deletionError.value = error instanceof Error ? error.message : 'Deletion failed. Please try again.'
  } finally {
    deleting.value = false
  }
}

useSeoMeta({ title: 'Delete organization | KrabiClaw', robots: 'noindex, nofollow' })
</script>
