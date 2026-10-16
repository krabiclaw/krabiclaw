import assert from 'node:assert/strict'
import test from 'node:test'
import { platformHomeSocialCardCopy } from '../../server/utils/platform-home-social-card.ts'

test('homepage share card states every rotating accent and preserves the description', () => {
  const description = 'Get online in minutes with KrabiClaw. The AI-first, MCP-native platform for building, managing, and growing your business online.'
  assert.deepEqual(platformHomeSocialCardCopy({ title: 'Automate your website using', rotating_accents: ['ChatGPT', 'Claude', 'MCP'], subtitle: description }), {
    title: 'Automate your website using ChatGPT, Claude, MCP',
    description,
  })
})

test('missing hero title keeps the existing organization fallback available', () => {
  assert.equal(platformHomeSocialCardCopy({ subtitle: 'Description only' }), null)
  assert.deepEqual(platformHomeSocialCardCopy({ title: 'Website', rotating_accents: [null, '', ' Claude '] }), { title: 'Website Claude', description: null })
})
