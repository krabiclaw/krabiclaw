<template>
  <DashboardLeafPanel :id="`automatic-message-${concern}`" :title="concern === 'content' ? 'Message' : 'When it is sent'" :lead="concern === 'content' ? `The words every ${counterparty} you chose it for receives, sent on its own at its scheduled time.` : `Send this message automatically for the offerings you select, using each ${zone}.`" :saving="editor.saving.value" :disabled="editor.disabled.value" :save-label="editor.saveLabel.value" :error="editor.error.value" @cancel="editor.revert" @save="editor.save">
    <AutomaticMessageFields :concern="concern" />
  </DashboardLeafPanel>
</template>
<script setup lang="ts">
import { automaticMessageEditorKey } from '~/components/dashboard/AutomaticMessageEditorPage.vue'
import AutomaticMessageFields from '~/components/dashboard/AutomaticMessageFields.vue'
import { scheduleVocabulary } from '~/lib/components/workspace/messages/guest-messaging-client'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
definePageMeta({ layout: 'dashboard' })
const route = useRoute()
const value = String(route.params.concern)
if (!['content', 'schedule'].includes(value)) throw createError({ statusCode: 404, statusMessage: 'Automatic message concern not found' })
const concern = value as 'content' | 'schedule'
const editor = inject(automaticMessageEditorKey)!
const counterparty = computed(() => editor.vertical.value === 'service' ? resolveBookingPresentation('service', 'service').counterpartyNoun : 'guest')
const zone = computed(() => scheduleVocabulary(editor.vertical.value).zone)
</script>
