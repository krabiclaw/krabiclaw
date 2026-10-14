const PUBLIC_HELP_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast'

interface WorkersAiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface WorkersAiResponse {
  response?: string
}

export async function runWorkersAiText(
  env: ApiRecord,
  messages: WorkersAiMessage[],
  options: {
    maxTokens?: number
    temperature?: number
  } = {},
) {
  const ai = env.AI as { run: (_model: string, _input: ApiRecord) => Promise<WorkersAiResponse> } | undefined
  if (!ai?.run) {
    throw new Error('Workers AI binding is not available')
  }

  const result = await ai.run(PUBLIC_HELP_MODEL, {
    messages,
    max_tokens: options.maxTokens ?? 700,
    temperature: options.temperature ?? 0.2,
  })
  return result.response?.trim() ?? ''
}
