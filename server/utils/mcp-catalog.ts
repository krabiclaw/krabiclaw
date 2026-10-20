import { createHash } from 'node:crypto'

export interface McpCatalogToolSnapshot {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: object
  securitySchemes?: object[]
}

function compareCodePoint(a: string, b: string) {
  const left = Array.from(a)
  const right = Array.from(b)
  const length = Math.min(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const delta = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0)
    if (delta !== 0) return delta
  }
  return left.length - right.length
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compareCodePoint(a, b))
      .map(([key, nested]) => [key, sortValue(nested)]),
  )
}

export function canonicalCatalogSnapshot(tools: McpCatalogToolSnapshot[]) {
  return tools
    .map(tool => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: sortValue(tool.inputSchema) as Record<string, unknown>,
      outputSchema: sortValue(tool.outputSchema ?? {}) as Record<string, unknown>,
      ...(tool.annotations ? { annotations: sortValue(tool.annotations) } : {}),
      ...(tool.securitySchemes ? { securitySchemes: sortValue(tool.securitySchemes) } : {}),
    }))
    .sort((a, b) => compareCodePoint(a.name, b.name))
}

export function serializeCatalogSnapshot(tools: McpCatalogToolSnapshot[]) {
  return JSON.stringify(canonicalCatalogSnapshot(tools))
}

export function catalogFingerprint(tools: McpCatalogToolSnapshot[]) {
  const digest = createHash('sha256').update(serializeCatalogSnapshot(tools)).digest('hex')
  return `sha256:${digest}`
}

export function catalogMeta(tools: McpCatalogToolSnapshot[]) {
  return {
    'krabiclaw/catalogFingerprint': catalogFingerprint(tools),
  }
}
