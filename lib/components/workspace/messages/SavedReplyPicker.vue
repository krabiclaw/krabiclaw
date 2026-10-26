<template>
  <UPopover v-model:open="open">
    <UButton label="Saved reply" icon="i-lucide-message-square-text" color="neutral" variant="ghost" size="sm" :disabled="disabled" />
    <template #content>
      <div class="w-80 max-w-[calc(100vw-2rem)] space-y-3 p-4">
        <UAlert v-if="error" color="error" title="Saved replies could not be loaded" :description="getErrorMessage(error, 'Saved replies request failed')" />
        <template v-else-if="data">
          <div class="max-h-72 overflow-y-auto">
            <UButton v-for="reply in data.templates" :key="reply.id" :label="reply.title" color="neutral" variant="ghost" class="w-full justify-start text-left" @click="choose(reply.body)" />
            <p v-if="!data.templates.length" class="py-3 text-sm text-muted">No saved replies yet.</p>
          </div>
          <div v-if="offset || data.pagination.hasMore" class="flex justify-between gap-3">
            <UButton label="Previous" color="neutral" variant="link" :disabled="!offset || status === 'pending'" @click="offset = Math.max(0, offset - 50)" />
            <UButton label="Next" color="neutral" variant="link" :disabled="!data.pagination.hasMore || status === 'pending'" @click="offset = data.pagination.nextOffset!" />
          </div>
        </template>
        <p v-else role="status" class="text-sm text-muted">Loading saved replies…</p>
        <UButton :to="`/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/messages/replies`" label="Manage saved replies" color="neutral" variant="link" @click="open = false" />
      </div>
    </template>
  </UPopover>
</template>
<script setup lang="ts">
import { isMessageTemplatePage } from './guest-messaging-client'
import { getErrorMessage } from '~/utils/errors'
defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ insert: [body: string] }>()
const route = useRoute()
const dashboard = useDashboardOrganization()
const api = useDashboardApi()
const open = ref(false)
const offset = ref(0)
const { data, error, status, refresh } = await useAsyncData(() => `reply-picker:${dashboard.organizationId.value}`, () => api('/api/dashboard/message-templates', { query: { limit: 50, offset: offset.value }, validate: isMessageTemplatePage }), { immediate: false, watch: [offset] })
watch(open, value => { if (value) void refresh() })
function choose(body: string) { emit('insert', body); open.value = false }
</script>
