export interface McpStructuredResponse {
  __mcpStructuredResponse: true
  structuredContent: unknown
  modelText?: string
  privateMeta?: Record<string, unknown>
  isError?: boolean
}

export function renderStructuredResponse(
  structuredContent: unknown,
  modelText?: string,
  privateMeta?: Record<string, unknown>,
  isError = false,
): McpStructuredResponse {
  return { __mcpStructuredResponse: true, structuredContent, modelText, privateMeta, isError }
}

export function isMcpRenderResponse(value: unknown): value is McpStructuredResponse {
  return (
    typeof value === 'object'
    && value !== null
    && (value as Record<string, unknown>).__mcpStructuredResponse === true
    && 'structuredContent' in value
  )
}
