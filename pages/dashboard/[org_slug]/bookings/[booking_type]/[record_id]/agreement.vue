<template>
  <div>
    <DashboardLeafPanel
      id="booking-agreement-panel"
      :title="context?.label ?? 'Agreement'"
      :lead="context ? leadLine : undefined"
      :save-label="null"
      :footer="false"
      :error="context ? error : 'This booking has no agreement you can manage.'"
    >
      <template v-if="context">
        <!-- The document the booking has now: who signed, and what the business can still do with it. -->
        <template v-if="context.current">
          <BookingAgreement :conversation-id="context.conversationId" :preloaded="{ agreement: context.current, canManage: true }" @open-signing="openSigning" />
          <div class="mt-4 divide-y divide-default border-t border-default">
            <button v-if="context.current.status !== 'signed'" type="button" :class="rowClass" data-testid="booking-agreement-replace" @click="startOver">
              <UIcon name="i-lucide-send" class="size-5 shrink-0" /><span class="min-w-0 flex-1">{{ context.current.source === 'listing' ? 'Send a document for this booking' : 'Replace document' }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
            </button>
            <button type="button" :class="rowClass" :disabled="busy !== null" data-testid="booking-agreement-store" @click="storePicker?.click()">
              <UIcon name="i-lucide-upload" class="size-5 shrink-0" /><span class="min-w-0 flex-1">{{ busy === 'store' ? 'Uploading…' : 'Add a signed copy' }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
            </button>
            <button v-if="context.current.source === 'booking' && context.current.status !== 'signed'" type="button" :class="rowClass" :disabled="busy !== null" data-testid="booking-agreement-cancel" @click="cancelRequest">
              <UIcon name="i-lucide-circle-x" class="size-5 shrink-0" /><span class="min-w-0 flex-1">{{ busy === 'cancel' ? 'Cancelling…' : context.current.status === 'stored' ? 'Remove signed copy' : 'Cancel signing request' }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
            </button>
          </div>
        </template>

        <!-- Nothing sent yet: Zillow's checklist. Each card shows a saved fact and opens what changes it. -->
        <div v-else class="space-y-4">
          <button type="button" :class="cardClass" data-testid="card-document" @click="documentPicker?.click()">
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold text-highlighted">{{ context.label }}</span>
              <span class="mt-1 block truncate text-sm text-muted">{{ draft.file?.name ?? `Choose the PDF to sign` }}</span>
            </span>
            <span class="text-sm font-semibold text-highlighted underline underline-offset-4">{{ draft.file ? 'Replace' : 'Choose' }}</span>
          </button>

          <button type="button" :class="cardClass" data-testid="card-signers" @click="openSigners">
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold text-highlighted">Signers</span>
              <span class="mt-1 block text-sm text-muted">{{ chosenSigners.length ? chosenSigners.map(signer => signer.role === 'host' ? `${signer.name} (you, last)` : signer.name).join(', ') : 'Choose who signs' }}</span>
            </span>
            <span class="text-sm font-semibold text-highlighted underline underline-offset-4">Edit</span>
          </button>

          <div v-if="context.when.length" class="rounded-xl border border-default p-4" data-testid="card-term">
            <p class="text-sm font-semibold text-highlighted">Term</p>
            <dl class="mt-1 grid grid-cols-2 gap-3 text-sm">
              <div v-for="row in context.when" :key="row.label">
                <dt class="text-muted">{{ row.label }}</dt>
                <dd class="text-highlighted">{{ row.value }}<template v-if="row.detail"> · {{ row.detail }}</template></dd>
              </div>
            </dl>
          </div>

          <NuxtLink v-if="depositLine" :to="{ path: route.path.replace(/\/agreement$/, '/deposit'), query: route.query }" :class="cardClass" data-testid="card-deposit">
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold text-highlighted">{{ editor?.deposit.value?.current.label }}</span>
              <span class="mt-1 block text-sm text-muted">{{ depositLine }}</span>
            </span>
            <span class="text-sm font-semibold text-highlighted underline underline-offset-4">Edit</span>
          </NuxtLink>

          <UButton block size="lg" color="neutral" label="Next: mark where everyone signs" :disabled="!draftReady" :loading="opening" data-testid="booking-agreement-prepare" @click="openWorkspace" />
          <p v-if="!draftReady" class="text-center text-sm text-muted">{{ draft.file ? 'Choose at least one guest to sign.' : 'Choose the PDF to sign.' }}</p>

          <div class="divide-y divide-default border-t border-default">
            <button type="button" :class="rowClass" :disabled="busy !== null" data-testid="booking-agreement-store" @click="storePicker?.click()">
              <UIcon name="i-lucide-upload" class="size-5 shrink-0" /><span class="min-w-0 flex-1">{{ busy === 'store' ? 'Uploading…' : 'Add a copy that was already signed' }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
            </button>
          </div>
        </div>
      </template>
      <input ref="documentPicker" type="file" accept="application/pdf" class="hidden" data-testid="picker-send" @change="chooseDocument">
      <input ref="storePicker" type="file" accept="application/pdf" class="hidden" data-testid="picker-store" @change="storeSignedCopy">
    </DashboardLeafPanel>

    <DashboardListItemDialog v-if="context" v-model:open="signersOpen" title="Signers" save-label="Done" :save-disabled="!signersDraft.some(entry => entry.chosen && entry.role === 'guest')" :error="signersError" @save="saveSigners">
      <p class="text-sm text-muted">Each guest is emailed a link to sign. You sign last.</p>
      <ul class="mt-4 divide-y divide-default">
        <li v-for="entry in signersDraft" :key="entry.key" class="flex items-center gap-3 py-3">
          <UCheckbox v-model="entry.chosen" :label="entry.role === 'host' ? `${entry.name} (you)` : entry.name" :description="entry.key.startsWith('email:') ? entry.key.slice(6) : undefined" />
        </li>
      </ul>
      <form class="mt-4 space-y-3 border-t border-default pt-4" @submit.prevent="addEmailSigner">
        <p class="text-sm font-semibold text-highlighted">Someone without a Blawby account</p>
        <UInput v-model="invite.name" placeholder="Full name" autocomplete="off" data-testid="invite-name" />
        <UInput v-model="invite.email" type="email" placeholder="Email" autocomplete="off" data-testid="invite-email" />
        <UButton type="submit" color="neutral" variant="outline" label="Add" :disabled="!invite.name.trim() || !EMAIL.test(invite.email.trim())" />
      </form>
    </DashboardListItemDialog>

    <!-- Mark where everyone signs: Zillow's full-screen field workspace. -->
    <Teleport to="body">
      <div v-if="workspace" class="fixed inset-0 z-50 flex flex-col bg-muted text-default" data-testid="fullscreen-field-workspace">
        <header class="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-default bg-default px-4 sm:px-6">
          <h1 class="truncate text-base font-semibold text-highlighted">{{ context?.label }} for {{ context?.title }}</h1>
          <UButton icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Close" @click="closeWorkspace" />
        </header>

        <div class="flex min-h-0 flex-1">
          <nav class="hidden w-12 shrink-0 flex-col items-center gap-2 border-r border-default bg-default py-3 md:flex">
            <UButton icon="i-lucide-pen-tool" :color="rail === 'fields' ? 'primary' : 'neutral'" variant="ghost" aria-label="Fields" data-testid="rail-tab-fields" @click="rail = 'fields'" />
            <UButton icon="i-lucide-files" :color="rail === 'pages' ? 'primary' : 'neutral'" variant="ghost" aria-label="Pages" data-testid="rail-tab-pages" @click="rail = 'pages'" />
          </nav>

          <aside class="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-default bg-default p-3 md:flex">
            <template v-if="rail === 'fields'">
              <div v-for="signer in chosenSigners" :key="signer.key" class="mb-4">
                <p class="px-1 text-sm font-semibold text-highlighted">{{ signer.role === 'host' ? 'Your fields' : `${signer.name}'s fields` }}</p>
                <div class="mt-2 space-y-1.5">
                  <UButton v-for="kind in FIELD_KINDS" :key="kind" block color="neutral" variant="outline" :icon="kind === 'signature' ? 'i-lucide-pen-tool' : 'i-lucide-calendar'" :label="kind === 'signature' ? 'Signature' : 'Date'" class="justify-start" :data-testid="`place-${kind}`" @click="place(signer.key, kind)" />
                </div>
              </div>
            </template>
            <template v-else>
              <p class="px-1 text-sm font-semibold text-highlighted">Pages</p>
              <button v-for="pageNumber in pages" :key="pageNumber" type="button" class="mt-3 flex w-full items-start gap-3 rounded-lg p-1.5 text-left" :class="page === pageNumber ? 'ring-2 ring-primary' : 'hover:bg-elevated'" @click="page = pageNumber">
                <span class="w-5 shrink-0 pt-1 text-xs text-muted">{{ pageNumber }}</span>
                <canvas :ref="element => { if (element) thumbnails[pageNumber] = element as HTMLCanvasElement }" class="w-full rounded border border-default" />
              </button>
            </template>
          </aside>

          <main class="relative flex min-w-0 flex-1 flex-col">
            <div class="flex shrink-0 items-center justify-between gap-3 border-b border-default bg-default px-4 py-2 text-sm text-muted sm:px-6">
              <span>Add each signer's signature and date, then drag them onto the lines.</span>
              <span class="shrink-0">Page {{ page }} of {{ pages }}</span>
            </div>
            <!-- Below md the palette is a strip above the page. -->
            <div class="flex shrink-0 gap-2 overflow-x-auto border-b border-default bg-default px-4 py-2 md:hidden">
              <template v-for="signer in chosenSigners" :key="signer.key">
                <UButton v-for="kind in FIELD_KINDS" :key="kind" size="sm" color="neutral" variant="outline" :label="`${firstName(signer)} · ${kind === 'signature' ? 'Signature' : 'Date'}`" @click="place(signer.key, kind)" />
              </template>
            </div>

            <div class="flex flex-1 justify-center overflow-auto p-4 sm:p-8">
              <div ref="pageBox" class="relative h-fit origin-top shadow-xl" :style="{ transform: `scale(${zoom})` }">
                <canvas ref="canvas" class="pointer-events-none block max-w-full" />
                <div
                  v-for="field in pageFields"
                  :key="fieldKeys.get(field)"
                  class="group absolute flex cursor-move select-none items-center justify-between rounded border-2 border-dashed border-primary bg-primary/10 px-2 text-black"
                  :style="{ left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.width * 100}%`, height: `${field.height * 100}%` }"
                  data-testid="placed-field"
                  @pointerdown.stop="drag($event, field)"
                >
                  <span class="truncate text-xs font-semibold">{{ fieldLabel(field) }}</span>
                  <button type="button" class="ml-1 shrink-0 rounded p-0.5" :aria-label="`Remove ${fieldLabel(field)}`" @click.stop="remove(field)">
                    <UIcon name="i-lucide-x" class="size-3" />
                  </button>
                </div>
              </div>
            </div>

            <div class="absolute right-4 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-2 sm:right-6">
              <UButton icon="i-lucide-chevron-up" color="neutral" variant="outline" class="rounded-full" aria-label="Previous page" :disabled="page <= 1" @click="page--" />
              <UButton icon="i-lucide-chevron-down" color="neutral" variant="outline" class="rounded-full" aria-label="Next page" :disabled="page >= pages" @click="page++" />
              <UButton icon="i-lucide-plus" color="neutral" variant="outline" class="rounded-full" aria-label="Zoom in" :disabled="zoom >= 1.6" @click="zoom = Math.round((zoom + 0.1) * 10) / 10" />
              <UButton icon="i-lucide-minus" color="neutral" variant="outline" class="rounded-full" aria-label="Zoom out" :disabled="zoom <= 0.6" @click="zoom = Math.round((zoom - 0.1) * 10) / 10" />
            </div>

            <footer class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-default bg-default px-4 py-3 sm:px-6">
              <p class="min-w-0 text-sm" :class="sendError ? 'text-error' : 'text-muted'" role="status">{{ sendError || readiness }}</p>
              <div class="flex items-center gap-3">
                <UButton color="neutral" variant="ghost" label="Back" @click="closeWorkspace" />
                <UButton color="neutral" label="Request signatures" :loading="sending" :disabled="unplaced !== null" data-testid="request-signatures-button" @click="send" />
              </div>
            </footer>
          </main>
        </div>
      </div>
    </Teleport>

    <AgreementSignSheet v-if="signing && context" v-model:open="signingOpen" :conversation-id="context.conversationId" :agreement="signing" @signed="refresh" />
  </div>
</template>

<script setup lang="ts">
import type { PDFDocumentProxy } from 'pdfjs-dist'
import BookingAgreement from '~/components/booking/BookingAgreement.vue'
import AgreementSignSheet from '~/components/booking/AgreementSignSheet.vue'
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'
import type { AgreementField, BookingAgreement as BookingAgreementRecord } from '~/shared/agreements'
import { isCurrencyCode } from '~/shared/currencies'
import { depositStatusLine } from '~/shared/deposits'
import { formatMinorAmount } from '~/shared/prices'
import { isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

type Signer = { key: string; name: string; role: 'guest' | 'host' }
const FIELD_KINDS = ['signature', 'date'] as const
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SIZE = { signature: { width: 0.36, height: 0.05 }, date: { width: 0.18, height: 0.05 } }
const rowClass = 'flex w-full items-center gap-3 py-4 text-left text-sm text-highlighted disabled:opacity-50'
const cardClass = 'flex w-full items-center gap-4 rounded-xl border border-default p-4 text-left hover:bg-elevated'

const editor = inject(bookingEditorKey, null)
const route = useRoute()
const context = computed(() => editor?.agreement.value ?? null)
/** The deposit the lease states, set on its own leaf; absent for a booking with no price. */
const depositLine = computed(() => {
  const deposit = editor?.deposit.value?.current
  if (!deposit) return null
  const currency = deposit.currency
  if (!isCurrencyCode(currency)) throw new Error(`Unsupported deposit currency ${currency}`)
  return depositStatusLine(deposit, minor => formatMinorAmount(minor, currency))
})
const leadLine = computed(() => context.value?.current ? 'The document for this booking and who has signed it.' : 'Send a PDF for this booking’s guests to sign. You sign last.')

const error = ref('')
const busy = ref<'store' | 'cancel' | null>(null)
const documentPicker = ref<HTMLInputElement | null>(null)
const storePicker = ref<HTMLInputElement | null>(null)

/** The document being prepared: the PDF, who signs it and where. Nothing is saved until it is sent. */
const draft = reactive<{ file: File | null; signers: Signer[]; fields: AgreementField[] }>({ file: null, signers: [], fields: [] })
// Every guest on the booking signs unless the business takes them off; the business itself signs last.
watch(() => context.value?.signers, available => {
  if (available && !draft.signers.length) draft.signers = available.map(signer => ({ ...signer }))
}, { immediate: true })
const chosenSigners = computed(() => [...draft.signers.filter(signer => signer.role === 'guest'), ...draft.signers.filter(signer => signer.role === 'host')])
const draftReady = computed(() => draft.file !== null && chosenSigners.value.some(signer => signer.role === 'guest'))

const signersOpen = ref(false)
const signersError = ref('')
const signersDraft = ref<(Signer & { chosen: boolean })[]>([])
const invite = reactive({ name: '', email: '' })
function openSigners() {
  const available = context.value?.signers ?? []
  const invited = draft.signers.filter(signer => !available.some(entry => entry.key === signer.key))
  signersDraft.value = [...available, ...invited].map(signer => ({ ...signer, chosen: draft.signers.some(entry => entry.key === signer.key) }))
  signersError.value = ''
  signersOpen.value = true
}
function addEmailSigner() {
  const email = invite.email.trim().toLowerCase()
  const key = `email:${email}`
  if (signersDraft.value.some(entry => entry.key === key)) {
    signersError.value = `${email} is already on the list`
    return
  }
  const host = signersDraft.value.findIndex(entry => entry.role === 'host')
  signersDraft.value.splice(host < 0 ? signersDraft.value.length : host, 0, { key, name: invite.name.trim(), role: 'guest', chosen: true })
  invite.name = ''
  invite.email = ''
  signersError.value = ''
}
function saveSigners() {
  draft.signers = signersDraft.value.filter(entry => entry.chosen).map(({ key, name, role }) => ({ key, name, role }))
  draft.fields = draft.fields.filter(field => draft.signers.some(signer => signer.key === field.signer_key))
  signersOpen.value = false
}

function chooseDocument(event: Event) {
  const input = event.target as HTMLInputElement
  const chosen = input.files?.[0] ?? null
  input.value = ''
  if (!chosen) return
  draft.file = chosen
  draft.fields = []
  pdf = null
}

function startOver() {
  draft.file = null
  draft.fields = []
  error.value = ''
  documentPicker.value?.click()
}

// The field workspace.
const workspace = ref(false)
const opening = ref(false)
const rail = ref<'fields' | 'pages'>('fields')
const page = ref(1)
const pages = ref(1)
const zoom = ref(1)
const canvas = ref<HTMLCanvasElement | null>(null)
const pageBox = ref<HTMLElement | null>(null)
const thumbnails = reactive<Record<number, HTMLCanvasElement>>({})
const sending = ref(false)
const sendError = ref('')
const fieldKeys = new WeakMap<AgreementField, string>()
let pdf: PDFDocumentProxy | null = null

async function openWorkspace() {
  if (!draft.file || opening.value) return
  opening.value = true
  error.value = ''
  try {
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
    pdf = await pdfjs.getDocument({ data: new Uint8Array(await draft.file.arrayBuffer()) }).promise
    pages.value = pdf.numPages
    // Signature lines are usually at the end.
    page.value = pdf.numPages
    sendError.value = ''
    workspace.value = true
    await nextTick()
    await renderPage()
  } catch (failure) {
    error.value = getErrorMessage(failure, 'This PDF could not be opened. Encrypted PDFs cannot be signed here.')
  } finally {
    opening.value = false
  }
}

function closeWorkspace() {
  workspace.value = false
}

async function renderPage() {
  if (!pdf || !canvas.value) return
  const current = await pdf.getPage(page.value)
  const viewport = current.getViewport({ scale: 1.5 })
  canvas.value.width = viewport.width
  canvas.value.height = viewport.height
  canvas.value.style.width = `${viewport.width / 1.5}px`
  await current.render({ canvas: canvas.value, canvasContext: canvas.value.getContext('2d')!, viewport }).promise
}

async function renderThumbnails() {
  if (!pdf) return
  for (let number = 1; number <= pdf.numPages; number++) {
    const target = thumbnails[number]
    if (!target) continue
    const current = await pdf.getPage(number)
    const viewport = current.getViewport({ scale: 0.25 })
    target.width = viewport.width
    target.height = viewport.height
    await current.render({ canvas: target, canvasContext: target.getContext('2d')!, viewport }).promise
  }
}

watch(page, () => {
  renderPage().catch(failure => { sendError.value = getErrorMessage(failure, `Page ${page.value} could not be shown`) })
})
watch(rail, async value => {
  if (value !== 'pages') return
  await nextTick()
  renderThumbnails().catch(failure => { sendError.value = getErrorMessage(failure, 'The pages could not be shown') })
})

const pageFields = computed(() => draft.fields.filter(field => field.page === page.value))

function firstName(signer: Signer) {
  return signer.role === 'host' ? 'You' : signer.name.split(' ')[0]!
}
function fieldLabel(field: AgreementField) {
  const signer = draft.signers.find(entry => entry.key === field.signer_key)
  return `${signer ? firstName(signer) : 'Removed signer'} · ${field.kind === 'signature' ? 'Signature' : 'Date'}`
}

let placed = 0
function place(signerKey: string, kind: AgreementField['kind']) {
  const size = SIZE[kind]
  // Each new field lands a little below the last so none hides another.
  const offset = (placed++ % 6) * 0.06
  const field: AgreementField = { signer_key: signerKey, kind, page: page.value, x: kind === 'signature' ? 0.08 : 0.56, y: Math.min(0.6 + offset, 1 - size.height), ...size }
  fieldKeys.set(field, `${signerKey}:${kind}:${placed}`)
  draft.fields.push(field)
}

function remove(field: AgreementField) {
  draft.fields = draft.fields.filter(entry => entry !== field)
}

function drag(event: PointerEvent, field: AgreementField) {
  if (!pageBox.value) return
  const box = pageBox.value.getBoundingClientRect()
  const start = { x: event.clientX, y: event.clientY, fieldX: field.x, fieldY: field.y }
  const clamp = (value: number, size: number) => Math.min(Math.max(value, 0), 1 - size)
  const move = (next: PointerEvent) => {
    field.x = clamp(start.fieldX + (next.clientX - start.x) / box.width, field.width)
    field.y = clamp(start.fieldY + (next.clientY - start.y) / box.height, field.height)
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
}

/** The first signer without a signature placed, whom the server would refuse the request for. */
const unplaced = computed(() => chosenSigners.value.find(signer => !draft.fields.some(field => field.signer_key === signer.key && field.kind === 'signature')) ?? null)
const readiness = computed(() => unplaced.value ? `Add a signature for ${unplaced.value.role === 'host' ? 'yourself' : unplaced.value.name}` : 'Everyone has a signature placed')

async function send() {
  if (!draft.file || !context.value || unplaced.value || sending.value) return
  sending.value = true
  sendError.value = ''
  try {
    const form = new FormData()
    form.append('file', draft.file)
    form.append('details', JSON.stringify({ signers: chosenSigners.value, fields: draft.fields }))
    await applicationFetch(`/api/messages/${encodeURIComponent(context.value.conversationId)}/agreement/send`, { method: 'POST', body: form, validate: isRecord })
    await editor!.refresh()
    workspace.value = false
    draft.file = null
    draft.fields = []
    pdf = null
  } catch (failure) {
    sendError.value = getErrorMessage(failure, 'The document could not be sent')
  } finally {
    sending.value = false
  }
}

async function storeSignedCopy(event: Event) {
  const input = event.target as HTMLInputElement
  const chosen = input.files?.[0]
  input.value = ''
  if (!chosen || !context.value || busy.value) return
  busy.value = 'store'
  error.value = ''
  try {
    const form = new FormData()
    form.append('file', chosen)
    await applicationFetch(`/api/messages/${encodeURIComponent(context.value.conversationId)}/agreement/store`, { method: 'POST', body: form, validate: isRecord })
    await editor!.refresh()
  } catch (failure) {
    error.value = getErrorMessage(failure, 'The signed copy could not be added')
  } finally {
    busy.value = null
  }
}

async function cancelRequest() {
  if (!context.value || busy.value) return
  busy.value = 'cancel'
  error.value = ''
  try {
    await applicationFetch(`/api/messages/${encodeURIComponent(context.value.conversationId)}/agreement/cancel`, { method: 'POST', body: {}, validate: isRecord })
    await editor!.refresh()
  } catch (failure) {
    error.value = getErrorMessage(failure, 'The request could not be cancelled')
  } finally {
    busy.value = null
  }
}

const signing = ref<BookingAgreementRecord | null>(null)
const signingOpen = ref(false)
function openSigning(value: BookingAgreementRecord) {
  signing.value = value
  signingOpen.value = true
}

async function refresh() {
  error.value = ''
  try {
    await editor!.refresh()
  } catch (failure) {
    error.value = getErrorMessage(failure, 'The booking could not be read again')
  }
}
</script>
