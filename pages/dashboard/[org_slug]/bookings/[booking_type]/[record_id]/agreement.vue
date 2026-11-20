<template>
  <DashboardLeafPanel
    id="booking-agreement-send"
    title="Mark where everyone signs"
    :lead="file ? file.name : 'Choose the PDF your guests sign. Mark each signer’s signature and date, then send it.'"
    save-label="Send"
    :saving="saving"
    :disabled="!ready"
    :error="failure"
    @save="send"
  >
    <UButton v-if="!file" icon="i-lucide-upload" label="Choose a PDF" color="neutral" variant="outline" size="lg" @click="picker?.click()" />
    <input ref="picker" type="file" accept="application/pdf" class="hidden" @change="choose">
    <template v-if="file">
      <div role="group" aria-label="Place a field for" class="flex flex-wrap gap-2">
        <UButton v-for="signer in signers" :key="signer.key" :label="pillLabel(signer)" :color="signer.key === selected ? 'neutral' : 'neutral'" :variant="signer.key === selected ? 'solid' : 'outline'" class="rounded-full" @click="selected = signer.key" />
      </div>
      <p class="mt-2.5 text-xs text-muted">Tap the page to add {{ selectedName }}’s signature and date. Drag a field to move it.</p>
      <div class="mt-4 -mx-4 bg-elevated px-4 py-5 sm:mx-0 sm:rounded-2xl">
        <div ref="pageBox" class="relative mx-auto w-full max-w-[560px] cursor-crosshair bg-white shadow" @click="place">
          <canvas ref="canvas" class="block h-auto w-full" />
          <div
            v-for="(field, at) in pageFields"
            :key="at"
            class="absolute flex cursor-move items-center justify-between rounded border-[1.5px] border-dashed border-black bg-white/90 px-1.5 text-[10px] font-semibold text-black"
            :style="{ left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.width * 100}%`, height: `${field.height * 100}%` }"
            @click.stop
            @pointerdown="drag($event, field)"
          >
            <span class="truncate">{{ nameOf(field.signer_key) }} · {{ field.kind === 'signature' ? 'Signature' : 'Date' }}</span>
            <button type="button" class="ms-1 shrink-0" :aria-label="`Remove ${nameOf(field.signer_key)}’s ${field.kind}`" @click.stop="remove(field)"><UIcon name="i-lucide-x" class="size-3" /></button>
          </div>
        </div>
        <div class="mt-3 flex items-center justify-center gap-4 text-sm">
          <UButton icon="i-lucide-chevron-left" color="neutral" variant="outline" class="rounded-full" aria-label="Previous page" :disabled="page <= 1" @click="page--" />
          <span>Page {{ page }} of {{ pages }}</span>
          <UButton icon="i-lucide-chevron-right" color="neutral" variant="outline" class="rounded-full" aria-label="Next page" :disabled="page >= pages" @click="page++" />
        </div>
      </div>
      <h2 class="mt-7 text-lg font-semibold text-highlighted">Signers</h2>
      <ul class="mt-2">
        <li v-for="signer in signers" :key="signer.key" class="flex items-center gap-3 py-2.5">
          <UAvatar :text="signer.name.slice(0, 1).toUpperCase()" :alt="signer.name" size="sm" class="bg-accented" />
          <span class="min-w-0 flex-1 text-sm">
            <span class="block font-medium text-highlighted">{{ signer.role === 'host' ? 'You' : signer.name }}</span>
            <span class="block text-xs text-muted">{{ signerLine(signer) }}</span>
          </span>
        </li>
      </ul>
      <UForm v-if="adding" :state="invite" class="mt-2 space-y-3" @submit="addSigner">
        <UFormField label="Name" required><UInput v-model="invite.name" class="w-full" /></UFormField>
        <UFormField label="Email" required><UInput v-model="invite.email" type="email" autocomplete="email" class="w-full" /></UFormField>
        <UButton type="submit" label="Add signer" color="neutral" :disabled="!invite.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invite.email.trim())" />
      </UForm>
      <UButton v-else class="mt-1 px-0" icon="i-lucide-plus" label="Add a signer by email" color="neutral" variant="link" @click="adding = true" />
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import DashboardLeafPanel from '~/lib/components/workspace/dashboard/DashboardLeafPanel.vue'
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'
import type { AgreementField } from '~/shared/agreements'
import { isRecord } from '~/utils/api-clients'
import { getErrorMessage, showNotFound } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

type Signer = { key: string; name: string; role: 'guest' | 'host' }
const editor = inject(bookingEditorKey, null)
const level = useRouteLevel()
const conversationId = editor?.conversationId.value ?? null
const available = editor?.agreement.value?.signers ?? null
if (!conversationId || !available) showNotFound('This booking has no documents you can send')

