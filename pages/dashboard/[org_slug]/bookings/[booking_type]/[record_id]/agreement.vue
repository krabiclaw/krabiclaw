<template>
  <div>
    <!-- OVERVIEW MODE (Within standard DashboardLeafPanel) -->
    <DashboardLeafPanel
      v-if="viewMode === 'overview'"
      id="booking-agreement-panel"
      :title="panelTitle"
      lead="Review, prepare, and manage agreements and signatures for this booking."
      :save-label="null"
      :error="busyError"
    >
      <div class="space-y-6">
        <!-- Empty State: No document sent yet -->
        <div v-if="!agreement" class="py-8 text-center" data-testid="booking-agreement-empty">
          <div class="mx-auto flex size-12 items-center justify-center rounded-full bg-elevated text-muted">
            <UIcon name="i-lucide-file-text" class="size-6" />
          </div>
          <h3 class="mt-4 text-base font-semibold text-highlighted">No {{ agreementName.toLowerCase() }} sent yet</h3>
          <p class="mx-auto mt-2 max-w-sm text-sm text-muted">
            Prepare and send a {{ agreementName.toLowerCase() }} for electronic signature, or upload an already signed copy for your records.
          </p>
          <div class="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <UButton icon="i-lucide-sparkles" :label="`Prepare ${agreementName.toLowerCase()}`" color="primary" size="lg" data-testid="booking-agreement-prepare" @click="openTermsBuilder" />
            <UButton icon="i-lucide-upload" label="Upload custom PDF" color="neutral" variant="outline" size="lg" data-testid="booking-agreement-send" @click="pickerSend?.click()" />
            <UButton icon="i-lucide-file-check" label="Add signed copy" color="neutral" variant="ghost" size="lg" :loading="busy === 'store'" @click="pickerStore?.click()" />
          </div>
          <input ref="pickerSend" type="file" accept="application/pdf" class="hidden" data-testid="picker-send" @change="choose">
          <input ref="pickerStore" type="file" accept="application/pdf" class="hidden" data-testid="picker-store" @change="storeSignedCopy">
        </div>

        <!-- Active Agreement State -->
        <template v-else>
          <!-- Status Banner -->
          <div>
            <p class="text-sm font-semibold text-highlighted" data-testid="booking-agreement-status">{{ statusLine }}</p>
          </div>

          <!-- Document Card -->
          <div class="flex items-center gap-3.5 rounded-xl border border-default bg-elevated/40 p-3.5">
            <div class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-default text-highlighted shadow-xs">
              <UIcon name="i-lucide-file-text" class="size-6" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-highlighted">{{ agreement.file_name }}</p>
              <p class="text-xs text-muted">{{ agreement.source === 'listing' ? 'From the listing' : agreement.status === 'stored' ? 'Signed copy on file' : 'Prepared for this booking' }}</p>
            </div>
            <a v-if="downloadUrl" :href="downloadUrl" target="_blank" rel="noopener" class="flex shrink-0 items-center gap-1.5 rounded-lg border border-default bg-default px-3 py-1.5 text-xs font-medium text-highlighted hover:bg-elevated transition-colors">
              <UIcon name="i-lucide-download" class="size-3.5 text-muted" />
              <span>{{ agreement.signed_url ? 'Signed PDF' : 'Download' }}</span>
            </a>
          </div>

          <!-- Signers Section -->
          <div class="space-y-3">
            <h3 class="text-sm font-semibold text-highlighted">Signers</h3>
            <ul v-if="agreement.signers.length" class="space-y-2.5">
              <li v-for="signer in agreement.signers" :key="signer.key" class="flex items-center gap-3 rounded-xl border border-default bg-default p-3">
                <UAvatar :text="signer.name.slice(0, 1).toUpperCase()" :alt="signer.name" size="sm" class="bg-accented font-semibold text-highlighted" />
                <div class="min-w-0 flex-1 text-sm">
                  <div class="flex items-center gap-2">
                    <span class="font-medium text-highlighted">{{ signer.key === agreement.viewer_signer_key ? 'You' : signer.name }}</span>
                    <span v-if="signer.role === 'host'" class="rounded bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-muted">Host</span>
                  </div>
                  <p class="text-xs text-muted">{{ signer.signed_at ? `Signed ${formatWhen(signer.signed_at)}` : 'Waiting for signature' }}</p>
                </div>
                <UIcon v-if="signer.signed_at" name="i-lucide-circle-check" class="size-5 text-success" aria-label="Signed" />
                <span v-else class="size-2 rounded-full bg-amber-500" />
              </li>
            </ul>
          </div>

          <!-- Counterparty / Host Signing Button -->
          <div v-if="agreement.can_sign" class="pt-2">
            <UButton block size="lg" color="primary" label="Sign now" icon="i-lucide-pen-tool" data-testid="booking-agreement-sign-trigger" @click="signing = true" />
          </div>

          <!-- Management Actions -->
          <div v-if="agreement.can_manage" class="space-y-2 pt-4 border-t border-default">
            <h4 class="text-xs font-semibold uppercase tracking-wider text-muted">Manage document</h4>
            <div class="space-y-1">
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-highlighted hover:bg-elevated transition-colors"
                @click="pickerSend?.click()"
              >
                <UIcon name="i-lucide-refresh-cw" class="size-4 text-muted" />
                <span>Replace document</span>
              </button>
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-highlighted hover:bg-elevated transition-colors"
                @click="pickerStore?.click()"
              >
                <UIcon name="i-lucide-file-check" class="size-4 text-muted" />
                <span>Add a signed copy</span>
              </button>
              <button
                v-if="agreement.status === 'signing'"
                type="button"
                :disabled="busy === 'cancel'"
                class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-error hover:bg-error/10 transition-colors"
                @click="cancelSigningRequest"
              >
                <UIcon name="i-lucide-circle-x" class="size-4" />
                <span>{{ busy === 'cancel' ? 'Cancelling…' : 'Cancel signing request' }}</span>
              </button>
            </div>
            <input ref="pickerSend" type="file" accept="application/pdf" class="hidden" data-testid="picker-send" @change="choose">
            <input ref="pickerStore" type="file" accept="application/pdf" class="hidden" data-testid="picker-store" @change="storeSignedCopy">
          </div>
        </template>
      </div>

      <!-- Host In-Leaf Signing Sheet -->
      <AgreementSignSheet
        v-if="agreement && agreement.can_sign"
        v-model:open="signing"
        :agreement="agreement"
        :conversation-id="conversationId || ''"
        @signed="onSigned"
      />
    </DashboardLeafPanel>

    <!-- FULL-SCREEN FIELD PLACEMENT WORKSPACE (Zillow Screenshots 10, 11 & 12 Parity) -->
    <Teleport to="body">
      <div
        v-if="viewMode === 'send'"
        class="fixed inset-0 z-50 flex flex-col bg-slate-100 dark:bg-slate-950 text-default antialiased"
        data-testid="fullscreen-field-workspace"
      >
        <!-- Top Bar -->
        <header class="flex h-14 shrink-0 items-center justify-between border-b border-default bg-default px-4 shadow-xs">
          <div class="flex items-center gap-3">
            <div class="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <UIcon name="i-lucide-file-text" class="size-4" />
            </div>
            <div>
              <h2 class="text-sm font-semibold text-highlighted leading-none">{{ workspaceTitle }}</h2>
              <p class="text-xs text-muted mt-0.5">{{ file ? file.name : 'Lease preparation' }}</p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" aria-label="Close workspace" @click="viewMode = 'overview'" />
          </div>
        </header>

        <!-- Main Body -->
        <div class="flex min-h-0 flex-1">
          <!-- Left Tool Sidebar (280px) -->
          <aside class="flex w-72 shrink-0 flex-col border-r border-default bg-default">
            <!-- Sidebar Dual Mode Tabs -->
            <div class="flex border-b border-default p-1.5 bg-elevated/30">
              <button
                type="button"
                :class="sidebarTab === 'fields' ? 'bg-default text-highlighted shadow-xs font-semibold' : 'text-muted hover:text-highlighted'"
                class="flex flex-1 items-center justify-center gap-2 rounded-lg py-1.5 text-xs transition-colors"
                @click="sidebarTab = 'fields'"
              >
                <UIcon name="i-lucide-layout-grid" class="size-3.5" />
                <span>Fields</span>
              </button>
              <button
                type="button"
                :class="sidebarTab === 'pages' ? 'bg-default text-highlighted shadow-xs font-semibold' : 'text-muted hover:text-highlighted'"
                class="flex flex-1 items-center justify-center gap-2 rounded-lg py-1.5 text-xs transition-colors"
                @click="sidebarTab = 'pages'"
              >
                <UIcon name="i-lucide-files" class="size-3.5" />
                <span>Pages ({{ pages }})</span>
              </button>
            </div>

            <!-- MODE 1: Field Palette (Screenshots 10 & 11) -->
            <div v-if="sidebarTab === 'fields'" class="flex-1 overflow-y-auto p-3 space-y-4">
              <!-- Signer Selector Accordions -->
              <div v-for="signer in signers" :key="signer.key" class="rounded-xl border border-default bg-default overflow-hidden shadow-2xs">
                <button
                  type="button"
                  class="flex w-full items-center justify-between p-3 text-left transition-colors hover:bg-elevated/40"
                  :class="selected === signer.key ? 'bg-primary/5 text-primary' : 'text-highlighted'"
                  @click="selected = signer.key"
                >
                  <div class="flex items-center gap-2.5 min-w-0">
                    <UAvatar :text="signer.name.slice(0, 1).toUpperCase()" size="xs" class="bg-accented font-semibold text-highlighted" />
                    <span class="truncate text-xs font-semibold">{{ signer.role === 'host' ? 'You' : signer.name }}</span>
                  </div>
                  <span class="rounded bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-muted">
                    {{ fields.filter(f => f.signer_key === signer.key).length }} fields
                  </span>
                </button>

                <!-- Field Buttons for Signer -->
                <div class="border-t border-default bg-elevated/20 p-2.5 space-y-2">
                  <p class="text-[11px] text-muted">Click to add to Page {{ page }}:</p>
                  <div class="grid grid-cols-2 gap-2" role="group" :aria-label="`Place a field for ${pillLabel(signer)}`">
                    <button
                      type="button"
                      class="flex items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-2 text-xs font-medium text-highlighted hover:border-primary hover:text-primary transition-colors shadow-2xs"
                      @click="placeDirectField(signer.key, 'signature')"
                    >
                      <UIcon name="i-lucide-pen-tool" class="size-3.5 text-primary" />
                      <span>Signature</span>
                    </button>
                    <button
                      type="button"
                      class="flex items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-2 text-xs font-medium text-highlighted hover:border-primary hover:text-primary transition-colors shadow-2xs"
                      @click="placeDirectField(signer.key, 'date')"
                    >
                      <UIcon name="i-lucide-calendar" class="size-3.5 text-primary" />
                      <span>Date</span>
                    </button>
                  </div>
                </div>
              </div>

              <!-- Add Additional Signer by Email -->
              <div class="pt-2">
                <button
                  v-if="!adding"
                  type="button"
                  class="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-default py-2.5 text-xs font-medium text-muted hover:border-primary hover:text-primary transition-colors"
                  @click="adding = true"
                >
                  <UIcon name="i-lucide-user-plus" class="size-3.5" />
                  <span>Add another signer</span>
                </button>
                <form v-else class="space-y-2 rounded-xl border border-default bg-elevated/20 p-3" @submit.prevent="addSigner">
                  <input v-model="invite.name" type="text" placeholder="Full name" required class="w-full rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs text-highlighted">
                  <input v-model="invite.email" type="email" placeholder="Email address" required class="w-full rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs text-highlighted">
                  <div class="flex gap-2">
                    <UButton type="submit" size="xs" color="neutral" label="Add" :disabled="!invite.name.trim() || !invite.email.trim()" />
                    <UButton size="xs" color="neutral" variant="ghost" label="Cancel" @click="adding = false" />
                  </div>
                </form>
              </div>
            </div>

            <!-- MODE 2: Pages Thumbnail Strip (Screenshot 12) -->
            <div v-else class="flex-1 overflow-y-auto p-3 space-y-3">
              <p class="text-xs font-medium text-muted">Jump to page:</p>
              <div class="space-y-2">
                <button
                  v-for="pageNum in pages"
                  :key="pageNum"
                  type="button"
                  class="flex w-full items-center gap-3 rounded-xl border p-2 text-left transition-all"
                  :class="page === pageNum ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-default bg-default hover:bg-elevated'"
                  @click="page = pageNum"
                >
                  <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-elevated font-mono text-xs font-semibold text-highlighted">
                    {{ pageNum.toString().padStart(2, '0') }}
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="text-xs font-semibold text-highlighted">Page {{ pageNum }}</p>
                    <p class="text-[11px] text-muted">{{ fields.filter(f => f.page === pageNum).length }} fields placed</p>
                  </div>
                </button>
              </div>
            </div>

            <!-- Sidebar Footer Instructions -->
            <div class="border-t border-default p-3 bg-elevated/20 text-xs text-muted">
              <p>Click anywhere on the document to place fields for <span class="font-semibold text-highlighted">{{ selectedName }}</span>. Drag fields to reposition.</p>
            </div>
          </aside>

          <!-- Center Canvas Viewport -->
          <main class="flex flex-1 flex-col overflow-hidden bg-slate-200/70 dark:bg-slate-900 relative">
            <!-- Scrollable Canvas Area -->
            <div class="flex-1 overflow-auto p-8 flex justify-center items-start">
              <div
                ref="pageBox"
                class="relative bg-white shadow-2xl rounded-sm transition-transform origin-top"
                :style="{ transform: `scale(${zoom})` }"
                @click="place"
              >
                <!-- Rendered PDF Page -->
                <canvas ref="canvas" class="block pointer-events-none" />

                <!-- Placed Field Badges -->
                <div
                  v-for="field in pageFields"
                  :key="`${field.signer_key}:${field.kind}:${field.x}:${field.y}`"
                  class="absolute flex items-center justify-between gap-1 select-none cursor-move rounded border-2 font-medium transition-all group"
                  :class="selected === field.signer_key
                    ? 'border-cyan-500 bg-cyan-500/15 text-cyan-900 dark:text-cyan-100 ring-2 ring-cyan-500/30'
                    : 'border-slate-500 bg-slate-500/15 text-slate-900 dark:text-slate-100'"
                  :style="{
                    left: `${field.x * 100}%`,
                    top: `${field.y * 100}%`,
                    width: `${field.width * 100}%`,
                    height: `${field.height * 100}%`,
                  }"
                  @pointerdown.stop="drag($event, field)"
                >
                  <span class="truncate pl-2 text-xs font-semibold leading-none">
                    {{ nameOf(field.signer_key) }} · {{ field.kind === 'signature' ? 'Signature' : 'Date' }}
                  </span>
                  <button
                    type="button"
                    class="mr-1.5 flex size-5 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-muted hover:text-error transition-colors"
                    title="Remove field"
                    @click.stop="remove(field)"
                  >
                    <UIcon name="i-lucide-x" class="size-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <!-- Floating Zoom & Page Toolbar -->
            <div class="absolute bottom-16 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-default bg-default/90 px-3 py-1.5 shadow-lg backdrop-blur-md">
              <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="xs" :disabled="page <= 1" @click="page--" />
              <span class="px-2 text-xs font-semibold text-highlighted font-mono">Page {{ page }} of {{ pages }}</span>
              <UButton icon="i-lucide-chevron-right" color="neutral" variant="ghost" size="xs" :disabled="page >= pages" @click="page++" />
              <div class="mx-1 h-3.5 w-px bg-default" />
              <UButton icon="i-lucide-minus" color="neutral" variant="ghost" size="xs" :disabled="zoom <= 0.6" @click="zoom = Math.max(0.5, zoom - 0.1)" />
              <span class="px-1 text-xs text-muted font-mono">{{ Math.round(zoom * 100) }}%</span>
              <UButton icon="i-lucide-plus" color="neutral" variant="ghost" size="xs" :disabled="zoom >= 1.6" @click="zoom = Math.min(1.8, zoom + 0.1)" />
            </div>

            <!-- Sticky Bottom Action Bar -->
            <footer class="flex h-14 shrink-0 items-center justify-between border-t border-default bg-default px-6 shadow-xs">
              <div class="flex items-center gap-2 text-xs">
                <UIcon v-if="ready" name="i-lucide-circle-check" class="size-4 text-success" />
                <span :class="ready ? 'text-highlighted font-medium' : 'text-amber-600 dark:text-amber-400 font-medium'">
                  {{ ready ? 'All required signers have a signature placed' : 'Place at least one signature field for each party' }}
                </span>
              </div>
              <div class="flex items-center gap-3">
                <UButton color="neutral" variant="ghost" size="md" label="Back" @click="viewMode = 'overview'" />
                <UButton
                  color="neutral"
                  size="md"
                  label="Request signatures"
                  icon="i-lucide-send"
                  :loading="saving"
                  :disabled="!ready"
                  data-testid="request-signatures-button"
                  @click="send"
                />
              </div>
            </footer>
          </main>
        </div>
      </div>
    </Teleport>

    <!-- STRUCTURED LEASE & TERMS BUILDER MODAL (Screenshots 01–09 Parity, #2038, #1908, #1907) -->
    <DashboardListItemDialog
      v-model:open="termsBuilderOpen"
      :title="`Prepare ${agreementName}`"
      :show-actions="false"
    >
      <form class="space-y-5" @submit.prevent="generateFromTerms">
        <!-- 1. Lease Terms: Fixed vs Month-to-month (Screenshots 01, 02, 03) -->
        <div class="space-y-3">
          <label class="block text-sm font-semibold text-highlighted">What are your lease terms? *</label>
          <div class="grid grid-cols-2 gap-3">
            <label
              class="flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors"
              :class="termsDraft.termType === 'fixed' ? 'border-primary bg-primary/5' : 'border-default bg-default'"
            >
              <input v-model="termsDraft.termType" type="radio" value="fixed" class="mt-0.5 accent-primary">
              <div>
                <span class="block text-xs font-semibold text-highlighted">Fixed term</span>
                <span class="block text-[11px] text-muted">Specify start and end date</span>
              </div>
            </label>
            <label
              class="flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors"
              :class="termsDraft.termType === 'month_to_month' ? 'border-primary bg-primary/5' : 'border-default bg-default'"
            >
              <input v-model="termsDraft.termType" type="radio" value="month_to_month" class="mt-0.5 accent-primary">
              <div>
                <span class="block text-xs font-semibold text-highlighted">Month-to-month</span>
                <span class="block text-[11px] text-muted">Specify start date only</span>
              </div>
            </label>
          </div>

          <!-- Dates (Screenshot 02 & 03) -->
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 pt-1">
            <div>
              <label class="mb-1 block text-xs font-medium text-highlighted">Start / move-in date *</label>
              <input v-model="termsDraft.startDate" type="date" required class="w-full rounded-xl border border-default bg-default px-3 py-2 text-xs text-highlighted">
            </div>
            <div v-if="termsDraft.termType === 'fixed'">
              <label class="mb-1 block text-xs font-medium text-highlighted">End date *</label>
              <input v-model="termsDraft.endDate" type="date" required class="w-full rounded-xl border border-default bg-default px-3 py-2 text-xs text-highlighted">
            </div>
          </div>
          <button
            v-if="termsDraft.termType === 'fixed'"
            type="button"
            class="text-xs font-medium text-primary hover:underline"
            @click="setOneYearTerm"
          >
            Set to 1 year term
          </button>
        </div>

        <!-- 2. Rent & Monthly Payment (#1907, Screenshot 07) -->
        <div class="space-y-2 border-t border-default pt-4">
          <label class="block text-sm font-semibold text-highlighted">Monthly payment amount *</label>
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold text-muted">{{ termsDraft.currency }}</span>
            <input
              v-model="termsDraft.monthlyRent"
              type="number"
              step="any"
              required
              placeholder="e.g. 1500"
              class="w-full rounded-xl border border-default bg-default px-3 py-2 text-xs text-highlighted font-mono"
            >
          </div>
          <p class="text-[11px] text-muted">Due on the 1st of each calendar month (#1907 payment ledger).</p>
        </div>

        <!-- 3. Security Deposit & Escrow (#1908, Screenshot 08) -->
        <div class="space-y-2 border-t border-default pt-4">
          <label class="block text-sm font-semibold text-highlighted">Security deposit / escrow amount *</label>
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold text-muted">{{ termsDraft.currency }}</span>
            <input
              v-model="termsDraft.deposit"
              type="number"
              step="any"
              required
              placeholder="e.g. 1500"
              class="w-full rounded-xl border border-default bg-default px-3 py-2 text-xs text-highlighted font-mono"
            >
          </div>
          <p class="text-[11px] text-muted">Refundable deposit held in escrow against damages or unpaid charges (#1908).</p>
        </div>

        <div class="pt-2">
          <UButton
            type="submit"
            block
            size="lg"
            color="neutral"
            label="Generate and mark fields"
            icon="i-lucide-arrow-right"
            :loading="generatingPdf"
          />
        </div>
      </form>
    </DashboardListItemDialog>
  </div>
</template>

<script setup lang="ts">
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'
import { generateAgreementPdf } from '~/shared/agreement-generator'
import type { AgreementField, BookingAgreement } from '~/shared/agreements'
import { isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

interface Signer {
  key: string
  name: string
  role: 'guest' | 'host'
}

const editor = inject(bookingEditorKey, null)
const route = useRoute()
const conversationId = computed(() => {
  if (route.params.conversation_id) return String(route.params.conversation_id)
  if (editor?.conversationId.value) return editor.conversationId.value
  return null
})

const viewMode = ref<'overview' | 'send'>('overview')
const sidebarTab = ref<'fields' | 'pages'>('fields')
const zoom = ref(1.0)
const termsBuilderOpen = ref(false)
const generatingPdf = ref(false)

const termsDraft = reactive({
  termType: 'fixed' as 'fixed' | 'month_to_month',
  startDate: new Date().toISOString().split('T')[0]!,
  endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!,
  monthlyRent: '1500',
  deposit: '1500',
  currency: 'USD',
})

function setOneYearTerm() {
  const start = new Date(termsDraft.startDate)
  if (!isNaN(start.getTime())) {
    const end = new Date(start)
    end.setFullYear(end.getFullYear() + 1)
    termsDraft.endDate = end.toISOString().split('T')[0]!
  }
}

function openTermsBuilder() {
  termsBuilderOpen.value = true
}

const agreement = ref<BookingAgreement | null>(editor?.currentAgreement.value ?? null)
const signers = ref<Signer[]>(
  editor?.agreement.value?.signers.map(s => ({ key: s.key, name: s.name, role: s.role }))
  ?? [
    { key: 'user:counterparty', name: 'Harold Webber', role: 'guest' },
    { key: 'user:host', name: 'You', role: 'host' },
  ],
)

const file = ref<File | null>(null)
const page = ref(1)
const pages = ref(1)
const fields = ref<AgreementField[]>([])
const selected = ref<string>(signers.value[0]?.key ?? '')

const pageBox = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const pickerSend = ref<HTMLInputElement | null>(null)
const pickerStore = ref<HTMLInputElement | null>(null)

const saving = ref(false)
const failure = ref('')
const busy = ref<'store' | 'cancel' | null>(null)
const busyError = ref('')
const signing = ref(false)
const adding = ref(false)
const invite = reactive({ name: '', email: '' })
let pdf: import('pdfjs-dist').PDFDocumentProxy | null = null

const selectedName = computed(() => nameOf(selected.value))

const panelTitle = computed(() => {
  return agreement.value?.label ?? agreementName.value
})

const workspaceTitle = computed(() => {
  return `Lease for ${agreementName.value}`
})

const agreementName = computed(() => {
  const kind = route.params.booking_type ? String(route.params.booking_type) : ''
  if (kind === 'stay') return 'Lease'
  if (kind === 'service') return 'Engagement letter'
  if (kind === 'experience') return 'Waiver'
  return 'Rental agreement'
})

const pageFields = computed(() => fields.value.filter(field => field.page === page.value))

const ready = computed(() => Boolean(file.value) && signers.value.some(signer => signer.role === 'guest')
  && signers.value.every(signer => fields.value.some(field => field.signer_key === signer.key && field.kind === 'signature')))

const downloadUrl = computed(() => {
  const url = agreement.value?.signed_url ?? agreement.value?.url
  if (!url || !url.startsWith('/api/')) return url ?? null
  return `${url}?download=1`
})

function formatWhen(at: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(at))
}

function names(list: string[]) {
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
}

const statusLine = computed(() => {
  const value = agreement.value
  if (!value) return ''
  const day = (at: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(at))
  if (value.status === 'stored') return `Signed copy added ${day(value.completed_at!)}`
  if (value.status === 'signed') return `All parties signed on ${day(value.completed_at!)}`
  const waiting = value.signers.filter(signer => !signer.signed_at).map(signer => signer.key === value.viewer_signer_key ? 'you' : signer.name.split(' ')[0]!)
  return `Waiting on ${names(waiting)}`
})

async function loadAgreement() {
  if (!conversationId.value) return
  try {
    const res = await applicationFetch(`/api/messages/${encodeURIComponent(conversationId.value)}/agreement`, {
      method: 'GET',
      validate: (v): v is { agreement: BookingAgreement | null; can_manage: boolean } => isRecord(v),
    })
    agreement.value = res.agreement
  } catch {
    // Keep current
  }
}

async function storeSignedCopy(event: Event) {
  const input = event.target as HTMLInputElement
  const chosen = input.files?.[0]
  input.value = ''
  if (!chosen || !conversationId.value) return
  busyError.value = ''
  busy.value = 'store'
  try {
    const form = new FormData()
    form.append('file', chosen)
    await applicationFetch(`/api/messages/${encodeURIComponent(conversationId.value)}/agreement/store`, { method: 'POST', body: form, validate: isRecord })
    await editor?.refresh()
    await loadAgreement()
  } catch (cause) {
    busyError.value = getErrorMessage(cause, 'The signed copy could not be uploaded')
  } finally {
    busy.value = null
  }
}

async function cancelSigningRequest() {
  if (!conversationId.value || busy.value) return
  busyError.value = ''
  busy.value = 'cancel'
  try {
    await applicationFetch(`/api/messages/${encodeURIComponent(conversationId.value)}/agreement/cancel`, { method: 'POST', body: {}, validate: isRecord })
    await editor?.refresh()
    await loadAgreement()
  } catch (cause) {
    busyError.value = getErrorMessage(cause, 'The signing request could not be cancelled')
  } finally {
    busy.value = null
  }
}

async function onSigned() {
  await editor?.refresh()
  await loadAgreement()
}

function nameOf(key: string) {
  const signer = signers.value.find(entry => entry.key === key)
  return signer?.role === 'host' ? 'You' : signer?.name.split(' ')[0] ?? ''
}
function pillLabel(signer: Signer) {
  return signer.role === 'host' ? 'You' : signer.name.split(' ')[0]!
}

async function loadPdfIntoWorkspace(pdfData: Uint8Array, fileName: string) {
  if (!import.meta.client) throw new Error('PDFs open in the browser')
  const pdfBytesForFile = new Uint8Array(pdfData)
  file.value = new File([pdfBytesForFile], fileName, { type: 'application/pdf' })

  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
  pdf = await pdfjs.getDocument({ data: pdfData.slice() }).promise
  pages.value = pdf.numPages
  page.value = pdf.numPages
  viewMode.value = 'send'
  await nextTick()
  await render()
}

async function generateFromTerms() {
  generatingPdf.value = true
  try {
    const guestSigner = signers.value.find(s => s.role === 'guest') || { key: 'user:guest', name: 'Harold Webber' }
    const hostSigner = signers.value.find(s => s.role === 'host') || { key: 'user:host', name: 'Host' }

    const res = await generateAgreementPdf({
      kind: 'stay',
      businessName: 'Blawby Property Management',
      counterpartyKey: guestSigner.key,
      counterpartyName: guestSigner.name,
      hostKey: hostSigner.key,
      hostName: hostSigner.name,
      propertyOrMatter: '908 Islander Way, Chattanooga, TN 37402',
      termType: termsDraft.termType,
      startDate: termsDraft.startDate,
      endDate: termsDraft.termType === 'fixed' ? termsDraft.endDate : null,
      monthlyRentMinor: Math.round(Number(termsDraft.monthlyRent) * 100),
      depositMinor: Math.round(Number(termsDraft.deposit) * 100),
      currency: termsDraft.currency,
    })

    termsBuilderOpen.value = false
    fields.value = res.fields
    await loadPdfIntoWorkspace(res.bytes, res.fileName)
  } catch (cause) {
    console.error('GENERATE_FROM_TERMS_ERROR:', cause)
    failure.value = getErrorMessage(cause, 'Could not generate agreement')
  } finally {
    generatingPdf.value = false
  }
}

async function choose(event: Event) {
  const input = event.target as HTMLInputElement
  const chosen = input.files?.[0]
  input.value = ''
  if (!chosen) return
  failure.value = ''
  try {
    fields.value = []
    await loadPdfIntoWorkspace(new Uint8Array(await chosen.arrayBuffer()), chosen.name)
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
  const canvasContext = canvas.value.getContext('2d')!
  await current.render({ canvas: canvas.value, canvasContext, viewport }).promise
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

function placeDirectField(signerKey: string, kind: 'signature' | 'date') {
  selected.value = signerKey
  const width = kind === 'signature' ? SIGNATURE.width : DATE.width
  const height = kind === 'signature' ? SIGNATURE.height : DATE.height
  fields.value.push({
    signer_key: signerKey,
    kind,
    page: page.value,
    x: 0.1,
    y: 0.8,
    width,
    height,
  })
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
  if (!ready.value || !file.value || !conversationId.value || saving.value) return
  saving.value = true
  failure.value = ''
  try {
    const form = new FormData()
    form.append('file', file.value)
    form.append('details', JSON.stringify({ signers: signers.value, fields: fields.value }))
    await applicationFetch(`/api/messages/${encodeURIComponent(conversationId.value)}/agreement/send`, { method: 'POST', body: form, validate: isRecord })
    await editor?.refresh()
    await loadAgreement()
    viewMode.value = 'overview'
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The document could not be sent')
  } finally {
    saving.value = false
  }
}
</script>
