const PUBLIC_HELP_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast'

interface WorkersAiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface WorkersAiResponse {
  response?: string
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
  return {
    text: result.response?.trim() ?? '',
    model: PUBLIC_HELP_MODEL,
    promptTokens: typeof result.usage?.prompt_tokens === 'number' ? result.usage.prompt_tokens : null,
    outputTokens: typeof result.usage?.completion_tokens === 'number' ? result.usage.completion_tokens : null,
  }
}
