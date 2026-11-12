<template>
  <UDashboardPanel id="guided-menu-section" :ui="{ root: 'min-h-0', body: 'p-0 sm:p-0' }">
    <template v-if="step" #header>
      <div class="flex justify-end px-6 py-4 sm:px-10">
        <UButton color="neutral" variant="outline" class="rounded-full" :disabled="saving" @click="exit">
          {{ canSave ? step.save_exit_label : step.exit_label }}
        </UButton>
      </div>
    </template>

    <template #body>
      <form v-if="step" class="mx-auto w-full max-w-xl px-6 pb-6 pt-4 sm:px-8 sm:pt-5 lg:pt-[clamp(4rem,14vh,10rem)]" @submit.prevent="advance()">
        <h1 class="text-3xl font-semibold leading-tight text-highlighted sm:text-4xl">{{ step.title }}</h1>
        <UInput
          v-if="step.id === 'section' || step.id === 'dish'"
          v-model="name"
          :aria-label="step.field_label"
          :placeholder="step.example"
          :maxlength="step.max_length"
          :disabled="saving"
          size="xl"
          class="mt-6 w-full"
          :ui="{ base: 'min-h-14 rounded-xl' }"
        />
        <div v-else-if="step.id === 'price'" class="mt-6 flex items-center gap-2 rounded-xl border border-default px-4 focus-within:ring-2 focus-within:ring-primary">
          <span class="text-lg font-semibold" aria-hidden="true">{{ step.currency_symbol }}</span>
          <UInput v-model="amount" :aria-label="step.field_label" inputmode="decimal" size="xl" variant="none" :disabled="saving"
            placeholder="0" class="min-w-0 flex-1" :ui="{ base: 'min-h-14 px-0 text-lg' }" />
        </div>
        <div v-else-if="step.id === 'photo'" class="mt-6 max-w-md" :inert="saving">
          <DashboardCoverPhotoField :organization-id="organizationId"
            :model-value="assetId" :preview-url="photoUrl" :preview-alt="step.dish_name"
            :title="step.field_label" testid="first-dish-photo" @change="selectPhoto" />
        </div>
        <template v-else-if="step.id === 'review'">
          <div class="mt-6 flex flex-wrap items-end justify-between gap-3 border-y border-default py-4">
            <div>
              <p class="text-sm text-muted">{{ step.section_name }}</p>
              <p class="mt-1 text-lg font-semibold text-highlighted">{{ step.dish_name }}</p>
            </div>
            <p v-if="step.price_label" class="font-semibold text-highlighted">{{ step.price_label }}</p>
          </div>
          <div class="mt-5 flex flex-wrap gap-3">
            <UButton :to="step.preview_url" external target="_blank" rel="noopener" color="neutral" variant="outline" label="View private menu" trailing-icon="i-lucide-arrow-up-right" />
          </div>
        </template>
        <UAlert v-if="saveError" class="mt-5" color="error" variant="soft" :description="saveError" />
      </form>
      <UAlert v-else-if="error" class="mx-auto mt-8 max-w-xl" color="error" variant="soft" :description="getErrorMessage(error, 'Could not open menu setup.')" />
    </template>

    <template v-if="step" #footer>
      <div class="shrink-0 bg-default">
        <div class="grid h-1 gap-1" :style="{ gridTemplateColumns: `repeat(${step.question_count}, 1fr)` }"
          role="progressbar" aria-label="Menu setup" :aria-valuenow="step.progress" aria-valuemin="0" :aria-valuemax="step.question_count">
          <span v-for="position in step.question_count" :key="position" :class="position <= step.progress ? 'bg-inverted' : 'bg-elevated'" />
        </div>
        <div class="px-6 py-4 sm:px-10">
          <DashboardPanelFooter
            :cancel-label="step.back_label"
            :save-label="nextLabel"
            :disabled="requiredAnswerMissing || saving"
            :loading="saving"
            @cancel="goBack"
            @save="advance()"
          />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
import { z } from 'zod'
import DashboardCoverPhotoField, { type CoverPhotoAsset } from '~/components/dashboard/DashboardCoverPhotoField.vue'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({
  layout: 'dashboard', dashboardFrame: true, tabs: false,
  key: route => JSON.stringify([route.params.org_slug, route.query.location_id, route.query.step]),
})

