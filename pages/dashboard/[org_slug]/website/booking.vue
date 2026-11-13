<template>
  <DashboardLeafPanel
    id="organization-website-booking"
    :title="panelTitle"
    :saving="editor.saving.value"
    :footer="vertical === 'lodging' || isService"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <template v-if="vertical === 'lodging'">
      <LodgingBookingChoices
        v-if="editor.lodgingBookingChoices.value.length"
        v-model="editor.form.stay_confirmation_mode"
        :choices="editor.lodgingBookingChoices.value"
        :label="panelTitle"
      />

      <NuxtLink
        :to="payoutPath"
        class="mt-6 flex items-center justify-between gap-4 rounded-2xl border border-default p-4 hover:bg-elevated"
      >
        <div>
          <p class="font-semibold text-highlighted">How you get paid</p>
          <p class="text-sm text-muted">Manage your Stripe account and payouts.</p>
        </div>
        <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
      </NuxtLink>
    </template>

    <URadioGroup
      v-else-if="isService"
      :model-value="editor.form.native_consultations ? 'online' : 'offline'"
      :items="consultationChoices"
      :aria-label="panelTitle"
      variant="card"
      @update:model-value="editor.form.native_consultations = $event === 'online'"
    />

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
import LodgingBookingChoices from '~/lib/components/workspace/settings/LodgingBookingChoices.vue'
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

const consultationChoices = [
  { value: 'online', label: 'Accept consultation requests online', description: 'Clients can select a practice area and submit consultation requests with intake details online.' },
  { value: 'offline', label: 'Inquiries only (offline scheduling)', description: 'Clients contact your office directly via phone or email to schedule consultations.' },
]

const payoutPath = computed(() => `/dashboard/${route.params.org_slug}/payments/payout-method`)
const questionsPath = computed(() => `/dashboard/${route.params.org_slug}/website/inquiry-form`)

const questionsSummary = computed(() => {
  const list = editor.inquiryQuestions.value
  if (!list || list.length === 0) return 'No custom questions · Contact fields only'
  return formQuestionsSummary(list)
})
</script>
