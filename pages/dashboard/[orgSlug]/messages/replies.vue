<template>
  <DashboardIndexPanel id="saved-replies" title="Saved replies">
    <template v-if="manage" #right><UButton :to="`${level.path.value}/new`" icon="i-lucide-plus" color="neutral" variant="ghost" aria-label="New saved reply" /></template>
    <UAlert v-if="error" color="error" title="Saved replies could not be loaded" :description="getErrorMessage(error, 'Saved replies request failed')" />
    <template v-else-if="data">
      <EditorNavigationList :groups="[{ id: 'replies', items: data.templates.map(reply => ({ id: reply.id, label: reply.title, summary: messageScheduleLabel(reply.schedule), to: `${level.path.value}/${encodeURIComponent(reply.id)}` })) }]" :active-item="level.child.value" />
      <p v-if="!data.templates.length" class="py-8 text-muted">No saved replies yet.</p>
      <div v-if="offset || data.pagination.hasMore" class="mt-6 flex justify-between gap-3">
        <UButton label="Previous" color="neutral" variant="outline" :disabled="!offset || status === 'pending'" @click="offset = Math.max(0, offset - 50)" />
        <UButton label="Next" color="neutral" variant="outline" :disabled="!data.pagination.hasMore || status === 'pending'" @click="offset = data.pagination.nextOffset!" />
      </div>
    </template>
  </DashboardIndexPanel>
</template>
<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
import { isMessageTemplatePage, messageScheduleLabel } from '~/lib/components/workspace/messages/guest-messaging-client'
import { getErrorMessage } from '~/utils/errors'
definePageMeta({ layout: 'dashboard' })
const level = useRouteLevel()
const dashboard = useDashboardOrganization()
const api = useDashboardApi()
const offset = ref(0)
const role = computed(() => dashboard.organization.value?.role as keyof typeof organizationRoles | undefined)
const manage = computed(() => Boolean(role.value && authClient.organization.checkRolePermission({ role: role.value, permissions: { operations: ['update'] } })))
const { data, error, status } = await useAsyncData(() => `saved-replies:${dashboard.organizationId.value}`, () => api('/api/dashboard/message-templates', { query: { limit: 50, offset: offset.value }, validate: isMessageTemplatePage }), { watch: [offset] })
useSeoMeta({ title: 'Saved replies | KrabiClaw', robots: 'noindex, nofollow' })
</script>
