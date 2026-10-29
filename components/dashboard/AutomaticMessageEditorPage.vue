<template>
  <DashboardLeafPanel v-if="isNew" id="new-automatic-message" :title="createLabels.title" lead="A message sent on its own to every guest at the homes you choose, at the time you choose." :saving="saving" :disabled="disabled" :save-label="saveLabel" :error="error" @cancel="revert" @save="commit">
    <UButton v-if="recoveryLabel" :label="recoveryLabel" color="neutral" variant="outline" class="mb-6" :disabled="saving" @click="recover" />
    <UForm :state="draft" :disabled="saving" @submit="commit"><AutomaticMessageFields /></UForm>
  </DashboardLeafPanel>
  <DashboardIndexPanel v-else id="automatic-message" :title="saved?.title ?? 'Automatic message'" :auto-open="`${level.path.value}/content`">
    <template v-if="saved && manage" #right><UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" aria-label="Delete automatic message" :disabled="saving" @click="deleteOpen = true" /></template>
    <UAlert v-if="loadError" color="error" title="Automatic message could not be loaded" :description="loadError" />
    <EditorNavigationList v-else :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
  <UModal v-model:open="deleteOpen" title="Delete automatic message" description="Its pending messages are cancelled. Messages already sent stay in each conversation." :dismissible="!saving">
    <template #body><UAlert v-if="actionError" color="error" :description="actionError" /></template>
    <template #footer><UButton label="Cancel" color="neutral" variant="link" :disabled="saving" @click="deleteOpen = false" /><UButton label="Delete automatic message" color="error" :loading="saving" @click="remove" /></template>
  </UModal>
</template>
<script lang="ts">
import type { InjectionKey, Ref, ComputedRef } from 'vue'
import type { MessageTemplate, GuestMessageSchedule } from '~/lib/components/workspace/messages/guest-messaging-client'
export interface AutomaticMessageEditor {
  draft: Ref<{ title: string; body: string; schedule: GuestMessageSchedule }>
  homes: ComputedRef<{ product_id: string; name: string; timezone: string }[]>
  homesError: ComputedRef<string>
  manage: ComputedRef<boolean>
  saving: Ref<boolean>
  error: ComputedRef<string>
  disabled: ComputedRef<boolean>
  saveLabel: ComputedRef<string | undefined>
  save: () => Promise<void>
  revert: () => void
  recoveryLabel: ComputedRef<string | null>
  recover: () => Promise<void>
}
export const automaticMessageEditorKey = Symbol('automatic-message-editor') as InjectionKey<AutomaticMessageEditor>
</script>
<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import AutomaticMessageFields from '~/components/dashboard/AutomaticMessageFields.vue'
import { isNavigationFailure } from 'vue-router'
import { authClient } from '~/lib/auth-client'
import type { organizationRoles } from '~/utils/organization-access'
import { isMessageTemplateResponse, isMessageTemplatePage, messageScheduleLabel } from '~/lib/components/workspace/messages/guest-messaging-client'
import { isRecord } from '~/utils/api-clients'
import { getErrorMessage, isNotFoundError } from '~/utils/errors'

const route = useRoute()
const level = useRouteLevel()
const dashboard = useDashboardOrganization()
const api = useDashboardApi()
const templateId = computed(() => String(route.params.templateId))
const isNew = computed(() => templateId.value === 'new')
const createLabels = newRecordLabels('automatic message')
const role = computed(() => dashboard.organization.value?.role as keyof typeof organizationRoles | undefined)
const manage = computed(() => Boolean(role.value && authClient.organization.checkRolePermission({ role: role.value, permissions: { operations: ['update'] } })))
const key = `automatic-message:${dashboard.organizationId.value}:${templateId.value}`
const { data, error: readError, refresh } = await useAsyncData(key, () => isNew.value ? Promise.resolve(null) : api(`/api/dashboard/message-templates/${encodeURIComponent(templateId.value)}`, { validate: isMessageTemplateResponse }))
watchEffect(() => { if (isNotFoundError(readError.value)) showError(createError({ statusCode: 404, statusMessage: 'Automatic message not found' })) })
const saved = computed(() => data.value?.template ?? null)
const empty = () => ({ title: '', body: '', schedule: { trigger: 'check_in', offsetDays: -1, localTime: '10:00', productIds: [] } as GuestMessageSchedule })
const draft = useState(`${key}:draft`, empty)
const creation = useState(`${key}:creation`, () => ({ id: null as string | null, uncertain: false }))
const clone = (reply: MessageTemplate) => ({ title: reply.title, body: reply.body, schedule: JSON.parse(JSON.stringify(reply.schedule)) as GuestMessageSchedule })
watch(saved, reply => { if (reply) draft.value = clone(reply) }, { immediate: true })
const saving = ref(false)
const actionError = ref('')
const deleteOpen = ref(false)
const loadError = computed(() => readError.value ? getErrorMessage(readError.value, 'The automatic message could not be loaded') : '')
const error = computed(() => loadError.value || actionError.value)
const { data: homesData, error: homesReadError } = await useAsyncData(`automatic-message-homes:${dashboard.organizationId.value}`, () => api('/api/dashboard/stay-homes', {
  validate: (value): value is { homes: { product_id: string; name: string; timezone: string }[] } => isRecord(value) && Array.isArray(value.homes) && value.homes.every(home => isRecord(home) && typeof home.product_id === 'string' && typeof home.name === 'string' && typeof home.timezone === 'string'),
}))
const homes = computed(() => homesData.value?.homes ?? [])
const homesError = computed(() => homesReadError.value ? getErrorMessage(homesReadError.value, 'Homes could not be loaded') : '')
watchEffect(() => { if (level.child.value && (isNew.value || !['content', 'schedule'].includes(level.child.value))) showError(createError({ statusCode: 404, statusMessage: 'Automatic message concern not found' })) })
const valid = computed(() => {
  if (!draft.value.title.trim() || !draft.value.body.trim()) return false
  const schedule = draft.value.schedule
  return (!homesError.value && schedule.productIds.length > 0 && schedule.productIds.length <= 100 && schedule.productIds.every(id => homes.value.some(home => home.product_id === id))
    && (schedule.trigger === 'booking_received' || (Number.isInteger(schedule.offsetDays) && schedule.offsetDays >= -7 && schedule.offsetDays <= 7 && /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime))))
})
const dirty = computed(() => !saved.value || JSON.stringify(draft.value) !== JSON.stringify(clone(saved.value)))
const saveLabel = computed(() => isNew.value ? createLabels.action : undefined)
const disabled = computed(() => saving.value || !manage.value || Boolean(loadError.value) || !valid.value || !dirty.value || isNew.value && Boolean(creation.value.id || creation.value.uncertain))
const recoveryLabel = computed(() => !isNew.value ? null : creation.value.id ? 'Open created automatic message' : creation.value.uncertain ? 'Review automatic messages before creating another' : null)
const groups = computed<EditorNavigationGroup[]>(() => [{ id: 'automatic-message', items: [
  { id: 'content', label: 'Message', summary: draft.value.body || 'Write the message', to: `${level.path.value}/content` },
  { id: 'schedule', label: 'When it is sent', summary: messageScheduleLabel(draft.value.schedule), to: `${level.path.value}/schedule` },
] }])

