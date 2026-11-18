<template>
  <DashboardIndexPanel id="automatic-messages" title="Automatic messages">
    <template v-if="data?.can_manage" #right><UButton :to="`${level.path.value}/new`" icon="i-lucide-plus" color="neutral" variant="ghost" aria-label="New automatic message" /></template>
    <UAlert v-if="error" color="error" title="Automatic messages could not be loaded" :description="getErrorMessage(error, 'Automatic messages request failed')" />
    <template v-else-if="data">
      <EditorNavigationList :groups="[{ id: 'automatic', items: data.templates.map(reply => ({ id: reply.id, label: reply.title, summary: reply.schedule_label, to: `${level.path.value}/${encodeURIComponent(reply.id)}` })) }]" :active-item="level.child.value" />
      <p v-if="!data.templates.length" class="py-8 text-muted">No automatic messages yet.</p>
      <div v-if="offset || data.pagination.has_more" class="mt-6 flex justify-between gap-3">
        <UButton label="Previous" color="neutral" variant="outline" :disabled="!offset || status === 'pending'" @click="offset = Math.max(0, offset - 50)" />
        <UButton label="Next" color="neutral" variant="outline" :disabled="!data.pagination.has_more || status === 'pending'" @click="offset = data.pagination.next_offset!" />
      </div>
    </template>
  </DashboardIndexPanel>
</template>
<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import { isMessageTemplatePage } from '~/lib/components/workspace/messages/guest-messaging-client'
import { getErrorMessage } from '~/utils/errors'
definePageMeta({ layout: 'dashboard' })
const level = useRouteLevel()
const dashboard = useDashboardOrganization()
const api = useDashboardApi()
const offset = ref(0)
const { data, error, status } = await useAsyncData(() => `automatic-messages:${dashboard.organizationId.value}`, () => api('/api/dashboard/message-templates', { query: { limit: 50, offset: offset.value }, validate: isMessageTemplatePage }), { watch: [offset] })
useSeoMeta({ title: 'Automatic messages | Blawby', robots: 'noindex, nofollow' })
</script>
