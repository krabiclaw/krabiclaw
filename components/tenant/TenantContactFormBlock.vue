<template>
  <section class="bg-elevated px-6 pb-24 sm:pb-32" aria-labelledby="tenant-contact-form-heading">
    <form class="mx-auto grid max-w-3xl gap-5 rounded-2xl border border-default bg-elevated p-8 sm:p-10 shadow-sm" @submit.prevent="submitContact">
      <h2 id="tenant-contact-form-heading" class="tenant-display text-3xl font-bold text-highlighted">Send a message</h2>
      <p v-if="submitMessage" role="alert" class="rounded-lg border border-default bg-muted p-4 text-sm text-highlighted">{{ submitMessage }}</p>
      <label class="grid gap-2 text-sm font-semibold text-highlighted">
        Name
        <input v-model.trim="form.name" required maxlength="100" autocomplete="name" type="text" class="rounded-md border border-default bg-default px-4 py-3 font-normal text-default focus:ring-2 focus:ring-primary focus:outline-none">
      </label>
      <label class="grid gap-2 text-sm font-semibold text-highlighted">
        Email
        <input v-model.trim="form.email" required maxlength="200" autocomplete="email" type="email" class="rounded-md border border-default bg-default px-4 py-3 font-normal text-default focus:ring-2 focus:ring-primary focus:outline-none">
      </label>
      <label class="grid gap-2 text-sm font-semibold text-highlighted">
        Subject
        <select v-model="form.subject" class="rounded-md border border-default bg-default px-4 py-3 font-normal text-default focus:ring-2 focus:ring-primary focus:outline-none">
          <option value="general">General question</option>
          <option value="partnerships">Partnerships</option>
          <option value="press">Press</option>
        </select>
      </label>
      <label class="grid gap-2 text-sm font-semibold text-highlighted">
        Message
        <textarea v-model.trim="form.message" required minlength="10" maxlength="2000" rows="8" class="rounded-md border border-default bg-default px-4 py-3 font-normal text-default focus:ring-2 focus:ring-primary focus:outline-none" />
      </label>
      <label class="flex items-start gap-3 text-sm leading-6 text-muted">
        <input v-model="form.consent" required type="checkbox" class="mt-1 size-4 rounded border-default text-primary focus:ring-primary">
        <span>I understand that submitting this form does not create an attorney-client relationship and agree to be contacted about this message.</span>
      </label>
      <TenantButton as="button" type="submit" :disabled="submitting" class="w-full">{{ submitting ? 'Sending...' : 'Send message' }}</TenantButton>
    </form>
  </section>
</template>

<script setup lang="ts">
import type { SubmissionMeasurement } from '~/composables/useOrganizationConversionTracking'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'

defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

const { id: organizationId } = useTenantOrganization().organization
const { locale, localePath } = useI18n()
const submitting = ref(false)
const submitMessage = ref('')
const form = reactive({ name: '', email: '', subject: 'general', message: '', consent: false })
const { mirrorSubmission, pageEventId } = useOrganizationConversionTracking()

async function submitContact() {
  if (submitting.value) return
  if (!organizationId) throw new Error('Contact form rendered without an organization')
  submitting.value = true
  submitMessage.value = ''
  try {
    const response = await publicApiMutation<{ success: true; measurement?: SubmissionMeasurement }>(`/api/public/contact`, {
      method: 'POST',
      body: { ...form, locale: locale.value, page_event_id: await pageEventId() },
      validate: (value): value is { success: true; measurement?: SubmissionMeasurement } => isRecord(value) && value.success === true,
    })
    mirrorSubmission('contact_submit', response.measurement)
    await navigateTo(localePath('/contact/confirmed'))
  } catch (error) {
    const fetchError = error as { data?: { error?: string; message?: string; statusMessage?: string } }
    submitMessage.value = fetchError.data?.error || fetchError.data?.message || fetchError.data?.statusMessage || 'Unable to send right now.'
  } finally {
    submitting.value = false
  }
}
</script>
