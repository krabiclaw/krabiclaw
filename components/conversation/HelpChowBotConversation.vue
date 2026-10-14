<template>
  <main class="flex min-h-0 flex-1 flex-col">
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-3xl px-4 sm:px-6">
        <!-- The hero belongs to the empty state, so it lives here rather than in
             the page: the transcript is what decides whether it is still true. -->
        <slot v-if="!conversationStarted" name="intro" />

        <UChatMessages
          :messages="chatMessages"
          :status="chatStatus"
          should-auto-scroll
          should-scroll-to-bottom
          :user="{ side: 'right', variant: 'subtle' }"
          :assistant="{ side: 'left', variant: 'naked' }"
          class="py-4"
        >
          <template #indicator>
            <div class="flex items-center gap-3 text-sm text-muted">
              <span class="flex items-center gap-1.5">
                <span class="size-2 rounded-full bg-primary animate-pulse" />
                <span class="size-2 rounded-full bg-primary/70 animate-pulse [animation-delay:120ms]" />
                <span class="size-2 rounded-full bg-primary/40 animate-pulse [animation-delay:240ms]" />
              </span>
              <span>ChowBot is thinking…</span>
            </div>
          </template>

          <template #content="{ message }">
            <div class="space-y-2">
              <!-- Sanitized by DOMPurify in renderMarkdown before it reaches here. -->
              <!-- eslint-disable vue/no-v-html -->
              <div
                v-if="message.role === 'assistant'"
                class="prose prose-sm dark:prose-invert max-w-none"
                v-html="renderMarkdown(messageText(message))"
              />
              <!-- eslint-enable vue/no-v-html -->
              <p v-else class="whitespace-pre-wrap">{{ messageText(message) }}</p>

              <template v-if="message.role === 'assistant'">
                <div v-if="message.metadata.suggestedLinks.length" class="space-y-2 pt-1">
                  <p class="text-xs font-medium uppercase tracking-[0.18em] text-muted">Related resources</p>
                  <div class="flex flex-wrap gap-2">
                    <NuxtLink
                      v-for="link in message.metadata.suggestedLinks"
                      :key="`${link.path}-${link.title}`"
                      :to="link.path"
                      class="inline-flex items-center gap-2 rounded-full border border-default px-3 py-1.5 text-xs font-medium text-default no-underline transition hover:border-muted hover:bg-elevated"
                    >
                      <span>{{ link.title }}</span>
                      <PlatformIcon name="arrow-up-right" class="size-3.5 text-muted" />
                    </NuxtLink>
                  </div>
                </div>

                <div v-if="message.metadata.followUpPrompts.length" class="space-y-2 pt-1">
                  <p class="text-xs font-medium uppercase tracking-[0.18em] text-muted">Ask next</p>
                  <div class="flex flex-wrap gap-2">
                    <UButton
                      v-for="prompt in message.metadata.followUpPrompts"
                      :key="prompt"
                      color="neutral"
                      variant="outline"
                      size="xs"
                      class="rounded-full"
                      :disabled="isLoading"
                      @click="handleSuggestedPrompt(prompt)"
                    >
                      {{ prompt }}
                    </UButton>
                  </div>
                </div>

                <!-- The form is a panel, not part of what the agent said: the
                     message offers the escalation and the slideover carries it. -->
                <div v-if="escalationFor(message)" class="pt-2">
                  <UButton
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-life-buoy"
                    @click="openEscalation(message.id)"
                  >
                    Create support case
                  </UButton>
                </div>
              </template>
            </div>
          </template>
        </UChatMessages>
      </div>
    </div>

    <div class="shrink-0 bg-default">
      <div class="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6">
        <UChatPrompt
          v-model="input"
          placeholder="Ask ChowBot anything..."
          variant="naked"
          :disabled="isLoading"
          :maxrows="6"
          @submit="handleSubmit"
        >
          <template #trailing>
            <UChatPromptSubmit
              :status="promptStatus"
              color="neutral"
              variant="solid"
              size="xs"
              :aria-label="isLoading ? 'Stop generating' : 'Send message'"
              :title="isLoading ? 'Stop generating' : 'Send message'"
              :disabled="!isLoading && !input.trim()"
              @stop="handleStop"
            />
          </template>
        </UChatPrompt>

        <p class="mt-2 text-center text-xs text-muted">
          ChowBot can make mistakes.
        </p>
      </div>
    </div>

    <USlideover v-model:open="escalationOpen" title="Support case">
      <template #body>
        <PlatformSupportContactForm
          v-if="activeEscalation"
          description="Send the details here and the team will follow up by email."
          submit-label="Send support request"
          source="help_agent"
          route-context="/help"
          :initial-topic="activeEscalation.escalation.topic"
          :initial-message="activeEscalation.escalation.message"
          :suggested-summary="activeEscalation.escalation.suggested_summary"
          :agent-metadata="activeEscalation.escalation.agent_metadata_json"
          @submitted="markEscalationSubmitted(activeEscalation.id)"
        />
      </template>
    </USlideover>
  </main>
</template>

<script setup lang="ts">
import { $fetch } from 'ofetch'
import { marked } from 'marked'
import { sanitizeHtmlForSsr } from '~/utils/markdown'
import { loadDomPurify } from '~/utils/dom-purify-loader'

const DOMPurify = import.meta.client ? await loadDomPurify() : { sanitize: sanitizeHtmlForSsr }

const renderer = new marked.Renderer()
renderer.link = function ({ href, title, tokens }) {
  const titleAttr = title ? ` title="${title}"` : ''
  const text = this.parser.parseInline(tokens)
  return `<a href="${href}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`
}
marked.setOptions({ renderer, breaks: true, gfm: true })

