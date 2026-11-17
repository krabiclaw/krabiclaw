import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { broadcastName } from '~/server/domain/article-broadcast'

test('a Resend broadcast name never exceeds the 70 characters Resend accepts', () => {
  const title = 'What’s New in Blawby: Smoother Bookings, Thai SEO, Claude, and More'
  assert.equal(title.length, 67)
  const name = broadcastName(title)
  assert.equal(name.length, 70)
  assert.ok(name.startsWith('Article: What’s New in Blawby'))
  assert.equal(broadcastName('Hello'), 'Article: Hello')
})
