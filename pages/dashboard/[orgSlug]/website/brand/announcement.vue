<template>
  <!--
    The announcement as an index: whether it shows, then its headline,
    description, button and image, each previewing its value and opening its
    own leaf. Seven controls in one pane was a form, not a leaf (DESIGN.md).
  -->
  <DashboardIndexPanel id="organization-announcement" title="Announcement" :auto-open="groups[0]?.items[0]?.to ?? null">
    <EditorNavigationList :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
const level = useRouteLevel()
const to = (segment: string) => `${level.path.value}/${segment}`

const groups = computed<EditorNavigationGroup[]>(() => {
  const form = editor.form
  const button = [form.announcementCtaLabel, form.announcementCtaUrl].filter(value => value.trim()).join(' · ')
  const visibilitySummary = form.announcementEnabled
    ? (form.announcementFormat === 'banner' ? (form.announcementDismissible ? 'Banner' : 'Persisted banner') : 'Popup')
    : 'Off'
  return [
    { id: 'visibility', items: [{ id: 'visibility', label: 'Show announcement', summary: visibilitySummary, to: to('visibility') }] },
    {
      id: 'content',
      items: [
        { id: 'headline', label: 'Headline', summary: form.announcementHeadline || undefined, to: to('headline') },
        { id: 'description', label: 'Description (optional)', summary: form.announcementDescription || undefined, to: to('description') },
        { id: 'button', label: 'Button (optional)', summary: button || undefined, to: to('button') },
        { id: 'image', label: 'Image (optional)', to: to('image') },
      ],
    },
  ]
})
</script>
