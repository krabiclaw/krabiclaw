<template>
  <!--
    One row per category, each stating what currently reaches this person.
    The category is a leaf below; where there is a pane, the first opens on
    arrival rather than sitting beside an empty column.
  -->
  <DashboardIndexPanel id="account-notifications" title="Notifications" :auto-open="`${level.path.value}/${NOTIFICATION_CATEGORIES[0]}`">
    <UAlert v-if="error" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="error" class="mb-6" />
    <!-- An alert email that bounced is said here, where the address it went to is, not inside a conversation. -->
    <UAlert v-if="bounced_email" color="error" variant="soft" icon="i-lucide-mail-warning" :title="`Alerts to ${bounced_email.address} are bouncing`" :description="`The last one bounced ${new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(bounced_email.failed_at))}${bounced_email.error ? `: ${bounced_email.error}` : '.'}`" class="mb-6" />
    <EditorNavigationList :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY_LABELS, NOTIFICATION_CATEGORY_ICONS, describeNotificationSetting } from '~/shared/notification-categories'

const level = useRouteLevel()

const session = authClient.useSession()
const sessionData = computed(() => session.value.data)
const { preferences, labels, bounced_email, error, load } = useNotificationPreferences(() => sessionData.value?.user?.id)
const { locale } = useI18n()
// Read on every visit: the labels follow the person's businesses, which change outside this screen.
watch(() => sessionData.value?.user?.id, (userId) => {
  if (userId) void load(true)
}, { immediate: true })

const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'categories',
  items: NOTIFICATION_CATEGORIES.map(category => ({
    id: category,
    label: labels.value?.[category] ?? NOTIFICATION_CATEGORY_LABELS[category],
    icon: NOTIFICATION_CATEGORY_ICONS[category],
    summary: preferences.value ? describeNotificationSetting(preferences.value[category]) : '',
    to: `${level.path.value}/${category}`,
  })),
}])

useSeoMeta({ title: 'Notifications | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
