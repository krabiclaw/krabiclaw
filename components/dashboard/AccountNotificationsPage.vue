<template>
  <!--
    One row per category, each stating what currently reaches this person.
    The category is a leaf below; where there is a pane, the first opens on
    arrival rather than sitting beside an empty column.
  -->
  <DashboardIndexPanel id="account-notifications" title="Notifications" :auto-open="`${level.path.value}/${NOTIFICATION_CATEGORIES[0]}`">
    <UAlert v-if="error" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="error" class="mb-6" />
    <EditorNavigationList :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_LABELS, describeNotificationSetting } from '~/shared/notification-categories'

const level = useRouteLevel()

const session = authClient.useSession()
const sessionData = computed(() => session.value.data)
const { preferences, error, load } = useNotificationPreferences(() => sessionData.value?.user?.id)
await load()

const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'categories',
  items: NOTIFICATION_CATEGORIES.map(category => ({
    id: category,
    label: NOTIFICATION_CATEGORY_LABELS[category],
    summary: preferences.value ? describeNotificationSetting(preferences.value[category]) : '',
    to: `${level.path.value}/${category}`,
  })),
}])

useSeoMeta({ title: 'Notifications | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
