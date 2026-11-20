<template>
  <DashboardListItemDialog v-model:open="open" :title="agreement.label" :show-actions="false">
    <iframe :src="agreement.url" :title="agreement.file_name" class="h-[55vh] w-full rounded-xl bg-elevated" data-testid="agreement-document" />
    <form class="mt-5" @submit.prevent="sign">
      <AgreementSignFields v-model:name="name" v-model:consent="consent" :document="agreement.label" :disabled="saving" />
      <UAlert v-if="error" class="mt-4" color="error" variant="soft" icon="i-lucide-circle-alert" :description="error" />
      <UButton type="submit" class="mt-5" block size="lg" color="neutral" label="Sign" :loading="saving" :disabled="!consent || name.trim().length < 2" data-testid="agreement-submit" />
    </form>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import AgreementSignFields from '~/components/booking/AgreementSignFields.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import type { BookingAgreement } from '~/shared/agreements'
import { isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'

/** Read the document, type a name, agree, sign: one signature fills every place marked for the signer. */
const props = defineProps<{ conversationId: string; agreement: BookingAgreement }>()
const emit = defineEmits<{ signed: [] }>()
const open = defineModel<boolean>('open', { required: true })
const name = ref('')
const consent = ref(false)
const saving = ref(false)
const error = ref('')

async function sign() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    await applicationFetch(`/api/messages/${encodeURIComponent(props.conversationId)}/agreement/sign`, {
      method: 'POST', body: { typed_name: name.value.trim(), consent: consent.value }, validate: isRecord,
    })
    open.value = false
    emit('signed')
  } catch (failure) {
    error.value = getErrorMessage(failure, 'Your signature could not be saved')
  } finally {
    saving.value = false
  }
}
</script>
