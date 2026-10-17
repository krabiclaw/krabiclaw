<template>
  <!-- eslint-disable vue/no-v-html -->
  <div
    :class="unstyled ? '' : 'prose max-w-none prose-headings:text-highlighted prose-p:leading-8 prose-p:text-default prose-a:text-primary'"
    v-html="html"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>

<script setup lang="ts">
import { renderMarkdownToHtml, sanitizeHtmlForSsr } from '~/utils/markdown'
import { loadDomPurify } from '~/utils/dom-purify-loader'

const props = defineProps<{
  content?: string | null
  unstyled?: boolean
}>()

type HtmlSanitizer = { sanitize: (_html: string) => string }
const clientSanitizer = shallowRef<HtmlSanitizer | null>(null)

function normalizeTextEntities(html: string) {
  return html.replace(/(^|>)([^<]*)/g, (_, boundary: string, text: string) =>
    boundary + text.replace(/&#39;/g, "'"))
}

const sanitizeContent = (content?: string | null) => {
  const rendered = normalizeTextEntities(renderMarkdownToHtml(content || ''))
  return (clientSanitizer.value || { sanitize: sanitizeHtmlForSsr }).sanitize(rendered)
}

const html = ref(sanitizeContent(props.content))
watch(() => props.content, content => { html.value = sanitizeContent(content) })

onMounted(async () => {
  clientSanitizer.value = await loadDomPurify()
  html.value = sanitizeContent(props.content)
})
</script>
