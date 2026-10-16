import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getClientIp, hashClientIp, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { logMcpToolCallEvent } from '~/server/utils/mcp-telemetry'
import { getCloudflareWaitUntil } from '~/server/utils/mcp-route-helpers'
import { formatPublicSearchResultsForPrompt, searchPublicResources } from '~/server/utils/public-search'
import { runWorkersAiText } from '~/server/utils/workers-ai'

interface HelpMessage {
  role?: 'user' | 'assistant'
  content?: string
}

const DEFAULT_DISCOVERY_PROMPTS = [
  'How do I connect my own domain?', 'How do I add or update menu items?', 'Do I need technical skills to use KrabiClaw?', ]
const IP_HOURLY_LIMIT = 30

function logPublicHelpEventDetached(
  event: Parameters<typeof getCloudflareWaitUntil>[0], db: D1Database | undefined, input: Parameters<typeof logMcpToolCallEvent>[1], ) {
  if (!db) return
  const waitUntil = getCloudflareWaitUntil(event)
  if (!waitUntil) throw new Error('Help telemetry requires the Worker execution context')
  waitUntil(logMcpToolCallEvent(db, { ...input, mcpSurface: 'public_help' }))
}

function parseAgentEnvelope(raw: string) {
  const escalateMatch = raw.match(/ESCALATE:\s*(yes|no)/i)
  const topicMatch = raw.match(/TOPIC:\s*(.+)/i)
  const summaryMatch = raw.match(/SUMMARY:\s*(.+)/i)
  const answerMatch = raw.match(/ANSWER:\s*([\s\S]*)$/i)

  return {
    escalate: escalateMatch?.[1]?.toLowerCase() === 'yes', topic: topicMatch?.[1]?.trim() || null, summary: summaryMatch?.[1]?.trim() || null, answer: answerMatch?.[1]?.trim() || null, }
}

function shouldForceEscalation(message: string) {
  return /\b(human|contact|support case|refund|billing issue|bug|broken|can't access|cannot access|login problem|urgent)\b/i.test(message)
}

function isLowIntentOpening(message: string) {
  const normalized = message.trim().toLowerCase()
  return /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening|help|\?)$/.test(normalized)
}

function buildClarifyingReply() {
  return [
    'Hi, I can help with docs, setup, billing, domains, ChowBot, or account access.', '', 'Tell me what you need help with and I’ll try to answer first before suggesting a support case.', ].join('\n')
}

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  let body: { message?: string; history?: HelpMessage[]; topic?: string | null }
  try {
    body = await readRequiredBody<{ message?: string; history?: HelpMessage[]; topic?: string | null }>(event)
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body) {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }

  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : ''
  const topic = typeof body.topic === 'string' ? body.topic.trim().slice(0, 200) : ''
  const history = Array.isArray(body.history)
    ? body.history
        .filter(item => item && typeof item.content === 'string' && (item.role === 'user' || item.role === 'assistant'))
        .slice(-6)
        .map(item => ({ role: item.role!, content: item.content!.trim().slice(0, 2000) }))
    : []

  if (!message) {
    return jsonResponse({ error: 'message is required' }, { status: 400 })
  }

  const startedAt = Date.now()
  try {
    if (!import.meta.dev) {
      const clientIp = getClientIp(event)
      const hourWindow = Math.floor(Date.now() / 3_600_000)
      const rateLimitOk = await incrementHourlyRateLimit(
        db, `rate:public-help-agent:ip:${await hashClientIp(clientIp)}:${hourWindow}`, IP_HOURLY_LIMIT, 3_600_000, )
      if (!rateLimitOk) {
        return jsonResponse({ error: 'Too many requests. Please try again later.' }, { status: 429 })
      }
    }

    const lowIntentOpening = isLowIntentOpening(message)
    const results = await searchPublicResources(env, `${topic ? `${topic} ` : ''}${message}`, {
      limit: 6, surface: 'help', organizationId: event.context.tenantType === 'tenant' ? String(event.context.organizationId || '') : null, })
    const promptResults = formatPublicSearchResultsForPrompt(results)
    let parsed = {
      escalate: false, topic: topic || null, summary: null as string | null, answer: lowIntentOpening ? buildClarifyingReply() : null, }

    if (!lowIntentOpening) {
      try {
        const aiOutput = await runWorkersAiText(env, [
          {
            role: 'system', content: [
              'You are KrabiClaw Support, a concise public support assistant.', 'Only answer using the provided search results.', 'If the search results are insufficient, the question needs account-specific help, or the user appears blocked, escalate to a support form.', 'Do not escalate for greetings, vague openers, or questions that should first get a clarifying follow-up.', 'Return exactly this format:', 'ESCALATE: yes|no', 'TOPIC: <short topic>', 'SUMMARY: <one sentence support summary or none>', 'ANSWER:', '<markdown answer>', ].join('\n'), }, {
            role: 'user', content: [
              topic ? `Selected topic: ${topic}` : 'Selected topic: none', history.length ? `Recent conversation:\n${history.map(item => `${item.role}: ${item.content}`).join('\n')}` : 'Recent conversation: none', `User question: ${message}`, `Search results:\n${promptResults || 'No relevant results found.'}`, ].join('\n\n'), }, ], { maxTokens: 700, temperature: 0.2 })

        const parsedOutput = parseAgentEnvelope(aiOutput)
        parsed = {
          ...parsedOutput, answer: parsedOutput.answer, }
      } catch (error) {
        console.error('Public help agent failed:', error)
        return jsonResponse({ error: 'Support assistant unavailable' }, { status: 502 })
      }
    }

    if (!parsed.answer) {
      return jsonResponse({ error: 'Support assistant returned no answer' }, { status: 502 })
    }

    const shouldEscalate = !lowIntentOpening && (parsed.escalate || shouldForceEscalation(message))
    const suggestedLinks = results
      .filter(result => result.path !== '/help')
      .slice(0, 3)
      .map(result => ({ title: result.title, path: result.path, type: result.type }))
    const followUpPrompts = lowIntentOpening
      ? DEFAULT_DISCOVERY_PROMPTS
      : []

    const response = {
      reply: parsed.answer, citations: results.slice(0, 3), suggestedLinks, followUpPrompts, escalation: shouldEscalate
        ? {
            topic: parsed.topic || topic || 'Support request', message: parsed.summary && parsed.summary.toLowerCase() !== 'none'
              ? `${parsed.summary}\n\n${message}`
              : message, suggested_summary: parsed.summary && parsed.summary.toLowerCase() !== 'none'
              ? parsed.summary
              : null, agent_metadata_json: {
              topic: topic || null, results: results.slice(0, 5), }, }
        : null, }

    logPublicHelpEventDetached(event, env.DB, {
      method: 'help/chat', toolName: 'public_help_chowbot', toolDomain: 'support', arguments: {
        topic: topic || null, message_length: message.length, history_length: history.length, }, result: {
        escalation: shouldEscalate, suggested_links: suggestedLinks.length, citations: response.citations.length, }, status: 'success', durationMs: Date.now() - startedAt, })

    return jsonResponse(response)
  } catch (error) {
    logPublicHelpEventDetached(event, env.DB, {
      method: 'help/chat', toolName: 'public_help_chowbot', toolDomain: 'support', arguments: {
        topic: topic || null, message_length: message.length, history_length: history.length, }, status: 'error', errorMessage: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt, })
    console.error('Public help agent failed:', error)
    return jsonResponse({ error: 'Failed to answer support question' }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import { readBody } from 'nitro/h3';
