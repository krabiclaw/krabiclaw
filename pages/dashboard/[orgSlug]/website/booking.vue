<template>
  <DashboardLeafPanel
    id="organization-website-booking"
    :title="panelTitle"
    :lead="panelLead"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <!-- Booking Mode Selection Cards (Airbnb Parity) -->
    <div class="space-y-4">
      <!-- Option 1: Instant / Online requests -->
      <div
        class="rounded-2xl p-5 border-2 transition cursor-pointer select-none"
        :class="isInstantActive ? 'border-primary bg-primary/5 dark:bg-primary/10' : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:border-neutral-300 dark:hover:border-neutral-700'"
        tabindex="0"
        role="radio"
        :aria-checked="isInstantActive"
        data-testid="booking-mode-instant"
        @click="setBookingMode(true)"
        @keydown.space.prevent="setBookingMode(true)"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-1">
            <h3 class="font-bold text-highlighted text-base">
              {{ instantTitle }}
            </h3>
            <p class="text-sm text-muted">
              {{ instantDescription }}
            </p>
          </div>
          <div
            class="size-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5"
            :class="isInstantActive ? 'border-primary' : 'border-neutral-300 dark:border-neutral-700'"
          >
            <div v-if="isInstantActive" class="size-2.5 rounded-full bg-primary" />
          </div>
        </div>

        <div v-if="instantHighlight" class="mt-4 flex items-center gap-2 rounded-xl bg-neutral-100 dark:bg-neutral-800/60 px-3.5 py-2.5 text-xs text-muted">
          <UIcon name="i-lucide-trending-up" class="size-4 shrink-0 text-highlighted" />
          <span>{{ instantHighlight }}</span>
        </div>
      </div>

      <!-- Option 2: Manual review / inquiries only -->
      <div
        class="rounded-2xl p-5 border-2 transition cursor-pointer select-none"
        :class="!isInstantActive ? 'border-primary bg-primary/5 dark:bg-primary/10' : 'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:border-neutral-300 dark:hover:border-neutral-700'"
        tabindex="0"
        role="radio"
        :aria-checked="!isInstantActive"
        data-testid="booking-mode-manual"
        @click="setBookingMode(false)"
        @keydown.space.prevent="setBookingMode(false)"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-1">
            <h3 class="font-bold text-highlighted text-base">
              {{ manualTitle }}
            </h3>
            <p class="text-sm text-muted">
              {{ manualDescription }}
            </p>
          </div>
          <div
            class="size-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5"
            :class="!isInstantActive ? 'border-primary' : 'border-neutral-300 dark:border-neutral-700'"
          >
            <div v-if="!isInstantActive" class="size-2.5 rounded-full bg-primary" />
          </div>
        </div>
      </div>
    </div>

    <!-- Chevron Row: Intake Questions -->
    <div class="mt-8 border-t border-neutral-200 dark:border-neutral-800 pt-6">
      <NuxtLink
        :to="questionsPath"
        class="flex items-center justify-between p-4 rounded-2xl bg-neutral-50 dark:bg-neutral-900/50 hover:bg-neutral-100 dark:hover:bg-neutral-900 transition group"
        data-testid="booking-intake-questions-link"
      >
        <div class="space-y-0.5">
          <div class="font-bold text-sm sm:text-base text-highlighted group-hover:text-primary transition">
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

const panelLead = computed(() => {
  if (isService.value) {
    return 'Let clients choose a practice area and request a consultation directly from your website. Each consultation maintains its own schedule.'
  }
  return 'Configure how clients and guests book with your business and customize intake questions.'
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

const questionsPath = computed(() => `/dashboard/${route.params.orgSlug}/website/inquiry-form`)

const questionsSummary = computed(() => {
  const list = editor.inquiryQuestions.value
  if (!list || list.length === 0) return 'No custom questions · Contact fields only'
  return formQuestionsSummary(list)
})
</script>