const chrome = z.object({
  title: z.string(), next_label: z.string(), back_label: z.string(), back_url: z.string(),
  exit_label: z.string(), save_exit_label: z.string(), exit_url: z.string(),
  progress: z.number().int(), question_count: z.number().int().positive(),
})
const question = chrome.extend({ record_id: z.string().nullable(), version: z.string().nullable(), field_label: z.string() })
const setup = z.union([
  question.extend({
    id: z.enum(['section', 'dish']), name: z.string(), example: z.string(), max_length: z.number(),
  }),
  question.extend({ id: z.literal('price'), currency: z.string(), currency_symbol: z.string(), amount: z.string(), skip_label: z.string() }),
  question.extend({
    id: z.literal('photo'), asset_id: z.string().nullable(), photo_url: z.string().nullable(),
    dish_name: z.string(), skip_label: z.string(),
  }),
  chrome.extend({
    id: z.literal('review'), section_name: z.string(), dish_name: z.string(), preview_url: z.url(), price_label: z.string().nullable(),
  }),
  z.object({ resume_url: z.string() }),
])

const route = useRoute()
const organizationId = useDashboardOrganizationId()
const locationId = useLocationScope()
const api = useDashboardApi()
const saving = ref(false)
const saveError = ref('')

const { data, error } = await useAsyncData(`first-menu:${organizationId}:${locationId.value}:${route.query.step ?? ''}`, () =>
  api('/api/dashboard/onboarding/first-menu', {
    query: { location_id: locationId.value, step: route.query.step },
    validate: (value): value is z.infer<typeof setup> => setup.safeParse(value).success,
  }),
)
if (data.value && 'resume_url' in data.value) await navigateTo(data.value.resume_url, { replace: true })

const step = computed(() => data.value && 'id' in data.value ? data.value : null)
const name = ref(step.value && 'name' in step.value ? step.value.name : '')
const amount = ref(step.value?.id === 'price' ? step.value.amount : '')
const assetId = ref(step.value?.id === 'photo' ? step.value.asset_id : null)
const photoUrl = ref(step.value?.id === 'photo' ? step.value.photo_url : null)
const requiredAnswerMissing = computed(() => Boolean(step.value && 'name' in step.value && !name.value.trim()))
const canSave = computed(() => {
  const current = step.value
  if (!current || current.id === 'review') return false
  if (current.id === 'price') return Boolean(amount.value.trim() || current.amount)
  if (current.id === 'photo') return Boolean(assetId.value || current.asset_id)
  return !requiredAnswerMissing.value
})
const nextLabel = computed(() => {
  const current = step.value
  if (!current) return undefined
  return 'skip_label' in current && (current.id === 'price' ? !amount.value.trim() : !assetId.value)
    ? current.skip_label : current.next_label
})

function selectPhoto(asset: CoverPhotoAsset | null) {
  assetId.value = asset?.asset_id ?? null
  photoUrl.value = asset?.public_url ?? null
}

async function goBack() {
  if (step.value) await navigateTo(step.value.back_url, { replace: true })
}

async function exit() {
  if (canSave.value) await advance(true)
  else if (step.value) await navigateTo(step.value.exit_url, { replace: true })
}

async function advance(exiting = false) {
  const current = step.value
  if (!current || saving.value) return
  if (current.id === 'review') return await exit()
  if (requiredAnswerMissing.value) return
  const value = current.id === 'price' ? amount.value.trim() || null : current.id === 'photo' ? assetId.value : name.value.trim()
  saving.value = true
  saveError.value = ''
  try {
    const { next_url } = await api('/api/dashboard/onboarding/first-menu', {
      method: 'POST',
      query: { location_id: locationId.value, step: current.id },
      body: { value, record_id: current.record_id, version: current.version, exit: exiting },
      validate: (value): value is { next_url: string } => isRecord(value) && typeof value.next_url === 'string',
    })
    clearNuxtData(`product-catalog:${organizationId}`)
    await navigateTo(next_url, { replace: true })
  } catch (cause) {
    saveError.value = getErrorMessage(cause, 'Could not save your answer.')
  } finally {
    saving.value = false
  }
}
</script>
