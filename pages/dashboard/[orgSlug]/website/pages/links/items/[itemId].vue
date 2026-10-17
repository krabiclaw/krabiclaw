<template>
  <!--
    One link: its label, where it goes and whether it shows. Three fields, one
    leaf. Adding is the same screen at `links/items/new`.
  -->
  <DashboardLeafPanel
    id="organization-links-item"
    :title="isNew ? newLink.title : record?.label || 'Link'"
    :saving="editor.saving.value"
    :disabled="!form.label.trim() || !form.destination.trim()"
    :save-label="isNew ? newLink.action : undefined"
    :error="editor.loadError.value ?? editor.errorMessage.value"
    @cancel="loadDraft"
    @save="commit"
  >
    <template v-if="record" #right>
      <DashboardResourceLocalization
        :organization-id="editor.organizationId"
        resource-type="content_block"
        :resource-id="record.id"
        resource-label="link"
        :fields="[{ key: 'label', label: 'Label', source: record.label }]"
        :load-values="locale => editor.loadLinksLocalization(locale, itemId)"
        :save-values="(locale, values) => editor.saveLinksLocalization(locale, values, itemId)"
        :language-settings-path="editor.organizationLocalizationSettingsPath.value"
      />
    </template>
    <div v-if="isNew ? !editor.loadError.value : record" class="space-y-6">
      <UFormField label="Label" required>
        <UInput v-model="form.label" maxlength="120" autofocus class="w-full" />
      </UFormField>
      <UFormField label="Destination" required>
        <UInput v-model="form.destination" placeholder="/reservations or https://example.com" maxlength="2048" class="w-full" />
      </UFormField>
      <UFormField label="Status">
        <USelect v-model="form.status" :items="LINK_STATUS_OPTIONS" class="w-full" />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import { linksEditorKey, LINK_STATUS_OPTIONS } from '~/components/dashboard/LinksPageEditor.vue'
import type { LinkItemStatus } from '~/server/utils/links-page'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const editor = inject(linksEditorKey)!
const level = useRouteLevel()

const itemId = computed(() => String(route.params.itemId))
const isNew = computed(() => itemId.value === 'new')
const newLink = newRecordLabels('link')
const record = computed(() => editor.items.value.find(item => item.id === itemId.value) ?? null)
// A link that is not in the page is not a page of its own (DESIGN.md).
watchEffect(() => {
  if (!isNew.value && !editor.loadError.value && !record.value) showError(createError({ statusCode: 404, statusMessage: 'Link not found' }))
})

const form = reactive<{ label: string; destination: string; status: LinkItemStatus }>({ label: '', destination: '', status: 'active' })
function loadDraft() {
  form.label = record.value?.label ?? ''
  form.destination = record.value?.destination ?? ''
  form.status = record.value?.status ?? 'active'
}
watch(record, loadDraft, { immediate: true })

/** The page and its links are one document, so a link's Save sends the whole list with this one folded in. */
async function commit() {
  editor.saving.value = true
  editor.errorMessage.value = ''
  try {
    const nextItems = isNew.value
      ? [...editor.items.value, { label: form.label, destination: form.destination, sort_order: editor.items.value.length, status: form.status }]
      : editor.items.value.map(item => item.id === itemId.value ? { ...item, label: form.label, destination: form.destination, status: form.status } : item)
    const response = await editor.persist(nextItems)
    if (isNew.value) {
      const [createdId] = response.created_item_ids
      if (!createdId) throw new Error('The link was not created.')
      // The record it became, not the `new` form it was.
      await navigateTo(`${level.to.value}/${createdId}`, { replace: true })
      return
    }
    await navigateTo(level.to.value ?? '/dashboard')
  } catch (error) {
    editor.errorMessage.value = error instanceof ApiClientError
      ? error.message
      : error instanceof Error ? error.message : 'Unable to save link'
  } finally {
    editor.saving.value = false
  }
}
</script>
