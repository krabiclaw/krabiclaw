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
      <UButton v-if="agreement.can_sign" class="mt-5" block size="lg" color="neutral" label="Sign" data-testid="booking-agreement-sign" @click="signing = true" />
    </template>
    <div class="mt-3">
      <a v-if="downloadUrl" :href="downloadUrl" :class="rowClass"><UIcon name="i-lucide-download" class="size-4 shrink-0" /><span class="min-w-0 flex-1">{{ agreement?.signed_url ? 'Download signed PDF' : 'Download' }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" /></a>
      <template v-if="canManage && editorPath">
        <NuxtLink :to="`${editorPath}/agreement`" :class="rowClass" data-testid="booking-agreement-send"><UIcon name="i-lucide-send" class="size-4 shrink-0" /><span class="min-w-0 flex-1">{{ agreement?.source === 'booking' ? 'Replace document' : 'Send a document to sign' }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" /></NuxtLink>
        <button type="button" :class="rowClass" :disabled="busy !== null" @click="picker?.click()"><UIcon name="i-lucide-upload" class="size-4 shrink-0" /><span class="min-w-0 flex-1">{{ busy === 'store' ? 'Uploading…' : 'Add a signed copy' }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" /></button>
        <button v-if="agreement?.source === 'booking' && agreement.status !== 'signed'" type="button" :class="rowClass" :disabled="busy !== null" @click="cancelRequest"><UIcon name="i-lucide-circle-x" class="size-4 shrink-0" /><span class="min-w-0 flex-1">{{ agreement.status === 'stored' ? 'Remove signed copy' : 'Cancel signing request' }}</span><UIcon name="i-lucide-chevron-right" class="size-4 text-muted" /></button>
        <input ref="picker" type="file" accept="application/pdf" class="hidden" @change="store">
      </template>
    </div>
    <AgreementSignSheet v-if="agreement?.can_sign" v-model:open="signing" :conversation-id="conversationId" :agreement="agreement" @signed="load" />
  </section>
</template>

<script setup lang="ts">
import AgreementSignSheet from '~/components/booking/AgreementSignSheet.vue'
import { isBookingAgreement, type BookingAgreement } from '~/shared/agreements'
import { isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'

/** A booking's agreement, as the server states it for this viewer: what it is, who signed, and what the viewer may do. */
const props = defineProps<{
  conversationId: string
  /** The booking's own route, under which the business sends a document to sign. */
  editorPath?: string | null
  /** Changes when the conversation does, so a signature elsewhere shows here. */
  revision?: number
}>()

const rowClass = 'flex w-full items-center gap-3 py-2.5 text-left text-sm text-highlighted disabled:opacity-50'
const agreement = ref<BookingAgreement | null>(null)
const canManage = ref(false)
const error = ref('')
const busy = ref<'store' | 'cancel' | null>(null)
const signing = ref(false)
const picker = ref<HTMLInputElement | null>(null)
const base = computed(() => `/api/messages/${encodeURIComponent(props.conversationId)}/agreement`)

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

async function load() {
  error.value = ''
  try {
    const answer = await applicationFetch(base.value, {
      validate: (value): value is { agreement: BookingAgreement | null; can_manage: boolean } => isRecord(value)
        && (value.agreement === null || isBookingAgreement(value.agreement)) && typeof value.can_manage === 'boolean',
    })
    agreement.value = answer.agreement
    canManage.value = answer.can_manage
  } catch (failure) {
    error.value = getErrorMessage(failure, 'The agreement could not be loaded')
  }
}

async function store(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || busy.value) return
  busy.value = 'store'
  error.value = ''
  try {
    const form = new FormData()
    form.append('file', file)
    await applicationFetch(`${base.value}/store`, { method: 'POST', body: form, validate: isRecord })
    await load()
  } catch (failure) {
    error.value = getErrorMessage(failure, 'The signed copy could not be added')
  } finally {
    busy.value = null
  }
}

async function cancelRequest() {
  if (busy.value) return
  busy.value = 'cancel'
  error.value = ''
  try {
    await applicationFetch(`${base.value}/cancel`, { method: 'POST', body: {}, validate: isRecord })
    await load()
  } catch (failure) {
    error.value = getErrorMessage(failure, 'The request could not be cancelled')
  } finally {
    busy.value = null
  }
}

watch(() => [props.conversationId, props.revision], () => { void load() }, { immediate: true })
</script>
