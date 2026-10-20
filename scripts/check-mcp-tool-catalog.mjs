#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

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
export const PUBLIC_MCP_GUIDE_SLUGS = [
  'what-you-can-edit-through-chatgpt',
  'update-your-menu-with-an-ai-assistant',
  'manage-your-bookings',
  'add-photos-and-video',
  'publish-a-post',
  'handle-inquiries-and-reservation-requests',
]

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function contentHash(content) {
  // Host URLs and publication dates in the generated front matter differ
  // between environments. Equivalent screenshots may use different delivery
  // URLs; their alt text, optional title, captions and all prose stay reviewed.
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim()
    .replace(/(!\[(?:\\.|[^\]\\])*\]\()\s*(?:<[^>\r\n]+>|(?:\\.|[^\s)\\])+)(?=\s*(?:["']|\)))/g, '$1<image-delivery-url>')
  return `sha256:${createHash('sha256').update(body).digest('hex')}`
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

export function reviewPublicGuide(slug, markdown, tools, previousTools = []) {
  let toolContracts
  try {
    toolContracts = documentationDependencies(markdown, tools, previousTools)
  } catch (error) {
    throw new Error(`Public workflow ${slug}: ${error.message}`, { cause: error })
  }
  if (!Object.keys(toolContracts).length) throw new Error(`${slug}: guide must identify its MCP tool dependencies`)
  return { slug, contentHash: contentHash(markdown), toolContracts }
}

export function publicGuideReviewFailures(reviews, tools) {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const failures = []
  for (const slug of PUBLIC_MCP_GUIDE_SLUGS) {
    const review = reviews?.find(entry => entry.slug === slug)
    if (!review?.contentHash || !Object.keys(review.toolContracts ?? {}).length) {
      failures.push(`${slug}: missing public workflow review (review the published guide, then run yarn mcp:catalog --review-docs)`)
      continue
    }
    for (const [name, fingerprint] of Object.entries(review.toolContracts)) {
      const tool = byName.get(name)
      if (!tool) failures.push(`${slug}: reviewed guide references removed tool ${name}`)
      else if (fingerprint !== mcpDocumentationFingerprint([tool])) {
        failures.push(`${slug}: ${name} changed; update or explicitly review the published workflow and run yarn mcp:catalog --review-docs`)
      }
    }
  }
  for (const review of reviews ?? []) {
    if (!PUBLIC_MCP_GUIDE_SLUGS.includes(review.slug)) failures.push(`Unconfigured public workflow review: ${review.slug}`)
  }
  return failures
}

export function catalogSnapshot(tools, previous, publicDocumentation = previous?.publicDocumentation) {
  return {
    surface: 'tenant',
    fingerprint: catalogFingerprint(tools),
    documentationFingerprint: mcpDocumentationFingerprint(tools),
    tools: tools.map(mcpDocumentationToolContract).sort((a, b) => a.name.localeCompare(b.name)),
    prompts: promptSnapshots(tools, previous?.tools),
    publicDocumentation,
  }
}

async function readPublicMarkdown(baseUrl, slug) {
  const url = new URL(`/docs-md/${slug}.md`, baseUrl)
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (response.status !== 200) {
    const instruction = slug === 'mcp-tool-reference'
      ? ' Publish the canonical CMS article containing the MCP tool reference directive after deploying its resolver, then rerun the full live documentation check.'
      : ' Publish or repair this canonical CMS guide, then rerun the documentation check.'
    throw new Error(`${url}: expected HTTP 200, received ${response.status}.${instruction}`)
  }
  if (!response.headers.get('content-type')?.startsWith('text/markdown')) {
    throw new Error(`${url}: expected public Markdown, received ${response.headers.get('content-type')}`)
  }
  const markdown = await response.text()
  if (!/^# .+/m.test(markdown)) throw new Error(`${url}: missing documentation title`)
  return markdown
}

async function main() {
  const args = process.argv.slice(2)
  const mode = args.find(arg => ['--write', '--review-docs', '--check-live-docs'].includes(arg)) ?? '--check'
  if (args.filter(arg => ['--write', '--review-docs', '--check-live-docs'].includes(arg)).length > 1) {
    throw new Error('Choose one catalog action: --write, --review-docs or --check-live-docs')
  }
  const baseUrlIndex = args.indexOf('--base-url')
  const baseUrl = baseUrlIndex === -1 ? 'https://krabiclaw.com' : args[baseUrlIndex + 1]
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--base-url' && args[index + 1]) { index += 1; continue }
    if (!['--write', '--review-docs', '--check', '--check-live-docs'].includes(args[index])) throw new Error(`Unknown catalog argument: ${args[index]}`)
  }
  if (baseUrlIndex !== -1 && !['--review-docs', '--check-live-docs'].includes(mode)) {
    throw new Error('--base-url applies only to --review-docs or --check-live-docs')
  }

  const previous = existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, 'utf8')) : null
  const dispatchNames = new Set(MCP_TOOLS.map(tool => tool.name))
  const failures = []
  for (const tool of MCP_PUBLIC_TOOLS) {
    if (typeof tool.description !== 'string' || !tool.description.trim()) failures.push(`tenant: ${tool.name} needs a nonempty description`)
    if (!dispatchNames.has(tool.name)) failures.push(`tenant: public tool ${tool.name} is absent from dispatch`)
  }

  let reviews = previous?.publicDocumentation
  if (mode === '--review-docs' || mode === '--check-live-docs') {
    const liveReviews = await Promise.all(PUBLIC_MCP_GUIDE_SLUGS.map(async slug => {
      const markdown = await readPublicMarkdown(baseUrl, slug)
      return reviewPublicGuide(slug, markdown, MCP_PUBLIC_TOOLS, previous?.tools)
    }))
    if (mode === '--review-docs') reviews = liveReviews
    else {
      for (const review of liveReviews) {
        const reviewed = reviews?.find(entry => entry.slug === review.slug)
        if (json(review) !== json(reviewed)) failures.push(`${review.slug}: deployed guide differs from the reviewed content or tool dependencies`)
      }
      const reference = await readPublicMarkdown(baseUrl, 'mcp-tool-reference')
      const fingerprint = reference.match(/Reference fingerprint:\s*`(sha256:[a-f0-9]{64})`/)?.[1]
      if (fingerprint !== mcpDocumentationFingerprint(MCP_PUBLIC_TOOLS)) failures.push('Deployed MCP tool reference fingerprint differs from the canonical registry')
      if (!reference.includes(`Tools: ${MCP_PUBLIC_TOOLS.length}.`)) failures.push('Deployed MCP tool reference count differs from the canonical registry')
    }
  }

  failures.push(...publicGuideReviewFailures(reviews, MCP_PUBLIC_TOOLS))
  const generated = catalogSnapshot(MCP_PUBLIC_TOOLS, previous, reviews)
  if (generated.fingerprint !== catalogFingerprint([...MCP_PUBLIC_TOOLS].reverse())) failures.push('tenant: catalog fingerprint is not deterministic across tool order')

  if (mode === '--write' || mode === '--review-docs') {
    if (!failures.length) {
      mkdirSync(path.dirname(snapshotFile), { recursive: true })
      writeFileSync(snapshotFile, json(generated))
      console.log(`Wrote MCP catalog snapshot${mode === '--review-docs' ? ' and explicitly reviewed public workflows' : ''}.`)
    }
  } else if (!previous) {
    failures.push('tenant: missing catalog snapshot (run yarn mcp:catalog:write)')
  } else if (json(previous) !== json(generated)) {
    failures.push('tenant: catalog or runtime workflow snapshot drifted (run yarn mcp:catalog:write and review the diff)')
  }

  if (failures.length) throw new Error(`MCP tool catalog check failed:\n${failures.map(failure => `- ${failure}`).join('\n')}`)
  console.log(mode === '--check-live-docs' ? 'Live MCP documentation check passed.' : 'MCP tool catalog check passed.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
