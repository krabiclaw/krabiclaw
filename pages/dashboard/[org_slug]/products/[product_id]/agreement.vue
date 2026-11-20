<template>
  <DashboardIndexPanel id="product-agreement" :title="label" column="leaf">
    <template v-if="level.child.value" #leading>
      <DashboardNavbarLeading :to="router.resolve({ path: level.path.value, query: route.query }).fullPath" :disabled="busy" />
    </template>
    <UAlert v-if="p.loadError.value || error" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.loadError.value || error || ''" />
    <template v-if="product">
      <p class="text-sm text-muted">Standard document or house rules for this listing. Available as a template when sending an agreement to sign.</p>
      <div v-if="product.agreement" class="mt-6 overflow-hidden rounded-2xl border border-default" data-testid="listing-agreement">
        <iframe :src="product.agreement.public_url" :title="product.agreement.file_name ?? label" class="h-80 w-full bg-elevated" />
        <div class="px-4 py-3.5">
          <p class="truncate text-sm font-medium text-highlighted">{{ product.agreement.file_name ?? label }}</p>
        </div>
      </div>
      <div v-if="product.agreement" class="mt-5 flex gap-3">
        <UButton class="flex-1 justify-center" label="Replace" color="neutral" variant="outline" size="lg" :loading="busy && action === 'replace'" :disabled="busy" @click="choose" />
        <UButton class="flex-1 justify-center" label="Remove" color="neutral" variant="outline" size="lg" :loading="busy && action === 'remove'" :disabled="busy" @click="remove" />
      </div>
      <button v-else type="button" class="mt-6 flex h-50 w-full flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed border-accented text-highlighted disabled:opacity-50" :disabled="busy" @click="choose">
        <UIcon name="i-lucide-upload" class="size-7" />
        <span class="text-base font-semibold">{{ busy ? 'Uploading…' : 'Upload a PDF' }}</span>
        <span class="text-xs text-muted">Up to 20 MB</span>
      </button>
      <p class="mt-4 text-xs text-muted">Replacing it updates the template for future bookings. Existing bookings preserve their signed documents.</p>
      <input ref="picker" type="file" accept="application/pdf" class="hidden" @change="picked">
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { agreementLabel } from '~/shared/agreements'
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
const api = `/api/editor/organizations/${encodeURIComponent(p.organizationId)}`
const { upload } = useMediaUpload(api)
const picker = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const action = ref<'replace' | 'remove' | null>(null)
const error = ref('')

function choose() {
  picker.value?.click()
}

async function place(assetId: string | null) {
  await dashboardApi(`${api}/media/placements`, {
    method: 'PUT',
    body: { placement: { owner_type: 'product', owner_id: product.value!.id, slot: 'agreement' }, asset_id: assetId },
    validate: isRecord,
  })
  await p.reload()
}

async function run(kind: 'replace' | 'remove', work: () => Promise<void>) {
  busy.value = true
  action.value = kind
  error.value = ''
  try {
    await work()
  } catch (failure) {
    error.value = getErrorMessage(failure, kind === 'remove' ? 'The document could not be removed' : 'The PDF could not be uploaded')
  } finally {
    busy.value = false
    action.value = null
  }
}

function picked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  void run('replace', async () => {
    const uploaded = await upload(file)
    if (!uploaded) throw new Error('Choose a PDF up to 20 MB')
    await place(uploaded.asset_id)
  })
}

function remove() {
  void run('remove', () => place(null))
}
</script>
