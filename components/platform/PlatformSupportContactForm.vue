<template>
  <div class="rounded-2xl border border-default bg-default p-5 shadow-sm">
    <div v-if="title || description" class="mb-4">
      <p v-if="title" class="text-sm font-semibold text-default">{{ title }}</p>
      <p v-if="description" class="mt-1 text-sm leading-relaxed text-muted">{{ description }}</p>
    </div>

    <div v-if="submitError" role="alert" class="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-500">
      {{ submitError }}
    </div>
    <div v-if="submitted" role="status" class="mb-4 rounded-lg border border-green-500/30 bg-green-500/5 px-4 py-3 text-sm text-green-600">
      Message sent successfully.
    </div>

    <form class="space-y-4" novalidate @submit.prevent="handleSubmit">
      <div class="grid gap-4 sm:grid-cols-2">
        <SayaFormField v-slot="{ id, describedBy, invalid }" label="Name" name="name" required :error="fieldError('name')">
          <input :id="id" v-model="form.name" type="text" placeholder="Your name" :class="inputClass" :aria-describedby="describedBy" :aria-invalid="invalid" />
        </SayaFormField>
        <SayaFormField v-slot="{ id, describedBy, invalid }" label="Email" name="email" required :error="fieldError('email')">
          <input :id="id" v-model="form.email" type="email" placeholder="you@example.com" :class="inputClass" :aria-describedby="describedBy" :aria-invalid="invalid" />
        </SayaFormField>
      </div>

      <SayaFormField v-slot="{ id, describedBy, invalid }" label="Topic" name="topic" required :error="fieldError('topic')">
        <input :id="id" v-model="form.topic" type="text" placeholder="What do you need help with?" :class="inputClass" :aria-describedby="describedBy" :aria-invalid="invalid" />
      </SayaFormField>

      <SayaFormField v-slot="{ id, describedBy, invalid }" label="Message" name="message" required :error="fieldError('message')">
        <textarea :id="id" v-model="form.message" rows="5" placeholder="Share the details..." :class="inputClass" :aria-describedby="describedBy" :aria-invalid="invalid" />
      </SayaFormField>

      <label class="flex items-start gap-3 rounded-xl border border-default bg-elevated/60 px-4 py-3 text-sm">
        <input v-model="form.consent" type="checkbox" class="mt-0.5 size-4 rounded border-default" />
        <span class="leading-relaxed text-muted">
          I consent to KrabiClaw storing and using these details to respond to my support request.
        </span>
      </label>
      <p v-if="fieldError('consent')" class="text-sm text-red-500">{{ fieldError('consent') }}</p>

      <div class="flex items-center justify-between gap-3">
        <p class="text-xs text-muted">You can edit everything before sending.</p>
        <PlatformButton type="submit" size="lg" :loading="submitting" :disabled="submitting || submitted">
          {{ submitted ? 'Message sent' : submitLabel }}
        </PlatformButton>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { $fetch } from 'ofetch'
import { FORM_INPUT_CLASS } from '~/utils/form-constants'

const props = withDefaults(defineProps<{
  title?: string | null
  description?: string | null
  submitLabel?: string
  source?: string
  routeContext?: string | null
  initialTopic?: string | null
  initialMessage?: string | null
  suggestedSummary?: string | null
  agentMetadata?: ApiValue
}>(), {
  title: null,
  description: null,
  submitLabel: 'Send message',
  source: 'contact_page',
  routeContext: '/contact',
  initialTopic: null,
  initialMessage: null,
  suggestedSummary: null,
  agentMetadata: null,
})

const emit = defineEmits<{
  submitted: [{ topic: string; message: string }]
}>()

const inputClass = FORM_INPUT_CLASS
// The help form is the KrabiClaw site's contact form: it files into that site's inbox like every tenant's.
const { id: organizationId } = useTenantOrganization().organization
const { locale } = useI18n()
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const form = ref({
  name: '',
  email: '',
  topic: props.initialTopic ?? '',
  message: props.initialMessage ?? '',
  consent: false,
})
const errors = ref<Array<{ name: string; message: string }>>([])
const submitting = ref(false)
const submitted = ref(false)
const submitError = ref<string | null>(null)

watch(() => props.initialTopic, (value) => {
  if (value && !form.value.topic) form.value.topic = value
})

watch(() => props.initialMessage, (value) => {
  if (value && !form.value.message) form.value.message = value
})

function fieldError(name: string) {
  return errors.value.find(error => error.name === name)?.message ?? null
}

function validate() {
  const next: Array<{ name: string; message: string }> = []
  if (!form.value.name.trim()) next.push({ name: 'name', message: 'Please enter your name.' })
  if (!form.value.email.trim()) next.push({ name: 'email', message: 'Please enter your email.' })
  else if (!emailPattern.test(form.value.email.trim())) next.push({ name: 'email', message: 'Please enter a valid email.' })
  if (!form.value.topic.trim()) next.push({ name: 'topic', message: 'Please add a topic.' })
  if (!form.value.message.trim()) next.push({ name: 'message', message: 'Please add a message.' })
  if (!form.value.consent) next.push({ name: 'consent', message: 'Consent is required before sending.' })
  return next
}

async function handleSubmit() {
  submitError.value = null
  errors.value = validate()
  if (errors.value.length > 0) return
  if (submitting.value) return

  submitting.value = true
  try {
    if (!organizationId) throw new Error('This form is only available on the KrabiClaw site.')
    await $fetch<unknown>(`/api/public/contact`, {
      method: 'POST',
      body: {
        locale: locale.value,
        name: form.value.name.trim(),
        email: form.value.email.trim(),
        topic: form.value.topic.trim(),
        message: form.value.message.trim(),
        consent: form.value.consent,
        source: props.source,
        route_context: props.routeContext,
        suggested_summary: props.suggestedSummary,
        agent_metadata_json: props.agentMetadata,
      },
    })
    submitted.value = true
    emit('submitted', {
      topic: form.value.topic.trim(),
      message: form.value.message.trim(),
    })
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : 'Failed to send message.'
  } finally {
    submitting.value = false
  }
}
</script>
