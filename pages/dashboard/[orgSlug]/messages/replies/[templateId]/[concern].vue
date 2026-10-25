<template>
  <DashboardLeafPanel :id="`saved-reply-${concern}`" :title="concern === 'content' ? 'Reply' : 'Automatic schedule'" :lead="concern === 'content' ? 'Save words you reuse, then insert them into a conversation before sending.' : 'Send this reply automatically for the homes you select, using each home’s time zone.'" :saving="editor.saving.value" :disabled="editor.disabled.value" :save-label="editor.saveLabel.value" :error="editor.error.value" @cancel="editor.revert" @save="editor.save">
    <SavedReplyFields :concern="concern" />
  </DashboardLeafPanel>
</template>
<script setup lang="ts">
import { savedReplyEditorKey } from '~/components/dashboard/SavedReplyEditorPage.vue'
import SavedReplyFields from '~/components/dashboard/SavedReplyFields.vue'
definePageMeta({ layout: 'dashboard' })
const route = useRoute()
const value = String(route.params.concern)
if (!['content', 'schedule'].includes(value)) throw createError({ statusCode: 404, statusMessage: 'Saved reply concern not found' })
const concern = value as 'content' | 'schedule'
const editor = inject(savedReplyEditorKey)!
</script>
