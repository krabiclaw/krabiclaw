<template>
  <!-- How this person writes to guests: each choice is theirs, whatever their role. -->
  <div class="space-y-6">
    <USwitch v-model="suggestionsOn" label="Suggested replies" description="When a guest writes, drafted replies appear above the message field. Tap one to put it in the field, then edit before sending." />
    <!-- The business's automatic messages, and the outbox: every message sent and still to send this person may see. -->
    <nav class="-mx-2 flex flex-col">
      <NuxtLink v-for="link in links" :key="link.to" :to="link.to" class="flex items-center gap-3 rounded-xl px-2 py-3 text-base text-highlighted hover:bg-elevated" @click="emit('navigate')">
        <UIcon :name="link.icon" class="size-5 text-muted" />
        <span class="flex-1">{{ link.label }}</span>
        <UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
      </NuxtLink>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { useSuggestedReplies } from './guest-messaging-client'

const props = defineProps<{ manage: boolean }>()
const emit = defineEmits<{ navigate: [] }>()
const route = useRoute()
const listPath = computed(() => `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/messages`)
const links = computed(() => [
  // The business's automatic messages and its schedule are for those who manage messaging.
  ...(props.manage ? [{ label: 'Automatic messages', icon: 'i-lucide-message-square-text', to: `${listPath.value}/automatic` }] : []),
  // Managers see every automatic message there; each person sees their own Send later replies.
  { label: 'Sent and upcoming', icon: 'i-lucide-clock', to: `${listPath.value}/scheduled` },
  // Guests a member blocked are out of every list until unblocked, from their conversation's sheet; anyone who reads guest conversations reaches them.
  { label: 'Blocked guests', icon: 'i-lucide-ban', to: `${listPath.value}?blocked=` },
])
const dashboard = useDashboardOrganization()
const suggestionsOn = useSuggestedReplies(() => dashboard.organizationId.value)
</script>
