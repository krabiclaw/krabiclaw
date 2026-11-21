<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[100] flex flex-col bg-slate-100 dark:bg-slate-950 text-default antialiased"
      data-testid="agreement-review-sign-workspace"
    >
      <!-- Top Navigation Header -->
      <header class="flex h-14 shrink-0 items-center justify-between border-b border-default bg-surface px-4 shadow-xs">
        <div class="flex items-center gap-3 min-w-0">
          <div class="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
            <UIcon name="i-lucide-file-text" class="size-4" />
          </div>
          <div class="min-w-0">
            <h2 class="truncate text-sm font-semibold text-highlighted leading-none">Review and sign {{ agreement.label }}</h2>
            <p class="truncate text-xs text-muted mt-0.5">{{ agreement.file_name }}</p>
          </div>
        </div>

        <!-- Center / Action Status Pill -->
        <div class="flex items-center gap-3">
          <div class="hidden sm:flex items-center gap-2 rounded-full border border-default bg-elevated/40 px-3 py-1 text-xs">
            <UIcon :name="isAdopted ? 'i-lucide-circle-check' : 'i-lucide-pen-tool'" :class="isAdopted ? 'text-success' : 'text-primary'" class="size-3.5" />
            <span class="font-medium text-highlighted">
              {{ isAdopted ? 'Signature adopted' : '1 signature required' }}
            </span>
          </div>

          <button
            v-if="!isAdopted"
            type="button"
            data-testid="next-signature-button"
            class="flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/20 transition-colors cursor-pointer"
            @click="scrollToSignature"
          >
            <UIcon name="i-lucide-arrow-down" class="size-3" />
            <span>Next signature</span>
          </button>

          <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" aria-label="Close" @click="open = false" />
        </div>
      </header>

      <!-- Main Body: Scrollable Document Pages -->
      <div ref="scrollContainer" class="flex-1 overflow-y-auto bg-slate-200/70 dark:bg-slate-900 p-4 sm:p-8 pb-32 flex flex-col items-center gap-6">
        <!-- Rendered Pages Container -->
        <div
          v-for="pageNum in totalPages"
          :key="pageNum"
          :ref="(el) => { if (el) pageElements[pageNum] = el as HTMLElement }"
          class="relative bg-white shadow-xl rounded-sm transition-all max-w-[800px] w-full"
          data-testid="agreement-document"
        >
          <!-- Canvas for Page -->
          <canvas :ref="(el) => { if (el) pageCanvases[pageNum] = el as HTMLCanvasElement }" class="block w-full h-auto pointer-events-none" />

          <!-- Placed Fields on this Page -->
          <template v-for="field in pageFields(pageNum)" :key="`${field.signer_key}:${field.kind}:${field.x}:${field.y}`">
            <!-- Counterparty / Viewer's Signature Field -->
            <button
              v-if="isViewerField(field)"
              type="button"
              data-testid="field-stamp-box"
              class="absolute z-20 select-none cursor-pointer rounded border-2 transition-all flex items-center justify-center p-1"
              :class="isAdopted
                ? 'border-emerald-500 bg-emerald-500/10 ring-2 ring-emerald-500/30'
                : 'border-cyan-500 bg-cyan-500/15 ring-4 ring-cyan-500/30 animate-pulse'"
              :style="{
                left: `${field.x * 100}%`,
                top: `${field.y * 100}%`,
                width: `${field.width * 100}%`,
                height: `${field.height * 100}%`,
              }"
              @click.stop="openAdoptionModal"
            >
              <!-- Stamped Signature Preview if Adopted -->
              <p
                v-if="isAdopted && field.kind === 'signature'"
                class="truncate text-xl sm:text-2xl text-highlighted"
                style="font-family: 'Snell Roundhand', 'Segoe Script', 'Brush Script MT', cursive"
              >
                {{ name.trim() }}
              </p>
              <span v-else-if="isAdopted && field.kind === 'date'" class="text-xs font-semibold text-highlighted">
                {{ todayDate }}
              </span>
              <!-- Unadopted Click-to-Sign Prompt -->
              <div v-else class="flex items-center gap-1.5 text-xs font-bold text-cyan-900 dark:text-cyan-100">
                <UIcon name="i-lucide-pen-tool" class="size-3.5" />
                <span>{{ field.kind === 'signature' ? 'Sign here' : 'Date' }}</span>
              </div>
            </button>

            <!-- Other Signer's Field -->
            <div
              v-else
              class="absolute select-none rounded border border-slate-400 bg-slate-400/10 flex items-center justify-center p-1"
              :style="{
                left: `${field.x * 100}%`,
                top: `${field.y * 100}%`,
                width: `${field.width * 100}%`,
                height: `${field.height * 100}%`,
              }"
            >
              <span class="truncate text-[10px] text-muted">{{ otherSignerName(field.signer_key) }}</span>
            </div>
          </template>
        </div>

        <!-- Fallback if PDF still loading -->
        <div v-if="loadingPdf" class="flex flex-col items-center justify-center py-24 text-muted gap-3">
          <UIcon name="i-lucide-loader-circle" class="size-8 animate-spin text-primary" />
          <p class="text-sm font-medium">Loading document pages for review…</p>
        </div>
      </div>

      <!-- Sticky Bottom Action Bar -->
      <footer class="flex h-16 shrink-0 items-center justify-between border-t border-default bg-surface px-4 sm:px-6 shadow-xs">
        <div class="min-w-0 pr-4">
          <p class="truncate text-xs text-muted">
            {{ isAdopted ? 'Signature placed. Click Finish signing to execute this document.' : 'Review each page and click [Sign here] to adopt your signature.' }}
          </p>
        </div>

        <div class="flex items-center gap-3 shrink-0">
          <UButton color="neutral" variant="ghost" size="md" label="Cancel" @click="open = false" />
          <UButton
            color="primary"
            size="md"
            label="Finish signing"
            icon="i-lucide-check-circle"
            :loading="saving"
            :disabled="!isAdopted"
            data-testid="agreement-submit"
            @click="submitSigned"
          />
        </div>
      </footer>

      <!-- Signature Adoption Modal -->
      <div
        v-if="adoptionModalOpen"
        class="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
        data-testid="signature-adoption-dialog"
      >
        <div class="w-full max-w-lg rounded-2xl border border-default bg-surface p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
          <div class="flex items-center justify-between pb-4 border-b border-default">
            <h3 class="text-base font-semibold text-highlighted">Adopt your electronic signature</h3>
            <button type="button" class="text-muted hover:text-highlighted" @click="adoptionModalOpen = false">
              <UIcon name="i-lucide-x" class="size-5" />
            </button>
          </div>
          <form class="mt-5 space-y-5" @submit.prevent="confirmAdoption">
            <div>
              <label for="sign-name" class="mb-1.5 block text-sm font-medium text-highlighted">Full legal name</label>
              <input
                id="sign-name"
                v-model="name"
                type="text"
                autocomplete="name"
                required
                minlength="2"
                maxlength="120"
                :disabled="saving"
                placeholder="Type your full name"
                data-testid="agreement-name"
                class="w-full rounded-xl border border-default bg-surface px-3.5 py-2.5 text-sm text-highlighted placeholder:text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
            </div>

            <div>
              <p class="text-xs font-semibold text-muted">Your adopted electronic signature</p>
              <div class="mt-1.5 flex min-h-16 items-center rounded-xl border border-dashed border-default bg-elevated/20 px-4">
                <p
                  class="text-3xl leading-none text-highlighted"
                  style="font-family: 'Snell Roundhand', 'Segoe Script', 'Brush Script MT', cursive"
                  aria-hidden="true"
                >
                  {{ name.trim() || 'Your Name' }}
                </p>
              </div>
            </div>

            <label class="flex items-start gap-3 rounded-xl border border-default bg-surface p-3.5 text-sm cursor-pointer hover:bg-elevated/40 transition-colors">
              <input
                v-model="consent"
                type="checkbox"
                required
                :disabled="saving"
                class="mt-0.5 size-4.5 rounded accent-primary cursor-pointer shrink-0"
                data-testid="agreement-consent"
              >
              <span class="leading-snug text-default select-none">
                I agree that typing my name above constitutes a legally binding electronic signature on this {{ agreement.label.toLowerCase() }}, with the same legal effect as a handwritten signature.
              </span>
            </label>

            <UAlert v-if="error" color="error" variant="soft" icon="i-lucide-circle-alert" :description="error" />

            <div class="pt-1">
              <UButton
                type="submit"
                block
                size="lg"
                color="primary"
                :disabled="!consent || name.trim().length < 2"
                class="font-semibold"
              >
                Adopt and apply to document
              </UButton>
            </div>
          </form>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import type { AgreementField, BookingAgreement } from '~/shared/agreements'
import { isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ conversationId: string; agreement: BookingAgreement }>()
const emit = defineEmits<{ signed: [] }>()
const open = defineModel<boolean>('open', { required: true })

const name = ref('')
const consent = ref(false)
const saving = ref(false)
const error = ref('')
const loadingPdf = ref(false)
const totalPages = ref(1)
const adoptionModalOpen = ref(false)
const isAdopted = ref(false)

const scrollContainer = ref<HTMLElement | null>(null)
const pageElements = reactive<Record<number, HTMLElement>>({})
const pageCanvases = reactive<Record<number, HTMLCanvasElement>>({})
let pdfDoc: import('pdfjs-dist').PDFDocumentProxy | null = null

const todayDate = computed(() => {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date())
})

function isViewerField(field: AgreementField): boolean {
  if (field.signer_key === props.agreement.viewer_signer_key) return true
  // If viewer is host and field belongs to host role
  const signer = props.agreement.signers.find(s => s.key === field.signer_key)
  return signer?.key === props.agreement.viewer_signer_key
}

function pageFields(pageNum: number): AgreementField[] {
  return props.agreement.fields.filter(f => f.page === pageNum)
}

function otherSignerName(key: string): string {
  const signer = props.agreement.signers.find(s => s.key === key)
  return signer?.name ?? 'Signer'
}

