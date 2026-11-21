<template>
  <DashboardIndexPanel id="product-agreement" :title="label" column="leaf">
    <template v-if="level.child.value" #leading>
      <DashboardNavbarLeading :to="router.resolve({ path: level.path.value, query: route.query }).fullPath" :disabled="busy" />
    </template>
    <UAlert v-if="p.loadError.value || error" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.loadError.value || error || ''" />
    <template v-if="product && loaded">
      <p class="text-sm text-muted">What {{ guests }} sign for this {{ product.kind === 'service' ? 'consultation' : 'listing' }}.</p>
      <URadioGroup v-model="mode" variant="card" class="mt-6" :items="modes" :disabled="busy" data-testid="agreement-mode" />

      <!-- A PDF every guest signs on their booking, as today. -->
      <template v-if="mode === 'pdf'">
        <div v-if="product.agreement" class="mt-6 overflow-hidden rounded-2xl border border-default" data-testid="listing-agreement">
          <iframe :src="product.agreement.public_url" :title="product.agreement.file_name ?? label" class="h-80 w-full bg-elevated" />
          <div class="px-4 py-3.5"><p class="truncate text-sm font-medium text-highlighted">{{ product.agreement.file_name ?? label }}</p></div>
        </div>
        <UButton class="mt-5 w-full justify-center" :label="product.agreement ? 'Replace PDF' : 'Upload a PDF'" color="neutral" variant="outline" size="lg" :loading="busy" :disabled="busy" @click="picker?.click()" />
        <p class="mt-4 text-xs text-muted">Bookings already made keep the version they signed.</p>
      </template>

      <!-- The business's own text, filled from each booking when it is sent. -->
      <template v-else-if="mode === 'template'">
        <div class="mt-6 flex flex-wrap gap-2" data-testid="template-fields">
          <UButton v-for="field in AGREEMENT_TEMPLATE_FIELDS" :key="field" size="xs" color="neutral" variant="outline" :disabled="busy" :label="agreementTemplateFieldLabel(product.kind, field)" @click="insert(field)" />
        </div>
        <UTextarea ref="editor" v-model="draft" class="mt-3 w-full" :disabled="busy" :rows="18" :maxlength="MAX_AGREEMENT_TEMPLATE_LENGTH" placeholder="# Engagement letter&#10;&#10;This letter confirms that {{business_name}} will represent {{client_name}}…" data-testid="template-text" />
        <p class="mt-2 text-xs text-muted">{{ draft.length.toLocaleString() }} / {{ MAX_AGREEMENT_TEMPLATE_LENGTH.toLocaleString() }}. Start a line with # for a heading. Signature lines are added for each signer when you send it.</p>
        <UButton class="mt-5 w-full justify-center" label="Save" color="neutral" size="lg" :loading="busy" :disabled="busy || !draft.trim() || draft === saved" data-testid="template-save" @click="saveTemplate" />
      </template>

      <UButton v-else-if="product.agreement || saved !== null" class="mt-6 w-full justify-center" label="Remove the agreement" color="neutral" variant="outline" size="lg" :loading="busy" :disabled="busy" @click="removeAll" />
      <input ref="picker" type="file" accept="application/pdf" class="hidden" @change="picked">
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { agreementLabel } from '~/shared/agreements'
import { AGREEMENT_TEMPLATE_FIELDS, MAX_AGREEMENT_TEMPLATE_LENGTH, agreementTemplateFieldLabel, type AgreementTemplateField } from '~/shared/agreement-templates'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const dashboardApi = useDashboardApi()
const product = computed(() => p.product.value)
const label = computed(() => product.value ? agreementLabel(product.value.kind) : 'Agreement')
const guests = computed(() => product.value?.kind === 'service' ? 'clients' : 'guests')
const api = `/api/editor/organizations/${encodeURIComponent(p.organizationId)}`
const templateApi = computed(() => `${api}/products/${encodeURIComponent(product.value!.id)}/agreement-template`)
const { upload } = useMediaUpload(api)
const picker = ref<HTMLInputElement | null>(null)
const editor = ref<{ textareaRef?: HTMLTextAreaElement } | null>(null)
const busy = ref(false)
const error = ref('')
const loaded = ref(false)
/** The template as saved and read back; null when the listing has none. */
const saved = ref<string | null>(null)
const draft = ref('')
const mode = ref<'pdf' | 'template' | 'none'>('none')

const modes = computed(() => [
  { value: 'pdf', label: 'Upload a PDF', description: 'The same document for every booking.' },
  { value: 'template', label: 'Write your template', description: `Your own wording, filled in from each booking${product.value?.kind === 'service' ? ': names, dates, fees.' : '.'}` },
  { value: 'none', label: 'None', description: 'Send a document from a booking when you need one.' },
])

const isTemplateAnswer = (value: unknown): value is { text: string | null } => isRecord(value) && (value.text === null || typeof value.text === 'string')

async function load() {
  error.value = ''
  try {
    const answer = await dashboardApi(templateApi.value, { validate: isTemplateAnswer })
    saved.value = answer.text
    draft.value = answer.text ?? ''
    mode.value = answer.text !== null ? 'template' : product.value?.agreement ? 'pdf' : 'none'
    loaded.value = true
  } catch (failure) {
    error.value = getErrorMessage(failure, 'The agreement could not be read')
  }
}
watch(() => product.value?.id, id => { if (id) void load() }, { immediate: true })

function insert(field: AgreementTemplateField) {
  const token = `{{${field}}}`
  const area = editor.value?.textareaRef
  const at = area ? area.selectionStart : draft.value.length
  draft.value = `${draft.value.slice(0, at)}${token}${draft.value.slice(area ? area.selectionEnd : at)}`
  void nextTick(() => {
    area?.focus()
    area?.setSelectionRange(at + token.length, at + token.length)
  })
}

async function run(work: () => Promise<void>, message: string) {
  busy.value = true
  error.value = ''
  try {
    await work()
    await p.reload()
    await load()
  } catch (failure) {
    error.value = getErrorMessage(failure, message)
  } finally {
    busy.value = false
  }
}

const placePdf = (assetId: string | null) => dashboardApi(`${api}/media/placements`, {
  method: 'PUT', validate: isRecord,
  body: { placement: { owner_type: 'product', owner_id: product.value!.id, slot: 'agreement' }, asset_id: assetId },
})
const putTemplate = (text: string | null) => dashboardApi(templateApi.value, { method: 'PUT', body: { text }, validate: isTemplateAnswer })

// The listing has one agreement: the server removes an uploaded PDF in the same write.
function saveTemplate() {
  void run(async () => { await putTemplate(draft.value) }, 'The template could not be saved')
}

function picked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  void run(async () => {
    const uploaded = await upload(file)
    if (!uploaded) throw new Error('Choose a PDF up to 20 MB')
    await placePdf(uploaded.asset_id)
    if (saved.value !== null) await putTemplate(null)
  }, 'The PDF could not be uploaded')
}

function removeAll() {
  void run(async () => {
    if (product.value?.agreement) await placePdf(null)
    if (saved.value !== null) await putTemplate(null)
  }, 'The agreement could not be removed')
}
</script>
