#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

register('../tests/unit/support/alias-hooks.mjs', import.meta.url)

const [
  { catalogFingerprint },
  { MCP_PUBLIC_TOOLS, MCP_TOOLS },
  { MCP_PROMPTS, renderMcpPrompt, referencedMcpTools },
  { mcpDocumentationToolContract, mcpDocumentationFingerprint },
] = await Promise.all([
  import('../server/utils/mcp-catalog.ts'),
  import('../server/utils/mcp-tools/index.ts'),
  import('../server/utils/mcp-prompts.ts'),
  import('../server/utils/mcp-documentation.ts'),
])

const root = fileURLToPath(new URL('..', import.meta.url))
const snapshotFile = path.join(root, 'server/utils/mcp-catalog-snapshots/tenant.json')
function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function documentationDependencies(text, tools, previousTools = []) {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const names = referencedMcpTools(text, [...byName.keys()], previousTools.map(tool => tool.name))
  for (const [, anchor] of text.matchAll(/mcp-tool-reference(?:\.md)?#([a-zA-Z0-9_-]+)/g)) {
    if (!byName.has(anchor)) throw new Error(`Unknown MCP tool reference anchor: ${anchor}`)
    names.push(anchor)
  }
  return Object.fromEntries([...new Set(names)].sort().map(name => [name, mcpDocumentationFingerprint([byName.get(name)])]))
}

export function promptSnapshots(tools, previousTools = []) {
  return MCP_PROMPTS.map(prompt => {
    const args = Object.fromEntries(prompt.arguments.map(argument => [argument.name, `<${argument.name}>`]))
    const rendered = renderMcpPrompt(prompt.name, args)
    let toolContracts
    try {
      toolContracts = documentationDependencies(rendered.text, tools, previousTools)
    } catch (error) {
      throw new Error(`Runtime workflow ${prompt.name}: ${error.message}`, { cause: error })
    }
    return {
      ...prompt,
      rendered,
      toolContracts,
    }
  })
}

export function catalogSnapshot(tools, previous) {
  return {
    surface: 'tenant',
    fingerprint: catalogFingerprint(tools),
    documentationFingerprint: mcpDocumentationFingerprint(tools),
    tools: tools.map(mcpDocumentationToolContract).sort((a, b) => a.name.localeCompare(b.name)),
    prompts: promptSnapshots(tools, previous?.tools),
  }
}

async function main() {
  const args = process.argv.slice(2)
  for (const arg of args) if (arg !== '--write') throw new Error(`Unknown catalog argument: ${arg}`)
  const mode = args.includes('--write') ? '--write' : '--check'

  const previous = existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, 'utf8')) : null
  const dispatchNames = new Set(MCP_TOOLS.map(tool => tool.name))
  const failures = []
  for (const tool of MCP_PUBLIC_TOOLS) {
    if (typeof tool.description !== 'string' || !tool.description.trim()) failures.push(`tenant: ${tool.name} needs a nonempty description`)
    if (!dispatchNames.has(tool.name)) failures.push(`tenant: public tool ${tool.name} is absent from dispatch`)
    // ChatGPT's connector matches a pattern against the whole value; JSON Schema finds it anywhere. Only a
    // pattern anchored at both ends means the same to both: '\S' refused every ID longer than one character.
    JSON.stringify([tool.inputSchema, tool.outputSchema], (key, value) => {
      if (key === 'pattern' && typeof value === 'string' && !(value.startsWith('^') && value.endsWith('$'))) failures.push(`tenant: ${tool.name} has unanchored pattern ${JSON.stringify(value)}`)
      return value
    })
  }

  const generated = catalogSnapshot(MCP_PUBLIC_TOOLS, previous)
  if (generated.fingerprint !== catalogFingerprint([...MCP_PUBLIC_TOOLS].reverse())) failures.push('tenant: catalog fingerprint is not deterministic across tool order')

  if (mode === '--write') {
    if (!failures.length) {
      mkdirSync(path.dirname(snapshotFile), { recursive: true })
      writeFileSync(snapshotFile, json(generated))
      console.log('Wrote MCP catalog snapshot.')
    }
  } else if (!previous) {
    failures.push('tenant: missing catalog snapshot (run yarn mcp:catalog:write)')
  } else if (json(previous) !== json(generated)) {
    failures.push('tenant: catalog or runtime workflow snapshot drifted (run yarn mcp:catalog:write and review the diff)')
  }

  if (failures.length) throw new Error(`MCP tool catalog check failed:\n${failures.map(failure => `- ${failure}`).join('\n')}`)
  console.log('MCP tool catalog check passed.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
