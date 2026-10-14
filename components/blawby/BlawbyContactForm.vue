<template>
  <section class="bg-elevated px-6 pb-24 sm:pb-32" aria-labelledby="blawby-contact-form-heading">
    <form class="mx-auto grid max-w-3xl gap-5 rounded-2xl bg-[var(--blawby-primary-100)] p-8 sm:p-10" @submit.prevent="submitContact">
      <h2 id="blawby-contact-form-heading" class="blawby-display text-3xl font-bold text-[var(--blawby-primary)]">Send a message</h2>
      <p v-if="submitMessage" role="alert" class="rounded-lg border border-[var(--blawby-border)] bg-elevated p-4 text-sm text-[var(--blawby-primary)]">{{ submitMessage }}</p>
      <label class="grid gap-2 text-sm font-semibold text-[var(--blawby-primary)]">Name<input v-model.trim="form.name" required maxlength="100" autocomplete="name" type="text" class="rounded-md border border-[var(--blawby-border)] bg-elevated px-4 py-3 font-normal"></label>
      <label class="grid gap-2 text-sm font-semibold text-[var(--blawby-primary)]">Email<input v-model.trim="form.email" required maxlength="200" autocomplete="email" type="email" class="rounded-md border border-[var(--blawby-border)] bg-elevated px-4 py-3 font-normal"></label>
      <label class="grid gap-2 text-sm font-semibold text-[var(--blawby-primary)]">Subject<select v-model="form.subject" class="rounded-md border border-[var(--blawby-border)] bg-elevated px-4 py-3 font-normal"><option value="general">General question</option><option value="partnerships">Partnerships</option><option value="press">Press</option></select></label>
      <label class="grid gap-2 text-sm font-semibold text-[var(--blawby-primary)]">Message<textarea v-model.trim="form.message" required minlength="10" maxlength="2000" rows="8" class="rounded-md border border-[var(--blawby-border)] bg-elevated px-4 py-3 font-normal" /></label>
      <label class="flex items-start gap-3 text-sm leading-6 text-muted">
        <input v-model="form.consent" required type="checkbox" class="mt-1 size-4 rounded border-accented text-[var(--blawby-primary)] focus:ring-[var(--blawby-primary)]">
        <span>I understand that submitting this form does not create an attorney-client relationship and agree to be contacted about this message.</span>
      </label>
      <BlawbyButton as="button" type="submit" :disabled="submitting" class="w-full">{{ submitting ? 'Sending...' : 'Send message' }}</BlawbyButton>
    </form>
  </section>
</template>

<script setup lang="ts">
import type { SubmissionMeasurement } from '~/composables/useOrganizationConversionTracking'
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import type { BlawbyDocumentPayload } from '~/utils/blawby-document-contract'

// The Blawby contact form. It is a block so the page says where it sits: it
// used to be markup between two fixed sections, so a firm could not put its
// questions above it or its practice areas below.
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

const { id: organizationId } = useTenantOrganization().organization
const { locale, localePath } = useI18n()
const document = inject<Ref<BlawbyDocumentPayload> | null>('blawby-document', null)
if (!document) throw createError({ statusCode: 500, statusMessage: 'Blawby layout did not provide the requested contact form context' })
const activeLocale = useState<string>('public-locale', () => 'en')
const requestedPath = resolveTenantLocalePath(props.page.path, [activeLocale.value]).sourcePath
const providedPage = document.value.route.page
if (!providedPage || providedPage.id !== props.page.id || providedPage.locale !== activeLocale.value
  || resolveTenantLocalePath(providedPage.path, [activeLocale.value]).sourcePath !== requestedPath
  || document.value.route.recipe !== resolveBlawbyRouteTarget(requestedPath).recipe) {
  throw createError({ statusCode: 500, statusMessage: 'Blawby layout did not provide the requested contact form context' })
}
const consultation = computed(() => document.value.shell.consultation)
const submitting = ref(false)
const submitMessage = ref('')
const form = reactive({ name: '', email: '', subject: 'general', message: '', consent: false })
const { mirrorSubmission, pageEventId } = useOrganizationConversionTracking(consultation)

async function submitContact() {
  if (!organizationId || submitting.value) return
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
