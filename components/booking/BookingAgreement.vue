<template>
  <section v-if="agreement || canManage || error" aria-labelledby="booking-agreement-title" data-testid="booking-agreement">
    <h2 id="booking-agreement-title" class="text-lg font-semibold text-highlighted">{{ agreement?.label ?? 'Agreement' }}</h2>
    <UAlert v-if="error" class="mt-3" color="error" variant="soft" icon="i-lucide-circle-alert" :description="error" />
    <template v-if="agreement">
      <p class="mt-1 text-sm text-muted" data-testid="booking-agreement-status">{{ statusLine }}</p>
      <a :href="agreement.url" target="_blank" rel="noopener" class="mt-3 flex items-center gap-3 rounded-xl border border-default p-3 text-sm text-highlighted">
        <span class="flex h-12 w-10 shrink-0 items-center justify-center rounded-md bg-elevated"><UIcon name="i-lucide-file-text" class="size-5" /></span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium">{{ agreement.file_name }}</span>
          <span class="block text-xs text-muted">{{ agreement.source === 'listing' ? 'From the listing' : agreement.status === 'stored' ? 'Signed copy' : 'For this booking' }}</span>
        </span>
        <UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
      </a>
      <ul v-if="agreement.signers.length" class="mt-4 space-y-3.5">
        <li v-for="signer in agreement.signers" :key="signer.key" class="flex items-center gap-3">
          <UAvatar :text="signer.name.slice(0, 1).toUpperCase()" :alt="signer.name" size="sm" class="bg-accented" :ui="{ fallback: 'font-semibold text-highlighted' }" />
          <span class="min-w-0 flex-1 text-sm">
            <span class="block font-medium text-highlighted">{{ signer.key === agreement.viewer_signer_key ? 'You' : signer.name }}</span>
            <span class="block text-xs text-muted">{{ signer.signed_at ? `Signed ${formatWhen(signer.signed_at)}` : 'Not signed yet' }}</span>
          </span>
          <UIcon v-if="signer.signed_at" name="i-lucide-check" class="size-5 text-highlighted" aria-label="Signed" />
        </li>
      </ul>
      <UButton v-if="agreement.can_sign" class="mt-5" block size="lg" color="neutral" label="Sign" data-testid="booking-agreement-sign" @click="emit('openSigning', agreement)" />
    </template>
    <div class="mt-3">
      <a v-if="downloadUrl" :href="downloadUrl" :class="rowClass"><UIcon name="i-lucide-download" class="size-4 shrink-0" /><span class="min-w-0 flex-1">{{ agreement?.signed_url ? 'Download signed PDF' : 'Download' }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" /></a>
    </div>
  </section>
</template>

<script setup lang="ts">
import { agreementStatusLine, isBookingAgreement, type BookingAgreement } from '~/shared/agreements'
import { isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'

/** A booking's agreement, as the server states it for this viewer: what it is, who signed, and what the viewer may do. */
const props = defineProps<{
  conversationId: string
  /**
   * The agreement the booking's read already carries. Without it — a guest who
   * joined the conversation but holds no booking panel — the conversation's
   * own agreement route is read instead.
   */
  preloaded?: { agreement: BookingAgreement | null; canManage: boolean }
}>()
/** Signing opens the full-screen sheet its host renders, which re-reads the booking once signed. */
const emit = defineEmits<{ openSigning: [agreement: BookingAgreement] }>()

const rowClass = 'flex w-full items-center gap-3 py-2.5 text-left text-sm text-highlighted disabled:opacity-50'
const fetched = ref<{ agreement: BookingAgreement | null; canManage: boolean } | null>(null)
const agreement = computed(() => (props.preloaded ?? fetched.value)?.agreement ?? null)
const canManage = computed(() => (props.preloaded ?? fetched.value)?.canManage === true)
const error = ref('')
const base = computed(() => `/api/messages/${encodeURIComponent(props.conversationId)}/agreement`)

const downloadUrl = computed(() => {
  const url = agreement.value?.signed_url ?? agreement.value?.url
  if (!url || !url.startsWith('/api/')) return url ?? null
  return `${url}?download=1`
})

function formatWhen(at: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(at))
}

const statusLine = computed(() => agreement.value ? agreementStatusLine(agreement.value) : '')

/** The conversation's agreement route, for a viewer whose booking read does not carry it. */
async function load() {
  error.value = ''
  try {
    const answer = await applicationFetch(base.value, {
      validate: (value): value is { agreement: BookingAgreement | null; can_manage: boolean } => isRecord(value)
        && (value.agreement === null || isBookingAgreement(value.agreement)) && typeof value.can_manage === 'boolean',
    })
    fetched.value = { agreement: answer.agreement, canManage: answer.can_manage }
  } catch (failure) {
    error.value = getErrorMessage(failure, 'The agreement could not be loaded')
  }
}

// The conversation's own read, once, when no booking read carries the agreement.
if (!props.preloaded) void load()
</script>
