import test from 'node:test'
import assert from 'node:assert/strict'
import { markdownHeadings, renderMarkdownToHtml } from '../../utils/markdown.ts'

test('the table of contents names each h2 and h3 by the id the rendered body gives it', () => {
  const markdown = [
    '# Title', '## Setup', 'Text', '### `get_product` & you’re done', '## Setup', '#### Deep', '> ## Quoted', '| a |\n|---|\n| b |', '## Café 1',
  ].join('\n\n')
  const rendered = [...renderMarkdownToHtml(markdown, 4).matchAll(/<h([23]) id="([^"]+)"/g)].map(([, depth, id]) => ({ id, depth: Number(depth) }))
  const headings = markdownHeadings(markdown, 4)
  assert.deepEqual(headings.map(({ id, depth }) => ({ id, depth })), rendered)
  assert.deepEqual(headings.map(heading => heading.text), ['Setup', 'get_product & you’re done', 'Setup', 'Quoted', 'Café 1'])
})
