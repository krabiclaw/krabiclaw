import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLlmsTxt, renderContentBlocksForLlm } from '../../server/utils/platform-llm.ts'
import { htmlToPlainText, renderMarkdownToHtml } from '../../utils/markdown.ts'

test('LLM callouts and media text retain literal titles and bodies across Markdown rendering', () => {
  for (const type of ['callout', 'media_text']) {
    const markdown = renderContentBlocksForLlm([{ type, position: 0, level: null, media: [],
      data: { title: 'Use <Free> plan', body: 'Keep **literal** text and <private>.\nLine two.' } }])
    const html = renderMarkdownToHtml(markdown)
    assert.match(htmlToPlainText(html), /Use <Free> plan/)
    assert.match(htmlToPlainText(html), /Keep \*\*literal\*\* text and <private>\.\nLine two\./)
    assert.doesNotMatch(html, /<strong>literal<\/strong>|<private>|<Free>/)
  }
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

