const PUBLIC_HELP_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast'

interface WorkersAiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface WorkersAiResponse {
  /** Text, or (when the model's answer is JSON) that JSON already parsed by Workers AI. */
  response?: unknown
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** What a model wrote, which model wrote it, and the tokens Workers AI counted when it reports them. */
export interface WorkersAiText {
  text: string
  model: string
  promptTokens: number | null
  outputTokens: number | null
}

export async function runWorkersAiText(
  env: ApiRecord,
  messages: WorkersAiMessage[],
  options: {
    maxTokens?: number
    temperature?: number
  } = {},
): Promise<WorkersAiText> {
  const ai = env.AI as { run: (_model: string, _input: ApiRecord) => Promise<WorkersAiResponse> } | undefined
  if (!ai?.run) {
    throw new Error('Workers AI binding is not available')
  }

  const result = await ai.run(PUBLIC_HELP_MODEL, {
    messages,
    max_tokens: options.maxTokens ?? 700,
    temperature: options.temperature ?? 0.2,
  })
  // Workers AI hands back an answer that is JSON (a list of drafts, say) already
  // parsed; the caller asked for text, so that answer is given back as its JSON.
  const response = result.response
  if (response !== undefined && response !== null && typeof response !== 'string' && typeof response !== 'object') {
    throw new Error(`Workers AI answered with a ${typeof response} where text or JSON was expected`)
  }
  return {
    text: typeof response === 'string' ? response.trim() : response == null ? '' : JSON.stringify(response),
    model: PUBLIC_HELP_MODEL,
    promptTokens: typeof result.usage?.prompt_tokens === 'number' ? result.usage.prompt_tokens : null,
    outputTokens: typeof result.usage?.completion_tokens === 'number' ? result.usage.completion_tokens : null,
  }
}
