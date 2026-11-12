<template>
  <DashboardLeafPanel
    id="organization-website-booking"
    :title="panelTitle"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <!-- Booking Mode Selection Cards (Airbnb Parity) -->
    <div class="space-y-4" role="radiogroup" :aria-label="panelTitle">
      <!-- Option 1: Instant / Online requests -->
      <button
        type="button"
        role="radio"
        :aria-checked="isInstantActive"
        data-testid="booking-mode-instant"
        class="w-full text-left rounded-2xl p-5 border-2 transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted"
        :class="isInstantActive
          ? 'border-highlighted bg-elevated shadow-sm ring-1 ring-highlighted/10'
          : 'border-default bg-default hover:border-accented'"
        @click="setBookingMode(true)"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-1">
            <h3 class="font-semibold text-highlighted text-base">
              {{ instantTitle }}
            </h3>
            <p class="text-sm text-muted">
              {{ instantDescription }}
            </p>
          </div>
          <div
            class="size-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5"
            :class="isInstantActive ? 'border-highlighted' : 'border-default'"
          >
            <div v-if="isInstantActive" class="size-2.5 rounded-full bg-highlighted" />
          </div>
        </div>

        <div v-if="instantHighlight" class="mt-4 flex items-center gap-2 rounded-xl bg-accented px-3.5 py-2.5 text-xs text-muted">
          <UIcon name="i-lucide-trending-up" class="size-4 shrink-0 text-highlighted" />
          <span>{{ instantHighlight }}</span>
        </div>
      </button>

      <!-- Option 2: Manual review / inquiries only -->
      <button
        type="button"
        role="radio"
        :aria-checked="!isInstantActive"
        data-testid="booking-mode-manual"
        class="w-full text-left rounded-2xl p-5 border-2 transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlighted"
        :class="!isInstantActive
          ? 'border-highlighted bg-elevated shadow-sm ring-1 ring-highlighted/10'
          : 'border-default bg-default hover:border-accented'"
        @click="setBookingMode(false)"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-1">
            <h3 class="font-semibold text-highlighted text-base">
              {{ manualTitle }}
            </h3>
            <p class="text-sm text-muted">
              {{ manualDescription }}
            </p>
          </div>
          <div
            class="size-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5"
            :class="!isInstantActive ? 'border-highlighted' : 'border-default'"
          >
            <div v-if="!isInstantActive" class="size-2.5 rounded-full bg-highlighted" />
          </div>
        </div>
      </button>
    </div>

    <!-- Chevron Row: Intake Questions -->
    <div class="mt-8 border-t border-default pt-6">
      <NuxtLink
        :to="questionsPath"
        class="flex items-center justify-between p-4 rounded-2xl bg-default border border-default hover:bg-elevated transition group"
        data-testid="booking-intake-questions-link"
      >
        <div class="space-y-0.5">
          <div class="font-semibold text-sm sm:text-base text-highlighted transition">
            Intake questions
          </div>
          <div class="text-xs sm:text-sm text-muted">
            {{ questionsSummary }}
          </div>
        </div>
        <UIcon name="i-lucide-chevron-right" class="size-5 text-muted group-hover:text-highlighted group-hover:translate-x-0.5 transition" />
      </NuxtLink>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'
import { formQuestionsSummary } from '~/utils/form-question-editing'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
const route = useRoute()

const vertical = computed(() => editor.vertical.value)
const isService = computed(() => vertical.value === 'service')

const panelTitle = computed(() => {
  if (isService.value) return 'Consultation settings'
  if (vertical.value === 'restaurant') return 'Reservation settings'
  return 'Booking settings'
})

const isInstantActive = computed(() => {
  if (isService.value) return editor.form.native_consultations
  return true
})

function setBookingMode(instant: boolean) {
  if (isService.value) {
    editor.form.native_consultations = instant
  }
}

const instantTitle = computed(() => {
  if (isService.value) return 'Accept consultation requests online'
  return 'Instant Book'
})

const instantDescription = computed(() => {
  if (isService.value) {
    return 'Clients can select a practice area and submit consultation requests with intake details online.'
  }
  return 'All bookings are automatically approved upon submission.'
})

const instantHighlight = computed(() => {
  if (isService.value) {
    return 'Practices accepting online requests receive significantly more retained client inquiries.'
  }
  return 'On average, listings using Instant Book appear higher in search results and get more bookings.'
})

const manualTitle = computed(() => {
  if (isService.value) return 'Inquiries only (offline scheduling)'
  return 'Review requests manually'
})

const manualDescription = computed(() => {
  if (isService.value) {
    return 'Clients contact your office directly via phone or email to schedule consultations.'
  }
  return 'Requests require staff review and manual confirmation before scheduling.'
})

const questionsPath = computed(() => `/dashboard/${route.params.org_slug}/website/inquiry-form`)

const questionsSummary = computed(() => {
  const list = editor.inquiryQuestions.value
  if (!list || list.length === 0) return 'No custom questions · Contact fields only'
  return formQuestionsSummary(list)
})
</script>
