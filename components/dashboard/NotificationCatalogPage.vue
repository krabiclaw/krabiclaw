<template>
  <!--
    Rows preview what each event sends; one event opens at a time with both
    channels beside each other, which is the only way to tell whether they agree.
  -->
  <DashboardIndexPanel id="notification-catalog" title="Messages" :auto-open="entries[0] ? `${level.path.value}/${entries[0].id}` : null">
    <UAlert v-if="error" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="error" class="mb-6" />
    <EditorNavigationList :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'

const level = useRouteLevel()
const { entries, error } = await useNotificationCatalog()

const groups = computed<EditorNavigationGroup[]>(() => {
  const owner = entries.value.filter(entry => entry.audience === 'owner')
  const guest = entries.value.filter(entry => entry.audience === 'guest')
  const row = (entry: typeof entries.value[number]) => ({
    id: entry.id,
    label: entry.title,
    // What this event actually sends, which is the question the page answers.
    summary: entry.channels.join(' and '),
    to: `${level.path.value}/${entry.id}`,
  })
  return [
    { id: 'owner', label: 'Owner alerts', items: owner.map(row) },
    { id: 'guest', label: 'Guest and account', items: guest.map(row) },
  ].filter(group => group.items.length)
})

useSeoMeta({ title: 'Messages | KrabiClaw', robots: 'noindex, nofollow' })
</script>