function revert() { draft.value = saved.value ? clone(saved.value) : empty(); actionError.value = '' }
async function commit() {
  if (saving.value || disabled.value) return
  saving.value = true
  actionError.value = ''
  try {
    if (isNew.value) creation.value.uncertain = true
    const result = await api(isNew.value ? '/api/dashboard/message-templates' : `/api/dashboard/message-templates/${encodeURIComponent(templateId.value)}`, {
      method: isNew.value ? 'POST' : 'PUT', body: { ...draft.value, ...(saved.value ? { expectedVersion: saved.value.version } : {}) }, validate: isMessageTemplateResponse,
    })
    if (isNew.value) creation.value = { id: result.template.id, uncertain: false }
    await refreshNuxtData([`automatic-messages:${dashboard.organizationId.value}`, `reply-picker:${dashboard.organizationId.value}`])
    if (isNew.value) {
      await recover()
    } else {
      await refresh()
      if (readError.value) throw readError.value
      await navigateTo(level.path.value)
    }
  } catch (cause) { actionError.value = `${getErrorMessage(cause, 'The automatic message could not be saved')}${isNew.value ? creation.value.id ? ' The reply was created. Open it to continue.' : ' Its creation could not be confirmed. Review automatic messages before creating another.' : ''}` }
  finally { saving.value = false }
}
async function recover() {
  actionError.value = ''
  try {
    if (creation.value.id) {
      await api(`/api/dashboard/message-templates/${encodeURIComponent(creation.value.id)}`, { validate: isMessageTemplateResponse })
      const navigation = await navigateTo(`${level.path.value.replace(/\/new$/, '')}/${encodeURIComponent(creation.value.id)}`)
      if (isNavigationFailure(navigation)) throw navigation
    } else {
      await api('/api/dashboard/message-templates', { query: { limit: 50, offset: 0 }, validate: isMessageTemplatePage })
      await refreshNuxtData(`automatic-messages:${dashboard.organizationId.value}`)
      const navigation = await navigateTo(level.to.value!)
      if (isNavigationFailure(navigation)) throw navigation
    }
    clearNuxtState(`${key}:draft`, { reset: true })
    clearNuxtState(`${key}:creation`, { reset: true })
  } catch (cause) { actionError.value = getErrorMessage(cause, 'Automatic messages could not be reviewed. Do not create the reply again until you can review the result.') }
}
async function remove() {
  if (!saved.value || saving.value || !manage.value) return
  saving.value = true
  actionError.value = ''
  try {
    await api(`/api/dashboard/message-templates/${encodeURIComponent(saved.value.id)}`, { method: 'DELETE', body: { expectedVersion: saved.value.version }, validate: (value): value is { status: 'deleted' } => isRecord(value) && value.status === 'deleted' })
    await refreshNuxtData([`automatic-messages:${dashboard.organizationId.value}`, `reply-picker:${dashboard.organizationId.value}`])
    clearNuxtState(`${key}:draft`, { reset: true })
    await navigateTo(level.to.value!)
  } catch (cause) { actionError.value = getErrorMessage(cause, 'The automatic message could not be deleted') }
  finally { saving.value = false }
}
provide(automaticMessageEditorKey, { draft, homes, homesError, manage, saving, error, disabled, saveLabel, save: commit, revert, recoveryLabel, recover })
</script>
