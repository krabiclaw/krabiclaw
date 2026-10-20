<template>
  <DashboardLeafPanel
    id="post-publishing"
    :title="post.sectionLabels.value.publishing"
    lead="Choose exactly where this post goes. Each place shows what happened there."
    :saving="post.editor.publishing.value"
    :disabled="!selected.length"
    :save-label="selected.length > 1 ? `Publish to ${selected.length}` : 'Publish'"
    :error="post.loadError.value || post.editor.error.value || ''"
    @cancel="post.revert"
    @save="publish"
  >
    <div class="space-y-5">
      <UAlert v-if="connectionsError" color="warning" variant="soft" icon="i-lucide-triangle-alert" title="Connections could not be read" :description="connectionsError" />

      <!-- One row per place, a switch for each one this publish can reach. -->
      <ul>
        <li v-for="row in rows" :key="row.channel" class="flex items-start gap-3 border-b border-default py-6 last:border-b-0">
          <UIcon :name="row.icon" class="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="text-base text-highlighted">{{ row.name }}<span v-if="row.target" class="font-normal text-muted"> · {{ row.target }}</span></p>
            <p class="mt-0.5 text-sm" :class="row.tone">{{ row.state }}</p>
            <p v-if="row.detail" class="mt-1 text-xs text-muted">{{ row.detail }}</p>
            <div class="mt-2 flex flex-wrap gap-2">
              <UButton v-if="row.url" :to="row.url" target="_blank" size="xs" color="neutral" variant="soft" icon="i-lucide-external-link">View</UButton>
              <UButton v-if="row.reconcileId" size="xs" color="neutral" variant="outline" :loading="reconciling === row.reconcileId" @click="reconcile(row.reconcileId)">Check with {{ row.name }}</UButton>
              <UButton v-if="row.connectUrl" :to="row.connectUrl" size="xs" color="neutral" variant="link">Connect</UButton>
            </div>
          </div>
          <USwitch
            v-if="row.selectable"
            :model-value="selected.includes(row.channel)"
            :aria-label="`Publish to ${row.name}`"
            class="shrink-0"
            @update:model-value="toggle(row.channel, $event)"
          />
        </li>
      </ul>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { postEditorKey } from '~/components/dashboard/PostEditorPage.vue'
import type { PublishOutcome, PublishTarget, SocialChannel } from '~/composables/usePostEditor'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const post = inject(postEditorKey)!
const dashboardApi = useDashboardApi()
const dashboardLocation = useDashboardLocation()

interface Channel { channel: SocialChannel; connected: boolean; target_id: string | null; target_name: string | null; connection_revision: string | null; problems: Array<{ code: string; message: string }>; connect_url: string }
const isConnections = (value: unknown): value is { channels: Channel[] } => isRecord(value) && Array.isArray(value.channels)
// The same answer get_social_connections gives an assistant.
const { data: connections, error } = await useAsyncData(
  () => `post-publish-targets:${dashboardLocation.currentLocationId.value ?? ''}`,
  () => dashboardApi('/api/integrations/social-connections', { query: { locationId: dashboardLocation.currentLocationId.value ?? '' }, validate: isConnections }),
)
const connectionsError = computed(() => (error.value ? getErrorMessage(error.value, 'Failed to read connections') : null))

const lastOutcomes = ref<PublishOutcome[]>([])
const selected = ref<Array<'organization' | SocialChannel>>([])
const reconciling = ref<string | null>(null)

const CHANNELS: Record<SocialChannel, { name: string; icon: string }> = {
  facebook: { name: 'Facebook', icon: 'i-logos-facebook' },
  instagram: { name: 'Instagram', icon: 'i-skill-icons-instagram' },
  discord: { name: 'Discord', icon: 'i-logos-discord-icon' },
}

const STATE_WORDS: Record<string, string> = {
  published: 'Published', preparing: 'Being prepared', publishing: 'Publishing', failed: 'Not published', unknown: 'Outcome unknown — check it', removed: 'Removed from the channel',
}

const rows = computed(() => {
  const record = post.post.value
  const publications = Array.isArray(record?.publications) ? record!.publications as ApiRecord[] : []
  const outcome = (channel: string) => lastOutcomes.value.find(item => item.channel === channel)
  const website = {
    channel: 'organization' as const, name: 'Website', icon: 'i-lucide-globe', target: null as string | null,
    selectable: record?.status !== 'published',
    state: record?.status === 'published' ? 'Live' : 'Draft — not public yet',
    tone: record?.status === 'published' ? 'text-success' : 'text-muted',
    detail: outcome('organization')?.message ?? null,
    url: record?.status === 'published' ? (typeof record.canonical_url === 'string' ? record.canonical_url : null) : null,
    reconcileId: null as string | null, connectUrl: null as string | null,
  }
  const social = (connections.value?.channels ?? []).map((channel) => {
    const publication = publications.find(item => item.channel === channel.channel)
    const { name, icon } = CHANNELS[channel.channel]
    const state = publication ? String(publication.state) : null
    const blocked = !channel.connected || channel.problems.length > 0
    return {
      channel: channel.channel, name, icon,
      target: channel.target_name,
      selectable: !blocked && (!publication || state === 'failed' || state === 'preparing'),
      state: state ? STATE_WORDS[state] ?? state : blocked ? channel.problems.map(problem => problem.message).join(' ') || 'Not connected' : 'Not published there',
      tone: state === 'published' ? 'text-success' : state === 'failed' || state === 'unknown' ? 'text-warning' : 'text-muted',
      detail: outcome(channel.channel)?.message ?? (publication?.message ? String(publication.message) : null)
        ?? (publication?.local_content_changed ? 'The website post changed after this was sent; the post there was not edited.' : null),
      url: typeof publication?.public_url === 'string' ? publication.public_url : null,
      reconcileId: state === 'unknown' ? String(publication!.id) : null,
      connectUrl: channel.connected ? null : channel.connect_url,
    }
  })
  return [website, ...social]
})

// A prepared article post arrives with Facebook chosen for review. The saved
// connection still decides whether that choice is available and names its Page.
const route = useRoute()
let preparedSelectionApplied = false
watchEffect(() => {
  if (preparedSelectionApplied || route.query.channel !== 'facebook') return
  const facebook = rows.value.find(row => row.channel === 'facebook')
  if (!facebook) return
  preparedSelectionApplied = true
  if (facebook.selectable) selected.value = ['facebook']
})

function toggle(channel: 'organization' | SocialChannel, checked: boolean) {
  selected.value = checked ? [...new Set([...selected.value, channel])] : selected.value.filter(item => item !== channel)
}

async function publish() {
  const targets: PublishTarget[] = selected.value.map((channel) => {
    if (channel === 'organization') return { channel }
    const connection = connections.value!.channels.find(item => item.channel === channel)!
    return { channel, target_id: connection.target_id!, connection_revision: connection.connection_revision! }
  })
  const result = await post.editor.publish(post.postId.value, targets)
  if (!result) return
  lastOutcomes.value = result.outcomes
  selected.value = []
}

async function reconcile(publicationId: string) {
  reconciling.value = publicationId
  try { await post.editor.reconcile(post.postId.value, publicationId) } finally { reconciling.value = null }
}
</script>