type HelpCitation = {
  title: string
  path: string
  type: string
}

type HelpEscalation = {
  topic: string
  message: string
  suggested_summary?: string | null
  agent_metadata_json?: ApiValue
}

type HelpMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  suggestedLinks?: HelpCitation[]
  followUpPrompts?: string[]
  escalation?: HelpEscalation | null
  escalationSubmitted?: boolean
}

// What the chat components need: a stable id, a presentation role, and the text
// as a part. Help-specific facts ride along in `metadata` so the content slot can
// reach them without a second lookup into `messages`.
type HelpChatMetadata = {
  suggestedLinks: HelpCitation[]
  followUpPrompts: string[]
  escalation: HelpEscalation | null
  escalationSubmitted: boolean
}

type HelpChatMessage = {
  id: string
  role: 'user' | 'assistant'
  parts: { type: 'text', text: string }[]
  metadata: HelpChatMetadata
}

const supportIntro = 'Hello, I\'m ChowBot from Krabiclaw. I can search docs, product guidance, pricing, and support answers, and if you are still blocked I\'ll help send it to support.'

const input = ref('')
const nextMessageId = ref(1)
const messages = ref<HelpMessage[]>([{ id: 'help-0', role: 'assistant', content: supportIntro }])
const isLoading = ref(false)
const activeRequest = ref<AbortController | null>(null)
const escalationMessageId = ref<string | null>(null)

// The intro message is the empty state, not a conversation. Anything past it is.
const conversationStarted = computed(() => messages.value.length > 1)

const chatMessages = computed<HelpChatMessage[]>(() => messages.value.map(message => ({
  id: message.id,
  role: message.role,
  parts: [{ type: 'text', text: message.content }],
  metadata: {
    suggestedLinks: message.suggestedLinks ?? [],
    followUpPrompts: message.followUpPrompts ?? [],
    escalation: message.escalation ?? null,
    escalationSubmitted: message.escalationSubmitted ?? false,
  },
})))

// `submitted` is what makes UChatMessages render its own pending indicator and
// hold the latest question in view, so the in-flight request is expressed once
// here rather than as a placeholder message in the transcript.
const chatStatus = computed<'submitted' | undefined>(() => isLoading.value ? 'submitted' : undefined)
const promptStatus = computed<'ready' | 'submitted'>(() => isLoading.value ? 'submitted' : 'ready')

const activeEscalation = computed(() => {
  const message = messages.value.find(item => item.id === escalationMessageId.value)
  return message?.escalation ? { id: message.id, escalation: message.escalation } : null
})

const escalationOpen = computed({
  get: () => activeEscalation.value !== null,
  set: (open: boolean) => { if (!open) escalationMessageId.value = null },
})

function messageText(message: HelpChatMessage) {
  return message.parts.find(part => part.type === 'text')?.text ?? ''
}

function escalationFor(message: HelpChatMessage) {
  const { escalation, escalationSubmitted } = message.metadata
  return escalation && !escalationSubmitted ? escalation : null
}

function openEscalation(id: string) {
  escalationMessageId.value = id
}

function renderMarkdown(text: string): string {
  const html = marked.parse(text) as string
  return DOMPurify.sanitize(html)
}

function createMessage(role: HelpMessage['role'], content: string, extra: Partial<HelpMessage> = {}): HelpMessage {
  return { id: `help-${nextMessageId.value++}`, role, content, ...extra }
}

async function submitMessage(message: string) {
  const normalizedMessage = message.trim()
  if (!normalizedMessage || isLoading.value) return

  input.value = ''
  const history = messages.value.map(item => ({ role: item.role, content: item.content }))
  messages.value = [...messages.value, createMessage('user', normalizedMessage)]
  isLoading.value = true

  const controller = new AbortController()
  activeRequest.value = controller

  try {
    const response = await $fetch<{
      reply: string
      suggestedLinks?: HelpCitation[]
      followUpPrompts?: string[]
      escalation?: HelpEscalation | null
    }>('/api/public/help/agent', {
      method: 'POST',
      body: { message: normalizedMessage, history },
      signal: controller.signal,
    })

    messages.value = [
      ...messages.value,
      createMessage('assistant', response.reply, {
        suggestedLinks: response.suggestedLinks ?? [],
        followUpPrompts: response.followUpPrompts ?? [],
        escalation: response.escalation ?? null,
        escalationSubmitted: false,
      }),
    ]
  } catch (error) {
    if (controller.signal.aborted) {
      messages.value = [...messages.value, createMessage('assistant', 'Stopped.')]
      return
    }

    const content = error instanceof Error ? error.message : 'Something went wrong. Please try again.'
    messages.value = [...messages.value, createMessage('assistant', content)]
  } finally {
    if (activeRequest.value === controller) activeRequest.value = null
    isLoading.value = false
  }
}

async function handleSubmit() {
  await submitMessage(input.value)
}

async function handleSuggestedPrompt(prompt: string) {
  await submitMessage(prompt)
}

function handleStop() {
  activeRequest.value?.abort()
}

function markEscalationSubmitted(id: string) {
  const next = [...messages.value]
  const index = next.findIndex(message => message.id === id)
  const target = next[index]
  if (!target) return

  next[index] = { ...target, escalationSubmitted: true }
  next.push(createMessage('assistant', 'Thanks. Your support request is on its way and the team will follow up by email.'))
  messages.value = next
  escalationMessageId.value = null
}
</script>