function openAdoptionModal() {
  adoptionModalOpen.value = true
}

function confirmAdoption() {
  if (consent.value && name.value.trim().length >= 2) {
    isAdopted.value = true
    adoptionModalOpen.value = false
  }
}

function scrollToSignature() {
  // Find page with viewer's field
  const viewerField = props.agreement.fields.find(isViewerField)
  if (viewerField && pageElements[viewerField.page]) {
    pageElements[viewerField.page]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    openAdoptionModal()
  } else {
    openAdoptionModal()
  }
}

async function loadAndRenderPdf() {
  if (!import.meta.client || !props.agreement.url) return
  loadingPdf.value = true
  try {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href

    // Fetch the PDF bytes
    const response = await fetch(props.agreement.url)
    const data = new Uint8Array(await response.arrayBuffer())
    pdfDoc = await pdfjs.getDocument({ data }).promise
    totalPages.value = pdfDoc.numPages

    await nextTick()

    // Render each page
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i)
      const canvas = pageCanvases[i]
      if (canvas) {
        const viewport = page.getViewport({ scale: 1.5 })
        canvas.width = viewport.width
        canvas.height = viewport.height
        const canvasContext = canvas.getContext('2d')!
        await page.render({ canvas, canvasContext, viewport }).promise
      }
    }
  } catch {
    // If inline render fails, user can still review and sign via adoption modal
  } finally {
    loadingPdf.value = false
  }
}

watch(open, (isOpen) => {
  if (isOpen) {
    // Initialize default name from viewer signer if available
    const viewerSigner = props.agreement.signers.find(s => s.key === props.agreement.viewer_signer_key)
    if (viewerSigner && !name.value) {
      name.value = viewerSigner.name === 'You' ? '' : viewerSigner.name
    }
    void loadAndRenderPdf()
  }
}, { immediate: true })

async function submitSigned() {
  if (saving.value || !consent.value || name.value.trim().length < 2) {
    if (!isAdopted.value) openAdoptionModal()
    return
  }
  saving.value = true
  error.value = ''
  try {
    await applicationFetch(`/api/messages/${encodeURIComponent(props.conversationId)}/agreement/sign`, {
      method: 'POST',
      body: { typed_name: name.value.trim(), consent: consent.value },
      validate: isRecord,
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
