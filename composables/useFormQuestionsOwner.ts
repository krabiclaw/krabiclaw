import type { ComputedRef } from 'vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'
import type { FormQuestion } from '~/shared/form-questions'
import type { FormQuestionWrite } from '~/utils/form-question-editing'

/**
 * The three records that hold a form's questions. The Questions screens are one
 * set of files mounted beneath each of them (`build/form-question-routes.ts`),
 * and the route's `formQuestions` meta names which one a mount edits.
 */
export type FormQuestionsOwnerKind = 'inquiry' | 'booking' | 'stay'

export interface FormQuestionsOwner {
  /** Which form this is among every form the organization has, as the copy sheet names its sources: `inquiry`, `booking:<product>`, `stay:<product>`. */
  key: string
  title: string
  lead: string
  /** What the Required switch means for this form. */
  requiredDescription: string
  questions: ComputedRef<FormQuestion[] | null>
  error: ComputedRef<string | null>
  /** Where the questions' translated wording is stored: the owner's resource and its field. */
  localization: ComputedRef<{ organizationId: string; resourceType: 'organization' | 'product'; resourceId: string; field: string; label: string } | null>
  /** Replaces the whole list over the revision this owner last read, then re-reads the owner. Throws what the writer refused. */
  write: (questions: readonly FormQuestionWrite[]) => Promise<void>
}

export async function useFormQuestionsOwner(): Promise<FormQuestionsOwner> {
  const route = useRoute()
  const kind = route.meta.formQuestions as FormQuestionsOwnerKind | undefined
  if (kind === 'inquiry') {
    const editor = inject(organizationSettingsEditorKey)
    if (!editor) throw new Error('The inquiry form questions are mounted outside the Website settings')
    return {
      key: 'inquiry',
      title: 'Inquiry form',
      lead: 'Asked after name, email and phone when someone sends a message from your website. Messages already sent keep the answers they gave.',
      requiredDescription: 'Visitors can’t send a message without answering',
      questions: editor.inquiryQuestions,
      error: editor.editorError,
      localization: computed(() => ({ organizationId: editor.organizationId, resourceType: 'organization', resourceId: editor.organizationId, field: 'inquiry_questions', label: 'Inquiry form' })),
      write: editor.saveInquiryQuestions,
    }
  }
  if (kind === 'booking' || kind === 'stay') {
    const editor = inject(productEditorKey)
    if (!editor) throw new Error('Product questions are mounted outside the product editor')
    const legal = computed(() => editor.product.value?.kind === 'service')
    const name = computed(() => editor.product.value?.name ?? '')
    return {
      get key() { return `${kind}:${editor.product.value?.id ?? ''}` },
      title: 'Questions',
      get lead() {
        if (kind === 'stay') return 'Asked after name, email and phone when a guest books this home. Stays already booked keep the answers they gave.'
        return legal.value
          ? `Asked after name, email and phone when a client requests ${name.value}. Consultations already requested keep the answers they gave.`
          : `Asked after name, email and phone when someone books ${name.value}. Bookings already made keep the answers they gave.`
      },
      get requiredDescription() { return legal.value ? 'Clients can’t request a consultation without answering' : 'Guests can’t book without answering' },
      questions: computed(() => (kind === 'booking' ? editor.product.value?.booking : editor.product.value?.stay)?.questions ?? null),
      error: editor.loadError,
      localization: computed(() => editor.product.value ? { organizationId: editor.organizationId, resourceType: 'product', resourceId: editor.product.value.id, field: 'questions', label: editor.product.value.name } : null),
      write: questions => editor.saveQuestions(kind, questions),
    }
  }
  throw new Error(`Questions are mounted at ${route.path} without the record that owns them`)
}
