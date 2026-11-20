import type { FormQuestion } from '~/shared/form-questions'
import { isRecord } from '~/utils/api-clients'
import { loadPublicResourcePayload } from '~/composables/loadPublicResourcePayload'

export interface PublicInquiryForm {
  success: true
  questions: FormQuestion[]
  questions_revision: string
  /** A legal practice's contact notice must be acknowledged before a message is sent. */
  consent_required: boolean
}

const isInquiryForm = (value: unknown): value is PublicInquiryForm => isRecord(value) && value.success === true
  && Array.isArray(value.questions) && typeof value.questions_revision === 'string' && typeof value.consent_required === 'boolean'

/**
 * The site's inquiry form, rendered with the page: the organization's own
 * questions in the visitor's language and the revision a submission names. The
 * server render reads it through the same domain reader as the public endpoint.
 */
export async function useInquiryForm() {
  const { organization } = useTenantOrganization()
  const organizationId = organization.id
  if (!organizationId) throw createError({ statusCode: 500, statusMessage: 'Inquiry form rendered without an organization' })
  const { locale } = useI18n()
  const requestEvent = useRequestEvent()
  const key = computed(() => `inquiry-form-${organizationId}-${locale.value}`)
  const { data, error, refresh } = await useAsyncData(key, (_nuxtApp, { signal }) =>
    loadPublicResourcePayload({
      organizationId, resourceKind: 'inquiry', url: `/api/public/inquiry-form?locale=${encodeURIComponent(locale.value)}`,
      key: key.value, query: { locale: locale.value }, validate: isInquiryForm, failureMessage: 'Inquiry form failed', signal, requestEvent,
    }), { dedupe: 'defer' })
  if (error.value) throw error.value
  return { form: data, refresh }
}