const signers = ref<Signer[]>([...(available ?? []).filter(signer => signer.role === 'guest'), ...(available ?? []).filter(signer => signer.role === 'host')])
const selected = ref(signers.value[0]?.key ?? '')
const fields = ref<AgreementField[]>([])
const file = ref<File | null>(null)
const page = ref(1)
const pages = ref(0)
const picker = ref<HTMLInputElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const pageBox = ref<HTMLElement | null>(null)
const saving = ref(false)
const failure = ref('')
const adding = ref(false)
const invite = reactive({ name: '', email: '' })
// A type alone: erased from both bundles.
let pdf: import('pdfjs-dist').PDFDocumentProxy | null = null

const selectedName = computed(() => nameOf(selected.value))
const pageFields = computed(() => fields.value.filter(field => field.page === page.value))
const ready = computed(() => Boolean(file.value) && signers.value.some(signer => signer.role === 'guest')
  && signers.value.every(signer => fields.value.some(field => field.signer_key === signer.key && field.kind === 'signature')))

function nameOf(key: string) {
  const signer = signers.value.find(entry => entry.key === key)
  return signer?.role === 'host' ? 'You' : signer?.name.split(' ')[0] ?? ''
}
function pillLabel(signer: Signer) {
  return signer.role === 'host' ? 'You' : signer.name.split(' ')[0]!
}
function signerLine(signer: Signer) {
  const count = fields.value.filter(field => field.signer_key === signer.key).length
  const placed = `${count} ${count === 1 ? 'field' : 'fields'}`
  if (signer.role === 'host') return `Signs last · ${placed}`
  return `${signer.key.startsWith('email:') ? 'Invited by email' : 'On this booking'} · ${placed}`
}

async function choose(event: Event) {
  const input = event.target as HTMLInputElement
  const chosen = input.files?.[0]
  input.value = ''
  if (!chosen) return
  failure.value = ''
  try {
    // The PDF renderer is the browser's alone; the server bundle never carries it.
    if (!import.meta.client) throw new Error('PDFs open in the browser')
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
    pdf = await pdfjs.getDocument({ data: new Uint8Array(await chosen.arrayBuffer()) }).promise
    file.value = chosen
    pages.value = pdf.numPages
    fields.value = []
    page.value = pdf.numPages
    await nextTick()
    await render()
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'This PDF could not be opened')
  }
}

async function render() {
  if (!pdf || !canvas.value) return
  const current = await pdf.getPage(page.value)
  const viewport = current.getViewport({ scale: 2 })
  canvas.value.width = viewport.width
  canvas.value.height = viewport.height
  await current.render({ canvas: canvas.value, viewport }).promise
}
watch(page, () => { void render() })

const SIGNATURE = { width: 0.42, height: 0.045 }
const DATE = { width: 0.2, height: 0.045 }
const clamp = (value: number, size: number) => Math.min(Math.max(value, 0), 1 - size)

function place(event: MouseEvent) {
  if (!pageBox.value || !selected.value) return
  const box = pageBox.value.getBoundingClientRect()
  const x = clamp((event.clientX - box.left) / box.width, SIGNATURE.width + DATE.width + 0.02)
  const y = clamp((event.clientY - box.top) / box.height - SIGNATURE.height / 2, SIGNATURE.height)
  fields.value.push(
    { signer_key: selected.value, kind: 'signature', page: page.value, x, y, ...SIGNATURE },
    { signer_key: selected.value, kind: 'date', page: page.value, x: x + SIGNATURE.width + 0.02, y, ...DATE },
  )
}

function remove(field: AgreementField) {
  fields.value = fields.value.filter(entry => entry !== field)
}

function drag(event: PointerEvent, field: AgreementField) {
  if (!pageBox.value || (event.target as HTMLElement).closest('button')) return
  const box = pageBox.value.getBoundingClientRect()
  const start = { x: event.clientX, y: event.clientY, fieldX: field.x, fieldY: field.y }
  const move = (next: PointerEvent) => {
    field.x = clamp(start.fieldX + (next.clientX - start.x) / box.width, field.width)
    field.y = clamp(start.fieldY + (next.clientY - start.y) / box.height, field.height)
  }
  const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
}

function addSigner() {
  const key = `email:${invite.email.trim().toLowerCase()}`
  if (!signers.value.some(signer => signer.key === key)) {
    const host = signers.value.findIndex(signer => signer.role === 'host')
    signers.value.splice(host === -1 ? signers.value.length : host, 0, { key, name: invite.name.trim(), role: 'guest' })
  }
  selected.value = key
  invite.name = ''
  invite.email = ''
  adding.value = false
}

async function send() {
  if (!ready.value || !file.value || !conversationId || saving.value) return
  saving.value = true
  failure.value = ''
  try {
    const form = new FormData()
    form.append('file', file.value)
    form.append('details', JSON.stringify({ signers: signers.value, fields: fields.value }))
    await applicationFetch(`/api/messages/${encodeURIComponent(conversationId)}/agreement/send`, { method: 'POST', body: form, validate: isRecord })
    await editor!.refresh()
    if (level.to.value) await navigateTo(level.to.value, { replace: true })
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The document could not be sent')
  } finally {
    saving.value = false
  }
}
</script>
