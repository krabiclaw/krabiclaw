import assert from 'node:assert/strict'
import test from 'node:test'
import { runWorkersAiText } from '../../server/utils/workers-ai.ts'

const ai = (response: unknown, usage?: unknown) => ({ AI: { run: async () => ({ response, ...(usage ? { usage } : {}) }) } })
const messages = [{ role: 'user' as const, content: 'Draft replies' }]

test('a text answer is returned trimmed, with the model and the tokens Workers AI counted', async () => {
  assert.deepEqual(await runWorkersAiText(ai('  Hello there  ', { prompt_tokens: 12, completion_tokens: 3 }), messages),
    { text: 'Hello there', model: '@cf/meta/llama-3.1-8b-instruct-fast', promptTokens: 12, outputTokens: 3 })
})

test('an answer Workers AI already parsed as JSON comes back as that JSON', async () => {
  const drafts = ['We can check that for you.', 'Early check-in is usually fine.']
  const answer = await runWorkersAiText(ai(drafts), messages)
  assert.deepEqual(JSON.parse(answer.text), drafts)
  assert.deepEqual([answer.promptTokens, answer.outputTokens], [null, null])
  assert.deepEqual(JSON.parse((await runWorkersAiText(ai({ replies: drafts }), messages)).text), { replies: drafts })
})

test('an answer that is neither text nor JSON fails, saying what came back', async () => {
  await assert.rejects(runWorkersAiText(ai(42), messages), /Workers AI answered with a number where text or JSON was expected/)
})

test('no Workers AI binding fails', async () => {
  await assert.rejects(runWorkersAiText({}, messages), /Workers AI binding is not available/)
})
