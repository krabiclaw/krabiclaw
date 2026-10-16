import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLlmsTxt, renderContentBlocksForLlm } from '../../server/utils/platform-llm.ts'
import { htmlToPlainText, renderMarkdownToHtml } from '../../utils/markdown.ts'

test('LLM callouts retain the article title and literal body across Markdown rendering', () => {
  const markdown = renderContentBlocksForLlm([{ type: 'callout', position: 0, level: null, media: [],
    data: { title: 'Changes after publication', body: 'Keep **literal** text and <private>.\nLine two.' } }])
  const html = renderMarkdownToHtml(markdown)
  assert.match(html, /Changes after publication/)
  assert.match(htmlToPlainText(html), /Keep \*\*literal\*\* text and <private>\.\nLine two\./)
  assert.doesNotMatch(html, /<strong>literal<\/strong>|<private>/)
})

test('LLM image captions come from the article block and keep literal text', () => {
  const markdown = renderContentBlocksForLlm([{ type: 'image', position: 0, level: null,
    data: { caption: 'The [current] upload control.' }, media: [{ public_url: 'https://example.com/screen.png', alt_text: 'Upload [control]' }] }])
  const html = renderMarkdownToHtml(markdown)
  assert.match(html, /alt="Upload \[control\]"/)
  assert.match(htmlToPlainText(html), /The \[current\] upload control\./)
})

test('LLM video rendering uses a plain watch URL without a name and keeps descriptions', () => {
  const url = 'https://youtu.be/abc123DEF45'
  const watchUrl = 'https://www.youtube.com/watch?v=abc123DEF45'
  const blocks = [
    { type: 'video', position: 0, level: null, data: { url, caption: '  First description  ' }, media: [] },
    { type: 'video', position: 1, level: null, data: { url, title: '  Walkthrough  ', caption: '  Second description  ' }, media: [] },
  ]

  assert.equal(renderContentBlocksForLlm(blocks), `${watchUrl}\n\nFirst description\n\n[Walkthrough](${watchUrl})\n\nSecond description`)
})

test('buildLlmsTxt includes pricing.md link on platform site', () => {
  const result = buildLlmsTxt('https://krabiclaw.com', [], [])
  assert.ok(result.includes('- [Pricing](https://krabiclaw.com/pricing.md): Plain markdown specification of plans, features, and limits.'))
})

test('buildLlmsTxt includes coreLinks when provided for tenant', () => {
  const result = buildLlmsTxt('https://restaurant.example.com', [], [], {
    title: 'Ember & Slice',
    coreLinks: [
      { title: 'Menu', path: '/menu', description: 'Current food and drink menu.' },
      { title: 'Reservations', path: '/reservations', description: 'Table bookings.' },
    ],
  })
  assert.ok(result.includes('## Overview & Services'))
  assert.ok(result.includes('- [Menu](https://restaurant.example.com/menu): Current food and drink menu.'))
  assert.ok(result.includes('- [Reservations](https://restaurant.example.com/reservations): Table bookings.'))
  assert.ok(!result.includes('## Support'))
})

test('buildLlmsTxt directs platform support to GitHub issue forms', () => {
  const result = buildLlmsTxt('https://krabiclaw.com', [], [])
  assert.ok(result.includes('- [Report a bug](https://github.com/krabiclaw/krabiclaw/issues/new?template=bug.yml): fields `surface`, `site`, `what_happened`, `expected`, `tool_error`.'))
  assert.ok(result.includes('- [Request a feature](https://github.com/krabiclaw/krabiclaw/issues/new?template=feature.yml): fields `need`, `today`, `site`.'))
  assert.ok(result.includes('- [Account, billing or private matters](https://krabiclaw.com/help): not public.'))
})

