<template>
  <div>
    <!-- OVERVIEW MODE: Zillow Lease Checklist & Summary (Zillow Screenshot 09 Parity) -->
    <DashboardLeafPanel
      v-if="viewMode === 'overview'"
      id="booking-agreement-panel"
      :title="panelTitle"
      lead="Review, prepare, and manage agreements and signatures for this booking."
      :save-label="null"
      :error="busyError"
    >
      <div class="space-y-6">
        <!-- Active Executed / Signed State (if already completed) -->
        <template v-if="agreement && agreement.status === 'signed'">
          <!-- Status Banner -->
          <div class="rounded-xl border border-default bg-emerald-500/10 p-4 text-emerald-800 dark:text-emerald-300">
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-circle-check" class="size-5 text-emerald-600 dark:text-emerald-400" />
              <p class="text-sm font-semibold" data-testid="booking-agreement-status">{{ statusLine }}</p>
            </div>
          </div>

          <!-- Document Card -->
          <div class="flex items-center gap-3.5 rounded-xl border border-default bg-default p-3.5 shadow-2xs">
            <div class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-elevated text-highlighted shadow-xs">
              <UIcon name="i-lucide-file-text" class="size-6" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-highlighted">{{ agreement.file_name }}</p>
              <p class="text-xs text-muted">Fully executed document on file</p>
            </div>
            <a v-if="downloadUrl" :href="downloadUrl" target="_blank" rel="noopener" class="flex shrink-0 items-center gap-1.5 rounded-lg border border-default bg-default px-3 py-1.5 text-xs font-medium text-highlighted hover:bg-elevated transition-colors">
              <UIcon name="i-lucide-download" class="size-3.5 text-muted" />
              <span>Download signed PDF</span>
            </a>
          </div>

          <!-- Signers Section -->
          <div class="space-y-3">
            <h3 class="text-sm font-semibold text-highlighted">Signers</h3>
            <ul class="space-y-2.5">
              <li v-for="signer in agreement.signers" :key="signer.key" class="flex items-center gap-3 rounded-xl border border-default bg-default p-3 shadow-2xs">
                <UAvatar :text="signer.name.slice(0, 1).toUpperCase()" :alt="signer.name" size="sm" class="bg-accented font-semibold text-highlighted" />
                <div class="min-w-0 flex-1 text-sm">
                  <span class="font-medium text-highlighted">{{ signer.key === agreement.viewer_signer_key ? 'You' : signer.name }}</span>
                  <p class="text-xs text-muted">{{ signer.signed_at ? `Signed ${formatWhen(signer.signed_at)}` : 'Signed' }}</p>
                </div>
                <UIcon name="i-lucide-circle-check" class="size-5 text-emerald-600 dark:text-emerald-400" aria-label="Signed" />
              </li>
            </ul>
          </div>
        </template>

        <!-- ZILLOW 4-CARD CHECKLIST OVERVIEW (Screenshot 09 Parity) -->
        <template v-else>
          <!-- Top Subhead & Action Bar -->
          <div class="flex items-center justify-between gap-4 border-b border-default pb-5">
            <div>
              <h2 class="text-base font-semibold text-highlighted">Your {{ agreementName.toLowerCase() }} is nearly ready to be signed</h2>
              <p class="text-xs text-muted mt-0.5">To finish getting your {{ agreementName.toLowerCase() }} ready, review the checklist below and mark where everyone should sign.</p>
            </div>
            <UButton
              color="neutral"
              size="md"
              label="Next"
              icon="i-lucide-arrow-right"
              trailing
              :loading="generatingPdf"
              data-testid="booking-agreement-prepare"
              class="shrink-0 font-medium"
              @click="proceedToWorkspace"
            />
          </div>

          <!-- CARD 1: Lease and supporting documents -->
          <section class="rounded-2xl border border-default bg-default p-5 shadow-xs space-y-4" data-testid="card-documents">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-semibold text-highlighted">{{ agreementName }} and supporting documents</h3>
              <span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                <UIcon name="i-lucide-check-circle-2" class="size-3.5" />
                Complete
              </span>
            </div>
            <p class="text-xs text-muted leading-relaxed">
              Add your {{ agreementName.toLowerCase() }} and any addenda that you want signed. Use a descriptive name for each document so your {{ tenantRoleNounPlural }} know what they are signing.
            </p>

            <!-- Document Row -->
            <div class="flex items-center gap-3 rounded-xl border border-default bg-elevated/20 p-3">
              <div class="cursor-grab text-muted hover:text-highlighted">
                <UIcon name="i-lucide-grip-vertical" class="size-4" />
              </div>
              <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-default text-highlighted shadow-2xs">
                <UIcon name="i-lucide-file-text" class="size-5 text-primary" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-semibold text-highlighted">{{ file ? file.name : agreement ? agreement.file_name : `${agreementSlug}-agreement.pdf` }}</p>
                <p class="text-[11px] text-muted">{{ file ? `${Math.round(file.size / 1024)} KB` : 'Primary agreement document' }}</p>
              </div>
              <div class="flex items-center gap-2">
                <UButton icon="i-lucide-upload" color="neutral" variant="ghost" size="xs" label="Replace" @click="pickerSend?.click()" />
              </div>
            </div>

            <!-- Upload Dropzone -->
            <div
              class="flex flex-col items-center justify-center rounded-xl border border-dashed border-default bg-elevated/10 p-6 text-center cursor-pointer hover:bg-elevated/30 transition-colors"
              @click="pickerSend?.click()"
            >
              <p class="text-xs text-muted max-w-sm">You can upload up to 10 images, PDFs, or Word documents. Each file must be smaller than 100MB.</p>
              <div class="mt-3">
                <UButton icon="i-lucide-plus" label="Add supporting file" color="neutral" variant="outline" size="xs" />
              </div>
              <p class="mt-2 text-[11px] text-dimmed">You may also drop files here or paste.</p>
            </div>
          </section>

          <!-- CARD 2: Lease duration -->
          <section class="rounded-2xl border border-default bg-default p-5 shadow-xs space-y-4" data-testid="card-duration">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-semibold text-highlighted">{{ agreementName }} duration</h3>
              <span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                <UIcon name="i-lucide-check-circle-2" class="size-3.5" />
                Complete
              </span>
            </div>
            <p class="text-xs text-muted">We will send you a reminder when the {{ agreementName.toLowerCase() }} is approaching its expiration date.</p>
            <div class="flex items-start justify-between rounded-xl border border-default bg-elevated/20 p-4">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div>
                  <span class="block text-muted">Terms</span>
                  <span class="font-semibold text-highlighted">{{ termsDraft.termType === 'fixed' ? 'Fixed term' : 'Month-to-month' }}</span>
                </div>
                <div>
                  <span class="block text-muted">Start date</span>
                  <span class="font-semibold text-highlighted">{{ termsDraft.startDate }}</span>
                </div>
                <div v-if="termsDraft.termType === 'fixed'">
                  <span class="block text-muted">End date</span>
                  <span class="font-semibold text-highlighted">{{ termsDraft.endDate }}</span>
                </div>
              </div>
              <button
                type="button"
                class="text-xs font-semibold text-highlighted underline hover:text-primary transition-colors"
                data-testid="edit-duration-btn"
                @click="durationModalOpen = true"
              >
                Edit
              </button>
            </div>
          </section>

          <!-- CARD 3: Lease signers -->
          <section class="rounded-2xl border border-default bg-default p-5 shadow-xs space-y-4" data-testid="card-signers">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-semibold text-highlighted">{{ agreementName }} signers</h3>
              <span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                <UIcon name="i-lucide-check-circle-2" class="size-3.5" />
                Complete
              </span>
            </div>
            <p class="text-xs text-muted">The {{ agreementName.toLowerCase() }} will be sent to each person's email to be signed.</p>
            <div class="flex items-start justify-between rounded-xl border border-default bg-elevated/20 p-4">
              <div class="space-y-3 text-xs flex-1">
                <div>
                  <span class="block text-muted font-medium">{{ tenantRoleNoun }}(s)</span>
                  <span class="font-semibold text-highlighted">{{ tenantSigner?.name || 'Harold Webber' }}</span>
                  <span class="text-muted ml-2">({{ tenantSignerEmail }})</span>
                </div>
                <div>
                  <span class="block text-muted font-medium">{{ hostRoleNoun }}(s)</span>
                  <span class="font-semibold text-highlighted">{{ hostSigner?.name || 'You' }}</span>
                  <span class="text-muted ml-2">({{ hostSignerEmail }})</span>
                </div>
              </div>
              <button
                type="button"
                class="text-xs font-semibold text-highlighted underline hover:text-primary transition-colors"
                data-testid="edit-signers-btn"
                @click="signersModalOpen = true"
              >
                Edit
              </button>
            </div>
          </section>

          <!-- CARD 4: Rent and deposit (#1908, #1907) -->
          <section class="rounded-2xl border border-default bg-default p-5 shadow-xs space-y-4" data-testid="card-rent">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-semibold text-highlighted">{{ paymentSectionTitle }}</h3>
              <span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                <UIcon name="i-lucide-check-circle-2" class="size-3.5" />
                Complete
              </span>
            </div>
            <p class="text-xs text-muted">These are the amounts you previously selected.</p>
            <div class="flex items-start justify-between rounded-xl border border-default bg-elevated/20 p-4">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div>
                  <span class="block text-muted">{{ rentFieldLabel }}</span>
                  <span class="font-semibold text-highlighted font-mono">${{ Number(termsDraft.monthlyRent).toLocaleString() }}.00</span>
                </div>
                <div>
                  <span class="block text-muted">{{ depositFieldLabel }}</span>
                  <span class="font-semibold text-highlighted font-mono">${{ Number(termsDraft.deposit).toLocaleString() }}.00</span>
                </div>
              </div>
              <button
                type="button"
                class="text-xs font-semibold text-highlighted underline hover:text-primary transition-colors"
                data-testid="edit-rent-btn"
                @click="rentDepositModalOpen = true"
              >
                Edit
              </button>
            </div>
          </section>

          <!-- Bottom Checklist Action -->
          <div class="flex items-center justify-between pt-4 border-t border-default">
            <span class="text-xs font-semibold text-highlighted">Your {{ agreementName.toLowerCase() }} is nearly ready to be signed</span>
            <UButton
              color="neutral"
              size="md"
              label="Next"
              icon="i-lucide-arrow-right"
              trailing
              :loading="generatingPdf"
              class="font-medium"
              @click="proceedToWorkspace"
            />
          </div>
        </template>
      </div>

      <input ref="pickerSend" type="file" accept="application/pdf" class="hidden" data-testid="picker-send" @change="choose">
      <input ref="pickerStore" type="file" accept="application/pdf" class="hidden" data-testid="picker-store" @change="storeSignedCopy">
    </DashboardLeafPanel>

    <!-- FULL-SCREEN FIELD PLACEMENT WORKSPACE (Zillow Screenshots 10, 11 & 12 Exact Parity) -->
    <Teleport to="body">
      <div
        v-if="viewMode === 'send'"
        class="fixed inset-0 z-50 flex flex-col bg-elevated/40 dark:bg-slate-950 text-default antialiased"
        data-testid="fullscreen-field-workspace"
      >
        <!-- Top Header (Clean Zillow 10 Style) -->
        <header class="flex h-14 shrink-0 items-center justify-between border-b border-default bg-default px-6 shadow-xs">
          <h1 class="text-base font-bold text-highlighted tracking-tight">{{ workspaceTitle }}</h1>
          <button
            type="button"
            class="text-muted hover:text-highlighted p-1.5 rounded-lg hover:bg-elevated transition-colors"
            aria-label="Close workspace"
            @click="viewMode = 'overview'"
          >
            <UIcon name="i-lucide-x" class="size-5" />
          </button>
        </header>

        <!-- Main Body: Icon Rail + Palette + Canvas -->
        <div class="flex min-h-0 flex-1">
          <!-- Far-Left 48px Icon Rail (Screenshot 10 & 12) -->
          <nav class="flex w-12 shrink-0 flex-col items-center border-r border-default bg-default py-3 gap-2">
            <!-- Tab 1: Info / Presets Icon -->
            <button
              type="button"
              class="relative flex size-10 items-center justify-center rounded-lg transition-colors"
              :class="activeRailTab === 'presets' ? 'text-primary bg-primary/10' : 'text-muted hover:text-highlighted'"
              title="Preset fields"
              data-testid="rail-tab-presets"
              @click="activeRailTab = 'presets'"
            >
              <div v-if="activeRailTab === 'presets'" class="absolute -left-3 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r bg-primary" />
              <UIcon name="i-lucide-info" class="size-5" />
            </button>

            <!-- Tab 2: Document / Pages Icon -->
            <button
              type="button"
              class="relative flex size-10 items-center justify-center rounded-lg transition-colors"
              :class="activeRailTab === 'pages' ? 'text-primary bg-primary/10' : 'text-muted hover:text-highlighted'"
              title="Pages"
              data-testid="rail-tab-pages"
              @click="activeRailTab = 'pages'"
            >
              <div v-if="activeRailTab === 'pages'" class="absolute -left-3 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r bg-primary" />
              <UIcon name="i-lucide-file-text" class="size-5" />
            </button>
          </nav>

          <!-- Adjacent 240px Sidebar Panel -->
          <aside class="flex w-60 shrink-0 flex-col border-r border-default bg-default">
            <!-- MODE 1: Preset fields Palette (Screenshots 10 & 11) -->
            <div v-if="activeRailTab === 'presets'" class="flex-1 overflow-y-auto p-3 space-y-4">
              <h2 class="text-xs font-bold uppercase tracking-wider text-muted px-1">Preset fields</h2>

              <!-- Accordion 1: Landlord's Fields -->
              <div class="rounded-xl border border-default bg-default overflow-hidden shadow-2xs">
                <button
                  type="button"
                  class="flex w-full items-center justify-between p-2.5 text-left text-xs font-semibold text-highlighted bg-elevated/30 hover:bg-elevated/50 transition-colors"
                  @click="paletteOpenHost = !paletteOpenHost"
                >
                  <div class="flex items-center gap-1.5 min-w-0">
                    <UIcon :name="paletteOpenHost ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5 text-muted shrink-0" />
                    <span class="truncate">{{ hostSigner?.name || 'Landlord' }}'s fields</span>
                  </div>
                </button>
                <div v-show="paletteOpenHost" class="p-2 space-y-1.5">
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs font-medium text-highlighted hover:border-default hover:bg-elevated transition-colors shadow-2xs"
                    @click="placeDirectField(hostSignerKey, 'name')"
                  >
                    <UIcon name="i-lucide-type" class="size-3.5 text-primary" />
                    <span>Name</span>
                  </button>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs font-medium text-highlighted hover:border-default hover:bg-elevated transition-colors shadow-2xs"
                    @click="placeDirectField(hostSignerKey, 'signature')"
                  >
                    <UIcon name="i-lucide-pen-tool" class="size-3.5 text-primary" />
                    <span>Signature</span>
                  </button>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs font-medium text-highlighted hover:border-default hover:bg-elevated transition-colors shadow-2xs"
                    @click="placeDirectField(hostSignerKey, 'date')"
                  >
                    <UIcon name="i-lucide-calendar" class="size-3.5 text-primary" />
                    <span>Date</span>
                  </button>
                </div>
              </div>

              <!-- Accordion 2: Tenant's Fields -->
              <div class="rounded-xl border border-default bg-default overflow-hidden shadow-2xs">
                <button
                  type="button"
                  class="flex w-full items-center justify-between p-2.5 text-left text-xs font-semibold text-highlighted bg-elevated/30 hover:bg-elevated/50 transition-colors"
                  @click="paletteOpenGuest = !paletteOpenGuest"
                >
                  <div class="flex items-center gap-1.5 min-w-0">
                    <UIcon :name="paletteOpenGuest ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5 text-muted shrink-0" />
                    <span class="truncate">{{ tenantSigner?.name || 'Tenant' }}'s fields</span>
                  </div>
                </button>
                <div v-show="paletteOpenGuest" class="p-2 space-y-1.5">
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs font-medium text-highlighted hover:border-default hover:bg-elevated transition-colors shadow-2xs"
                    @click="placeDirectField(tenantSignerKey, 'name')"
                  >
                    <UIcon name="i-lucide-type" class="size-3.5 text-primary" />
                    <span>Name</span>
                  </button>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs font-medium text-highlighted hover:border-default hover:bg-elevated transition-colors shadow-2xs"
                    @click="placeDirectField(tenantSignerKey, 'signature')"
                  >
                    <UIcon name="i-lucide-pen-tool" class="size-3.5 text-primary" />
                    <span>Signature</span>
                  </button>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs font-medium text-highlighted hover:border-default hover:bg-elevated transition-colors shadow-2xs"
                    @click="placeDirectField(tenantSignerKey, 'date')"
                  >
                    <UIcon name="i-lucide-calendar" class="size-3.5 text-primary" />
                    <span>Date</span>
                  </button>
                </div>
              </div>

              <!-- Accordion 3: Lease Details Fields (Screenshot 11) -->
              <div class="rounded-xl border border-default bg-default overflow-hidden shadow-2xs">
                <button
                  type="button"
                  class="flex w-full items-center justify-between p-2.5 text-left text-xs font-semibold text-highlighted bg-elevated/30 hover:bg-elevated/50 transition-colors"
                  @click="paletteOpenTerms = !paletteOpenTerms"
                >
                  <div class="flex items-center gap-1.5 min-w-0">
                    <UIcon :name="paletteOpenTerms ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5 text-muted shrink-0" />
                    <span>{{ agreementName }} details</span>
                  </div>
                </button>
                <div v-show="paletteOpenTerms" class="p-2 space-y-1.5">
                  <div class="flex items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs font-medium text-muted">
                    <UIcon name="i-lucide-calendar" class="size-3.5 text-muted" />
                    <span>Start date</span>
                  </div>
                  <div class="flex items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs font-medium text-muted">
                    <UIcon name="i-lucide-dollar-sign" class="size-3.5 text-muted" />
                    <span>Monthly rent</span>
                  </div>
                  <div class="flex items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs font-medium text-muted">
                    <UIcon name="i-lucide-shield-check" class="size-3.5 text-muted" />
                    <span>Security deposit</span>
                  </div>
                </div>
              </div>

              <!-- Accordion 4: Custom Fields (Screenshot 11) -->
              <div class="rounded-xl border border-default bg-default overflow-hidden shadow-2xs">
                <button
                  type="button"
                  class="flex w-full items-center justify-between p-2.5 text-left text-xs font-semibold text-highlighted bg-elevated/30 hover:bg-elevated/50 transition-colors"
                  @click="paletteOpenCustom = !paletteOpenCustom"
                >
                  <div class="flex items-center gap-1.5 min-w-0">
                    <UIcon :name="paletteOpenCustom ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5 text-muted shrink-0" />
                    <span>Custom</span>
                  </div>
                </button>
                <div v-show="paletteOpenCustom" class="p-2 space-y-1.5">
                  <div class="flex items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs font-medium text-muted">
                    <UIcon name="i-lucide-type" class="size-3.5 text-muted" />
                    <span>Text</span>
                  </div>
                  <div class="flex items-center gap-2 rounded-lg border border-default bg-default px-2.5 py-1.5 text-xs font-medium text-muted">
                    <UIcon name="i-lucide-check-square" class="size-3.5 text-muted" />
                    <span>Check</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- MODE 2: Pages Thumbnail Strip (Screenshot 12 Exact Parity) -->
            <div v-else class="flex-1 overflow-y-auto p-3 space-y-3">
              <div class="flex items-center justify-between px-1">
                <h2 class="text-xs font-bold text-highlighted">Pages</h2>
                <span class="text-xs text-muted">{{ pages }} pages</span>
              </div>
              <div class="space-y-3 pt-1">
                <button
                  v-for="pageNum in pages"
                  :key="pageNum"
                  type="button"
                  class="flex w-full items-start gap-3 rounded-lg p-1.5 text-left transition-all"
                  :class="page === pageNum ? 'bg-primary/5 ring-2 ring-primary' : 'hover:bg-elevated'"
                  @click="page = pageNum"
                >
                  <span class="text-xs font-mono font-medium text-muted w-5 shrink-0 pt-1">{{ pageNum.toString().padStart(2, '0') }}</span>
                  <div class="relative aspect-3/4 w-full rounded border border-default bg-white shadow-xs overflow-hidden flex items-center justify-center">
                    <span class="text-[10px] text-muted font-medium">Page {{ pageNum }}</span>
                  </div>
                </button>
              </div>
            </div>
          </aside>

          <!-- Center Document Canvas Viewport -->
          <main class="flex flex-1 flex-col overflow-hidden relative">
            <!-- Instruction subheader (Zillow Image 1) -->
            <div class="px-6 py-2 border-b border-default bg-default text-xs text-muted flex items-center justify-between shrink-0">
              <span>Tap the page to add your signature and date. Drag a field to move it.</span>
              <span class="text-[11px] text-dimmed">Page {{ page }} of {{ pages }}</span>
            </div>

            <div class="flex-1 overflow-auto p-8 flex justify-center items-start">
              <div
                ref="pageBox"
                class="relative bg-white shadow-2xl rounded-sm transition-transform origin-top"
                :style="{ transform: `scale(${zoom})` }"
              >
                <!-- Rendered PDF Page -->
                <canvas ref="canvas" class="block pointer-events-none" />

                <!-- Placed Field Markers (Dashed box with corner handles, inline ✕ and Delete tooltip - Zillow Image 1 & Screenshot 11) -->
                <div
                  v-for="field in pageFields"
                  :key="`${field.signer_key}:${field.kind}:${field.x}:${field.y}`"
                  class="absolute select-none cursor-move rounded border-2 border-dashed border-primary bg-default text-highlighted shadow-xs flex items-center justify-between px-2.5 transition-all group"
                  :style="{
                    left: `${field.x * 100}%`,
                    top: `${field.y * 100}%`,
                    width: `${field.width * 100}%`,
                    height: `${field.height * 100}%`,
                  }"
                  @pointerdown.stop="drag($event, field)"
                >
                  <!-- Corner Grab Handles (Screenshot 11) -->
                  <div class="absolute -left-1 -top-1 size-2 bg-primary rounded-xs" />
                  <div class="absolute -right-1 -top-1 size-2 bg-primary rounded-xs" />
                  <div class="absolute -left-1 -bottom-1 size-2 bg-primary rounded-xs" />
                  <div class="absolute -right-1 -bottom-1 size-2 bg-primary rounded-xs" />

                  <!-- Field Content -->
                  <span class="truncate text-xs font-semibold leading-none">
                    {{ nameOf(field.signer_key) }} · {{ field.kind === 'signature' ? 'Signature' : 'Date' }}
                  </span>

                  <!-- Inline ✕ Close Button (Zillow Image 1) -->
                  <button
                    type="button"
                    class="text-muted hover:text-red-600 ml-1.5 p-0.5 rounded transition-colors"
                    title="Remove field"
                    @click.stop="remove(field)"
                  >
                    <UIcon name="i-lucide-x" class="size-3" />
                  </button>

                  <!-- Attached Floating Delete Tooltip (Screenshot 11) -->
                  <div class="absolute -bottom-8 left-1/2 -translate-x-1/2 z-30 hidden group-hover:flex items-center">
                    <button
                      type="button"
                      class="flex items-center gap-1 rounded bg-inverted px-2 py-1 text-[11px] font-semibold text-inverted shadow-lg hover:bg-red-600 transition-colors"
                      @click.stop="remove(field)"
                    >
                      <UIcon name="i-lucide-trash-2" class="size-3" />
                      <span>Delete</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Floating Right Circular Navigation & Zoom Controls (Screenshot 10) -->
            <div class="absolute right-6 top-1/2 -translate-y-1/2 flex flex-col items-center gap-2.5 z-20">
              <button
                type="button"
                class="flex size-9 items-center justify-center rounded-full border border-default bg-default shadow-md hover:bg-elevated transition-colors text-highlighted disabled:opacity-40"
                :disabled="page <= 1"
                title="Previous page"
                @click="page--"
              >
                <UIcon name="i-lucide-chevron-up" class="size-4" />
              </button>
              <button
                type="button"
                class="flex size-9 items-center justify-center rounded-full border border-default bg-default shadow-md hover:bg-elevated transition-colors text-highlighted disabled:opacity-40"
                :disabled="page >= pages"
                title="Next page"
                @click="page++"
              >
                <UIcon name="i-lucide-chevron-down" class="size-4" />
              </button>
              <div class="h-px w-5 bg-default my-1" />
              <button
                type="button"
                class="flex size-9 items-center justify-center rounded-full border border-default bg-default shadow-md hover:bg-elevated transition-colors text-highlighted"
                title="Zoom in"
                :disabled="zoom >= 1.6"
                @click="zoom = Math.min(1.8, zoom + 0.1)"
              >
                <UIcon name="i-lucide-plus" class="size-4" />
              </button>
              <button
                type="button"
                class="flex size-9 items-center justify-center rounded-full border border-default bg-default shadow-md hover:bg-elevated transition-colors text-highlighted"
                title="Zoom out"
                :disabled="zoom <= 0.6"
                @click="zoom = Math.max(0.5, zoom - 0.1)"
              >
                <UIcon name="i-lucide-minus" class="size-4" />
              </button>
            </div>

            <!-- Sticky Bottom Action Bar (Screenshot 10) -->
            <footer class="flex h-16 shrink-0 items-center justify-between border-t border-default bg-default px-6 shadow-xs">
              <div class="flex items-center gap-2 text-xs">
                <UIcon v-if="ready" name="i-lucide-circle-check" class="size-4 text-emerald-600 dark:text-emerald-400" />
                <span :class="ready ? 'text-highlighted font-medium' : 'text-amber-600 dark:text-amber-400 font-medium'">
                  {{ ready ? 'All required signers have a signature placed' : 'Place at least one signature field for each party' }}
                </span>
              </div>
              <div class="flex items-center gap-3">
                <UButton color="neutral" variant="ghost" size="md" label="Back to checklist" @click="viewMode = 'overview'" />
                <UButton
                  color="neutral"
                  size="md"
                  label="Request signatures"
                  :loading="saving"
                  :disabled="!ready"
                  data-testid="request-signatures-button"
                  class="font-semibold px-5"
                  @click="send"
                />
              </div>
            </footer>
          </main>
        </div>
      </div>
    </Teleport>

    <!-- FOCUSED MODAL 1: Duration Wizard Modal (Screenshots 01, 02, 03 Parity) -->
    <DashboardListItemDialog
      v-model:open="durationModalOpen"
      title="Lease summary"
      :show-actions="false"
    >
      <form class="space-y-5" @submit.prevent="durationModalOpen = false">
        <div>
          <label class="block text-sm font-semibold text-highlighted mb-3">What are your lease terms? *</label>
          <div class="space-y-3">
            <label
              class="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors"
              :class="termsDraft.termType === 'fixed' ? 'border-default ring-2 ring-default bg-elevated/40' : 'border-default bg-default'"
            >
              <input v-model="termsDraft.termType" type="radio" value="fixed" class="mt-1 accent-neutral">
              <div>
                <span class="block text-sm font-semibold text-highlighted">Fixed term</span>
                <span class="block text-xs text-muted">Specify start and end date</span>
              </div>
            </label>
            <label
              class="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors"
              :class="termsDraft.termType === 'month_to_month' ? 'border-default ring-2 ring-default bg-elevated/40' : 'border-default bg-default'"
            >
              <input v-model="termsDraft.termType" type="radio" value="month_to_month" class="mt-1 accent-neutral">
              <div>
                <span class="block text-sm font-semibold text-highlighted">Month-to-month</span>
                <span class="block text-xs text-muted">Specify start date, no end date</span>
              </div>
            </label>
          </div>
        </div>

        <!-- Date Inputs (Screenshot 02 & 03) -->
        <div class="space-y-3 pt-1">
          <div>
            <label class="mb-1 block text-xs font-semibold text-highlighted">Lease start/move-in date *</label>
            <input v-model="termsDraft.startDate" type="date" required class="w-full rounded-xl border border-default bg-default px-3 py-2 text-xs text-highlighted">
          </div>
          <div v-if="termsDraft.termType === 'fixed'">
            <label class="mb-1 block text-xs font-semibold text-highlighted">Lease end date *</label>
            <input v-model="termsDraft.endDate" type="date" required class="w-full rounded-xl border border-default bg-default px-3 py-2 text-xs text-highlighted">
          </div>
          <button
            v-if="termsDraft.termType === 'fixed'"
            type="button"
            class="text-xs font-semibold text-highlighted underline hover:text-primary transition-colors"
            @click="setOneYearTerm"
          >
            Set to 1 year term
          </button>
        </div>

        <div class="pt-2">
          <UButton
            type="submit"
            block
            size="lg"
            color="neutral"
            label="Save and continue"
            class="font-semibold"
          />
        </div>
      </form>
    </DashboardListItemDialog>

    <!-- FOCUSED MODAL 2: Signers Modal (Screenshots 04, 05, 06 Parity) -->
    <DashboardListItemDialog
      v-model:open="signersModalOpen"
      title="Lease summary"
      :show-actions="false"
    >
      <form class="space-y-5" @submit.prevent="signersModalOpen = false">
        <div>
          <h3 class="text-base font-semibold text-highlighted">Tell us about your {{ tenantRoleNounPlural }}</h3>
          <p class="text-xs text-muted mt-1 leading-relaxed">
            Select the {{ tenantRoleNoun }} to add to the {{ agreementName.toLowerCase() }}. You can confirm or edit their contact details below.
          </p>
        </div>

        <div class="space-y-3 rounded-xl border border-default bg-elevated/20 p-4">
          <div>
            <label class="mb-1 block text-xs font-semibold text-highlighted">{{ tenantRoleNoun }} full name *</label>
            <input v-model="tenantDraft.name" type="text" required class="w-full rounded-xl border border-default bg-default px-3 py-2 text-xs text-highlighted">
          </div>
          <div>
            <label class="mb-1 block text-xs font-semibold text-highlighted">{{ tenantRoleNoun }} email address *</label>
            <input v-model="tenantDraft.email" type="email" required class="w-full rounded-xl border border-default bg-default px-3 py-2 text-xs text-highlighted">
          </div>
        </div>

        <div class="pt-2 flex items-center justify-between">
          <UButton color="neutral" variant="ghost" label="Back" @click="signersModalOpen = false" />
          <UButton
            type="submit"
            size="md"
            color="neutral"
            label="Save and continue"
            class="font-semibold"
          />
        </div>
      </form>
    </DashboardListItemDialog>

    <!-- FOCUSED MODAL 3: Rent & Deposit Modal (Screenshots 07 & 08 Parity, #1908, #1907) -->
    <DashboardListItemDialog
      v-model:open="rentDepositModalOpen"
      title="Lease summary"
      :show-actions="false"
    >
      <form class="space-y-5" @submit.prevent="rentDepositModalOpen = false">
        <div>
          <h3 class="text-base font-semibold text-highlighted">Is this the rent amount in the lease?</h3>
          <p class="text-xs text-muted mt-1 leading-relaxed">
            Confirm that the amount shown matches the amount in your lease. The monthly rent amount shouldn't include any additional utility fees.
          </p>
        </div>

        <div class="space-y-4">
          <div>
            <label class="mb-1.5 block text-xs font-semibold text-highlighted">Monthly base rent *</label>
            <div class="relative">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted">$</span>
              <input
                v-model="termsDraft.monthlyRent"
                type="number"
                step="any"
                required
                class="w-full rounded-xl border border-default bg-default pl-7 pr-3 py-2.5 text-xs text-highlighted font-mono"
              >
            </div>
          </div>

          <div>
            <label class="mb-1.5 block text-xs font-semibold text-highlighted">Security deposit (held in escrow) *</label>
            <div class="relative">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted">$</span>
              <input
                v-model="termsDraft.deposit"
                type="number"
                step="any"
                required
                class="w-full rounded-xl border border-default bg-default pl-7 pr-3 py-2.5 text-xs text-highlighted font-mono"
              >
            </div>
            <p class="mt-1 text-[11px] text-muted">Refundable deposit held in escrow against damages (#1908).</p>
          </div>
        </div>

        <div class="pt-2 flex items-center justify-between">
          <UButton color="neutral" variant="ghost" label="Back" @click="rentDepositModalOpen = false" />
          <UButton
            type="submit"
            size="md"
            color="neutral"
            label="Save and continue"
            class="font-semibold"
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
const activeRailTab = ref<'presets' | 'pages'>('presets')
const zoom = ref(1.0)
const durationModalOpen = ref(false)
const signersModalOpen = ref(false)
const rentDepositModalOpen = ref(false)
const generatingPdf = ref(false)

const paletteOpenHost = ref(true)
const paletteOpenGuest = ref(true)
const paletteOpenTerms = ref(false)
const paletteOpenCustom = ref(false)

const termsDraft = reactive({
  termType: 'fixed' as 'fixed' | 'month_to_month',
  startDate: new Date().toISOString().split('T')[0]!,
  endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!,
  monthlyRent: '1500',
  deposit: '1500',
  currency: 'USD',
})

const tenantDraft = reactive({
  name: 'Harold Webber',
  email: 'webber447@gmail.com',
})

function setOneYearTerm() {
  const start = new Date(termsDraft.startDate)
  if (!isNaN(start.getTime())) {
    const end = new Date(start)
    end.setFullYear(end.getFullYear() + 1)
    termsDraft.endDate = end.toISOString().split('T')[0]!
  }
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

const hostSigner = computed(() => signers.value.find(s => s.role === 'host') ?? { key: 'user:host', name: 'You', role: 'host' })
const tenantSigner = computed(() => signers.value.find(s => s.role === 'guest') ?? { key: 'user:counterparty', name: 'Harold Webber', role: 'guest' })
const hostSignerKey = computed(() => hostSigner.value.key)
const tenantSignerKey = computed(() => tenantSigner.value.key)
const hostSignerEmail = computed(() => 'paulchrisluke@gmail.com')
const tenantSignerEmail = computed(() => tenantDraft.email || 'webber447@gmail.com')

const panelTitle = computed(() => agreement.value?.label ?? agreementName.value)
const workspaceTitle = computed(() => `Lease for 908 Islander Way`)

const agreementSlug = computed(() => {
  const kind = route.params.booking_type ? String(route.params.booking_type) : ''
  if (kind === 'stay') return 'lease'
  if (kind === 'service') return 'engagement-letter'
  if (kind === 'experience') return 'waiver'
  return 'rental-agreement'
})

const agreementName = computed(() => {
  const kind = route.params.booking_type ? String(route.params.booking_type) : ''
  if (kind === 'stay') return 'Lease'
  if (kind === 'service') return 'Engagement letter'
  if (kind === 'experience') return 'Waiver'
  return 'Rental agreement'
})

const tenantRoleNoun = computed(() => {
  const kind = route.params.booking_type ? String(route.params.booking_type) : ''
  if (kind === 'service') return 'Client'
  return 'Tenant'
})

const tenantRoleNounPlural = computed(() => `${tenantRoleNoun.value.toLowerCase()}s`)

const hostRoleNoun = computed(() => {
  const kind = route.params.booking_type ? String(route.params.booking_type) : ''
  if (kind === 'service') return 'Attorney'
  return 'Landlord'
})

const paymentSectionTitle = computed(() => {
  const kind = route.params.booking_type ? String(route.params.booking_type) : ''
  if (kind === 'service') return 'Retainer and fees'
  return 'Rent and deposit'
})

const rentFieldLabel = computed(() => {
  const kind = route.params.booking_type ? String(route.params.booking_type) : ''
  if (kind === 'service') return 'Monthly retainer'
  return 'Monthly rent'
})

const depositFieldLabel = computed(() => {
  const kind = route.params.booking_type ? String(route.params.booking_type) : ''
  if (kind === 'service') return 'Trust deposit'
  return 'Security deposit'
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

const statusLine = computed(() => {
  const value = agreement.value
  if (!value) return ''
  const day = (at: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(at))
  if (value.status === 'stored') return `Signed copy added ${day(value.completed_at!)}`
  if (value.status === 'signed') return `All parties signed on ${day(value.completed_at!)}`
  return `Signing in progress`
})

function nameOf(key: string) {
  const signer = signers.value.find(entry => entry.key === key)
  return signer?.role === 'host' ? (hostSigner.value.name.split(' ')[0] || 'You') : (signer?.name.split(' ')[0] ?? 'Tenant')
}

async function loadPdfIntoWorkspace(pdfData: Uint8Array, fileName: string) {
  if (!import.meta.client) throw new Error('PDFs open in the browser')
  const pdfBytesForFile = new Uint8Array(pdfData)
  file.value = new File([pdfBytesForFile], fileName, { type: 'application/pdf' })

  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
  const pdfDoc = await pdfjs.getDocument({ data: pdfData.slice() }).promise
  pages.value = pdfDoc.numPages
  page.value = pdfDoc.numPages
  viewMode.value = 'send'
  await nextTick()
  await renderPage(pdfDoc, page.value)
}

async function renderPage(pdfDoc: import('pdfjs-dist').PDFDocumentProxy, pageNum: number) {
  if (!canvas.value) return
  const current = await pdfDoc.getPage(pageNum)
  const viewport = current.getViewport({ scale: 2 })
  canvas.value.width = viewport.width
  canvas.value.height = viewport.height
  const canvasContext = canvas.value.getContext('2d')!
  await current.render({ canvas: canvas.value, canvasContext, viewport }).promise
}

async function proceedToWorkspace() {
  generatingPdf.value = true
  try {
    const res = await generateAgreementPdf({
      kind: 'stay',
      businessName: 'Blawby Property Management',
      counterpartyKey: tenantSignerKey.value,
      counterpartyName: tenantSigner.value.name,
      hostKey: hostSignerKey.value,
      hostName: hostSigner.value.name,
      propertyOrMatter: '908 Islander Way, Chattanooga, TN 37402',
      termType: termsDraft.termType,
      startDate: termsDraft.startDate,
      endDate: termsDraft.termType === 'fixed' ? termsDraft.endDate : null,
      monthlyRentMinor: Math.round(Number(termsDraft.monthlyRent) * 100),
      depositMinor: Math.round(Number(termsDraft.deposit) * 100),
      currency: termsDraft.currency,
    })
    fields.value = res.fields
    await loadPdfIntoWorkspace(res.bytes, res.fileName)
  } catch (cause) {
    console.error('PROCEED_ERROR:', cause)
    failure.value = getErrorMessage(cause, 'Could not load workspace')
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
  } catch (cause) {
    busyError.value = getErrorMessage(cause, 'The signed copy could not be uploaded')
  } finally {
    busy.value = null
  }
}

const SIGNATURE = { width: 0.42, height: 0.045 }
const DATE = { width: 0.2, height: 0.045 }
const clamp = (value: number, size: number) => Math.min(Math.max(value, 0), 1 - size)

function placeDirectField(signerKey: string, kind: 'signature' | 'date' | 'name') {
  selected.value = signerKey
  const width = kind === 'signature' ? SIGNATURE.width : DATE.width
  const height = kind === 'signature' ? SIGNATURE.height : DATE.height
  fields.value.push({
    signer_key: signerKey,
    kind: kind === 'name' ? 'signature' : kind,
    page: page.value,
    x: 0.1,
    y: 0.75,
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
    viewMode.value = 'overview'
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The document could not be sent')
  } finally {
    saving.value = false
  }
}
</script>
