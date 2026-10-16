import { instantDate } from '~/utils/timezone'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { HTTPError } from 'nitro';
import type { H3Event } from 'nitro';
import {  getRequestHost } from 'nitro/h3';
import { queryAll, queryFirst, type DbClient } from '../db/index.ts'
import { getContentBlocksForDocument } from './content/documents.ts'
import { findAuthUsersByIds, type CloudflareEnv } from './auth.ts'
import { collectionArticlePath } from '../../utils/article-collections.ts'
import { tenantBlogPostPath } from '../../utils/tenant-blog-route.ts'
import { PLATFORM_TEMPLATE } from '../../utils/template-registry.ts'
import { blockVideo, youTubeVideoId, youTubeWatchUrl } from '../../shared/youtube-video.ts'
import { getPlatformOrganization } from './platform-organization.ts'
import { articleCategoryNameSql } from './content/article-categories.ts'
import { KRABICLAW_BUG_REPORT_URL, KRABICLAW_FEATURE_REQUEST_URL, KRABICLAW_REPOSITORY_URL } from '../../shared/open-source.ts'

/** A documentation page: an ordinary site page whose path starts with /docs. */
interface PlatformLlmDocSummary {
  id: string
  title: string
  slug: string
  category: string | null
  path: string
  excerpt?: string | null
  updated_at?: string | null
}

interface PlatformLlmDocDetail extends PlatformLlmDocSummary {
  content_blocks: LlmContentBlock[]
}

interface PlatformLlmBlogSummary {
  id: string
  title: string
  slug: string
  excerpt?: string | null
  category?: string | null
  published_at?: string | null
  updated_at?: string | null
  author_name?: string | null
}

interface PlatformLlmBlogDetail extends PlatformLlmBlogSummary {
  content_blocks: LlmContentBlock[]
}

interface LlmContentBlock {
  type: string
  position: number
  level: number | null
  data: Record<string, unknown>
  media: Array<{ public_url?: string | null; alt_text?: string | null; caption?: string | null }>
}

type TenantLlmBlogSummary = PlatformLlmBlogSummary

type TenantLlmBlogDetail = PlatformLlmBlogDetail

export interface PlatformLlmLinkEntry {
  title: string
  path: string
  markdownPath: string
  canonicalUrl: string
  summary: string
  category?: string | null
  publishedAt?: string | null
  updatedAt?: string | null
  authorName?: string | null
}

function normalizeWhitespace(value: string | null | undefined) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function escapeYamlString(value: string | null | undefined) {
  return JSON.stringify(String(value ?? ''))
}

function safeSummary(value: string | null | undefined, fallback: string) {
  const normalized = normalizeWhitespace(value)
  return normalized || fallback
}

function normalizePath(value: string) {
  return value.startsWith('/') ? value : `/${value}`
}

function absoluteUrl(origin: string, path: string) {
  return new URL(normalizePath(path), origin).toString()
}

function optionalFrontMatterLine(key: string, value: string | null | undefined) {
  const normalized = normalizeWhitespace(value)
  return normalized ? `${key}: ${escapeYamlString(normalized)}` : null
}

function serializeFaqMarkdown(block: LlmContentBlock) {
  const items = Array.isArray(block.data.items) ? block.data.items as Array<Record<string, unknown>> : []
  const validItems = items.filter(item => String(item.question || '').trim() && String(item.answer || '').trim())

  if (!validItems.length) return ''

  return [
    `## ${normalizeWhitespace(String(block.data.label || '')) || 'FAQ'}`,
    ...validItems.flatMap(item => [
      '',
      `### ${String(item.question).trim()}`,
      '',
      String(item.answer).trim(),
    ]),
  ].join('\n')
}

function serializeHowToMarkdown(block: LlmContentBlock) {
  const steps = Array.isArray(block.data.steps) ? block.data.steps as Array<Record<string, unknown>> : []
  const validSteps = steps.filter(step => String(step.name || '').trim() && String(step.text || '').trim())

  if (!validSteps.length) return ''

  const lines: string[] = [`## ${normalizeWhitespace(String(block.data.label || '')) || 'How To'}`]
  const estimatedTime = normalizeWhitespace(String(block.data.estimated_time || ''))
  const toolItems = (Array.isArray(block.data.tool_items) ? block.data.tool_items : []).map(item => normalizeWhitespace(String(item))).filter(Boolean)
  const supplyItems = (Array.isArray(block.data.supply_items) ? block.data.supply_items : []).map(item => normalizeWhitespace(String(item))).filter(Boolean)

  if (estimatedTime) {
    lines.push('', `Estimated time: ${estimatedTime}`)
  }
  if (toolItems.length) {
    lines.push('', '### Tools', '', ...toolItems.map(item => `- ${item}`))
  }
  if (supplyItems.length) {
    lines.push('', '### Supplies', '', ...supplyItems.map(item => `- ${item}`))
  }

  lines.push('')
  for (const [index, step] of validSteps.entries()) {
    lines.push(`${index + 1}. **${String(step.name).trim()}**`)
    lines.push('')
    lines.push(`   ${String(step.text).trim().replace(/\n/g, '\n   ')}`)
    if (String(step.url || '').trim()) lines.push(`   Link: ${String(step.url).trim()}`)
    lines.push('')
  }

  return normalizeWhitespace(lines.join('\n'))
}

function serializeAiAssistanceMarkdown(block: LlmContentBlock) {
  const prompts = Array.isArray(block.data.prompts) ? block.data.prompts as Array<Record<string, unknown>> : []
  const validPrompts = prompts.filter(item => String(item.prompt || '').trim())

  if (!validPrompts.length) return ''

  const lines: string[] = [`## ${normalizeWhitespace(String(block.data.label || '')) || 'AI Assistance'}`]
  const intro = normalizeWhitespace(String(block.data.intro || ''))
  if (intro) lines.push('', intro)

  for (const prompt of validPrompts) {
    const title = normalizeWhitespace(String(prompt.title || ''))
    const description = normalizeWhitespace(String(prompt.description || ''))
    if (title) lines.push('', `### ${title}`)
    if (description) lines.push('', description)
    lines.push('', '```text', String(prompt.prompt).trim(), '```')
  }

  return normalizeWhitespace(lines.join('\n'))
}

function literalMarkdown(value: unknown) {
  return String(value || '').trim().replace(/[\\`*_[\]{}()#+\-.!|<>&]/g, '\\$&')
}

export function renderContentBlocksForLlm(blocks: LlmContentBlock[]) {
  return normalizeWhitespace([...blocks].sort((a, b) => a.position - b.position).map((block) => {
    if (block.data.status === 'inactive' || block.data.render_enabled === false) return ''
    if (block.type === 'heading') return `${'#'.repeat(Math.max(1, Math.min(6, block.level || 2)))} ${String(block.data.text || '').trim()}`
    if (block.type === 'markdown') return String(block.data.markdown || '').trim()
    if (block.type === 'divider') return '---'
    if (block.type === 'faq') return serializeFaqMarkdown(block)
    if (block.type === 'how_to') return serializeHowToMarkdown(block)
    if (block.type === 'ai_assistance') return serializeAiAssistanceMarkdown(block)
    if (block.type === 'callout') {
      // Article callouts render title/body as literal text, including punctuation and line breaks.
      const title = literalMarkdown(block.data.title)
      const body = literalMarkdown(block.data.body)
      const content = [title ? `### ${title}` : '', body].filter(Boolean).join('\n\n')
      return content ? content.split('\n').map(line => `> ${line}`).join('\n') : ''
    }
    if (block.type === 'image' || block.type === 'gallery') {
      const images = block.media.map(item => item.public_url
        ? `![${literalMarkdown(item.alt_text)}](${item.public_url})${block.type === 'gallery' && item.caption ? `\n\n${literalMarkdown(item.caption)}` : ''}`
        : '').filter(Boolean).join('\n\n')
      return [images, block.type === 'image' ? literalMarkdown(block.data.caption) : ''].filter(Boolean).join('\n\n')
    }
    const video = blockVideo(block)
    if (video) {
      const videoId = youTubeVideoId(video.url)
      const name = typeof video.name === 'string' ? video.name.trim() : ''
      return videoId ? `${name ? `[${name}](${youTubeWatchUrl(videoId)})` : youTubeWatchUrl(videoId)}${typeof video.description === 'string' && video.description.trim() ? `\n\n${video.description.trim()}` : ''}` : ''
    }
    if (block.type === 'cta') return block.data.url ? `[${String(block.data.label || block.data.title || 'Learn more')}](${String(block.data.url)})` : ''
    return String(block.data.markdown || block.data.text || '')
  }).filter(Boolean).join('\n\n'))
}

function formatDateOnly(value: string | null | undefined) {
  if (!value) return null
  return instantDate(value).toISOString().slice(0, 10)
}

function buildFrontMatter(lines: Array<string | null>) {
  return `---\n${lines.filter(Boolean).join('\n')}\n---`
}

function docMarkdownPath(path: string) {
  return `/docs-md${path.slice('/docs'.length)}.md`
}

export function renderPlatformDocMarkdown(doc: PlatformLlmDocDetail, origin: string) {
  const path = doc.path
  const markdownPath = docMarkdownPath(path)
  const canonicalUrl = absoluteUrl(origin, path)
  const body = renderContentBlocksForLlm(doc.content_blocks)

  return [
    buildFrontMatter([
      optionalFrontMatterLine('title', doc.title),
      optionalFrontMatterLine('category', doc.category),
      optionalFrontMatterLine('url', path),
      optionalFrontMatterLine('markdown_url', markdownPath),
      optionalFrontMatterLine('canonical_url', canonicalUrl),
      optionalFrontMatterLine('last_updated', formatDateOnly(doc.updated_at)),
      optionalFrontMatterLine('type', 'documentation'),
      optionalFrontMatterLine('summary', doc.excerpt || ''),
    ]),
    '',
    `# ${doc.title}`,
    '',
    body,
  ].join('\n')
}

function renderBlogMarkdown(
  post: PlatformLlmBlogDetail,
  origin: string,
  paths: { path: string; markdownPath: string },
) {
  const { path, markdownPath } = paths
  const canonicalUrl = absoluteUrl(origin, path)
  const body = renderContentBlocksForLlm(post.content_blocks)

  return [
    buildFrontMatter([
      optionalFrontMatterLine('title', post.title),
      optionalFrontMatterLine('category', post.category),
      optionalFrontMatterLine('url', path),
      optionalFrontMatterLine('markdown_url', markdownPath),
      optionalFrontMatterLine('canonical_url', canonicalUrl),
      optionalFrontMatterLine('last_updated', formatDateOnly(post.updated_at)),
      optionalFrontMatterLine('published_at', formatDateOnly(post.published_at)),
      optionalFrontMatterLine('type', 'blog'),
      optionalFrontMatterLine('summary', post.excerpt || ''),
    ]),
    '',
    `# ${post.title}`,
    '',
    body,
  ].join('\n')
}

/** A site's template decides its article prefix (/blog or /article); the markdown mirror is always /blog-md. */
export function renderTenantBlogMarkdown(post: TenantLlmBlogDetail, origin: string, template: { themeId?: string | null; vertical?: string | null }) {
  const path = tenantBlogPostPath(template, post.slug)
  const markdownPath = `/blog-md/${post.slug}.md`
  return renderBlogMarkdown(post, origin, { path, markdownPath })
}

const DOC_SUMMARY_SELECT = `SELECT id, title, slug, ${articleCategoryNameSql('content_documents.id')} AS category, summary AS excerpt, updated_at
     FROM content_documents
     WHERE kind = 'article' AND row_role = 'root' AND status = 'published' AND visibility = 'listed'
       AND (metadata_json ->> '$.collection') = 'docs' AND organization_id = ?`

function withDocPath<T extends { slug: string }>(row: T): T & { path: string } {
  return { ...row, path: collectionArticlePath('docs', row.slug) }
}

/** A site's documentation: its `docs` article collection, in the order it is read. */
export async function listPublishedDocsForLlm(db: DbClient, organizationId: string): Promise<PlatformLlmDocSummary[]> {
  const rows = await queryAll<Omit<PlatformLlmDocSummary, 'path'>>(
    db, `${DOC_SUMMARY_SELECT} ORDER BY sort_order, published_at IS NULL, published_at DESC, created_at DESC, id DESC`, [organizationId],
  )
  return rows.map(withDocPath)
}

/** KrabiClaw's blog collection only; documentation has its own readers above. */
export async function listPublishedPlatformBlogPostsForLlm(db: DbClient, env: CloudflareEnv) {
  return listPublishedTenantBlogPostsForLlm(db, (await getPlatformOrganization(db)).id, env, 'blog')
}

export async function listPublishedTenantBlogPostsForLlm(db: DbClient, organizationId: string, env: CloudflareEnv, collection?: 'blog' | 'docs') {
  const posts = await queryAll<TenantLlmBlogSummary & { author_id: string | null }>(
    db,
    `SELECT
      p.id, p.title, p.slug, p.summary AS excerpt, ${articleCategoryNameSql('p.id')} AS category, p.published_at, p.updated_at, p.author_id
     FROM content_documents p
     WHERE p.kind = 'article' AND p.row_role = 'root' AND p.status = 'published' AND p.organization_id = ? AND p.visibility = 'listed'
       ${collection ? "AND (p.metadata_json ->> '$.collection') = ?" : ''}
     ORDER BY p.published_at DESC, p.updated_at DESC`,
    collection ? [organizationId, collection] : [organizationId],
  )
  const authors = await findAuthUsersByIds(env, posts.map(post => post.author_id))
  return posts.map(({ author_id: authorId, ...post }) => ({
    ...post,
    author_name: (authorId ? authors.get(authorId)?.name : null) ?? null,
  }))
}

export async function getPublishedDocBySlug(db: DbClient, organizationId: string, slug: string): Promise<PlatformLlmDocDetail | null> {
  const row = await queryFirst<Omit<PlatformLlmDocSummary, 'path'>>(
    db, `${DOC_SUMMARY_SELECT} AND slug = ?`, [organizationId, slug],
  )
  if (!row) return null
  const detail = withDocPath(row)
  const contentBlocks = await getContentBlocksForDocument(db, detail.id)
  if (!contentBlocks) throw new HTTPError({ statusCode: 500, statusMessage: 'Documentation content document is missing' })
  return { ...detail, content_blocks: contentBlocks }
}

export async function getPublishedTenantBlogPostBySlug(db: DbClient, organizationId: string, slug: string, collection?: 'blog' | 'docs') {
  const detail = await queryFirst<Omit<TenantLlmBlogDetail, 'content_blocks'>>(
    db,
    `SELECT
      p.id, p.title, p.slug, p.summary AS excerpt, ${articleCategoryNameSql('p.id')} AS category, p.published_at, p.updated_at
     FROM content_documents p
     WHERE p.kind = 'article' AND p.row_role = 'root' AND p.slug = ? AND p.status = 'published' AND p.organization_id = ? AND p.visibility = 'listed'
       ${collection ? "AND (p.metadata_json ->> '$.collection') = ?" : ''}`,
    collection ? [slug, organizationId, collection] : [slug, organizationId],
  )
  if (!detail) return null
  const contentBlocks = await getContentBlocksForDocument(db, detail.id)
  if (!contentBlocks) throw new HTTPError({ statusCode: 500, statusMessage: 'Blog content document is missing' })
  return { ...detail, content_blocks: contentBlocks }
}

export function buildPlatformDocLinkEntries(docs: PlatformLlmDocSummary[], origin: string): PlatformLlmLinkEntry[] {
  return docs.map(doc => ({
      title: doc.title,
      path: doc.path,
      markdownPath: docMarkdownPath(doc.path),
      canonicalUrl: absoluteUrl(origin, doc.path),
      summary: safeSummary(doc.excerpt, 'KrabiClaw documentation.'),
      category: doc.category,
      updatedAt: doc.updated_at,
    }))
}

export function buildPlatformBlogLinkEntries(posts: PlatformLlmBlogSummary[], origin: string): PlatformLlmLinkEntry[] {
  // Sort by published date descending before serialization
  const sortedPosts = [...posts].sort((a, b) => {
    const aDate = a.published_at ? new Date(a.published_at).getTime() : 0
    const bDate = b.published_at ? new Date(b.published_at).getTime() : 0
    return bDate - aDate
  })
  return sortedPosts.flatMap((post) => {
    const path = `/blog/${post.slug}`
    return [{
      title: post.title,
      path,
      markdownPath: `/blog-md/${post.slug}.md`,
      canonicalUrl: absoluteUrl(origin, path),
      summary: safeSummary(post.excerpt, 'KrabiClaw platform blog article.'),
      category: post.category,
      publishedAt: post.published_at,
      updatedAt: post.updated_at,
      authorName: post.author_name,
    }]
  })
}

export function buildTenantBlogLinkEntries(posts: TenantLlmBlogSummary[], origin: string, template: { themeId?: string | null; vertical?: string | null }): PlatformLlmLinkEntry[] {
  const sortedPosts = [...posts].sort((a, b) => {
    const aDate = a.published_at ? new Date(a.published_at).getTime() : 0
    const bDate = b.published_at ? new Date(b.published_at).getTime() : 0
    return bDate - aDate
  })
  return sortedPosts.map((post) => {
    const path = tenantBlogPostPath(template, post.slug)
    return {
      title: post.title,
      path,
      markdownPath: `/blog-md/${post.slug}.md`,
      canonicalUrl: absoluteUrl(origin, path),
      summary: safeSummary(post.excerpt, 'Published blog article.'),
      category: post.category,
      publishedAt: post.published_at,
      updatedAt: post.updated_at,
      authorName: post.author_name,
    }
  })
}

interface LlmsTxtOptions {
  title?: string
  intro?: string
  docsHeading?: string
  blogHeading?: string
  coreHeading?: string
  coreLinks?: Array<{ title: string; path: string; description: string }>
  includeDocsOptionalLinks?: boolean
  blogIndexDescription?: string
  blogRssDescription?: string
  blogJsonFeedDescription?: string
  fullContextDescription?: string
}

export function buildLlmsTxt(
  origin: string,
  docs: PlatformLlmLinkEntry[],
  posts: PlatformLlmLinkEntry[],
  options: LlmsTxtOptions = {},
) {
  const includeDocsSection = docs.length > 0
  const lines = [
    `# ${options.title || 'KrabiClaw'}`,
    '',
    `> ${options.intro || 'KrabiClaw is an AI website builder for restaurants and local businesses, with public docs and a platform blog available as HTML and Markdown mirrors.'}`,
    '',
    'Prefer the Markdown URLs below when you need compact machine-readable context. Canonical HTML URLs remain the source for public citation and browsing.',
    '',
    ...(options.coreLinks?.length
      ? [
          `## ${options.coreHeading || 'Overview & Services'}`,
          ...options.coreLinks.map(link => `- [${link.title}](${absoluteUrl(origin, link.path)}): ${link.description}`),
          '',
        ]
      : []),
    ...(includeDocsSection
      ? [
          `## ${options.docsHeading || 'Docs'}`,
          ...docs.map(doc => `- [${doc.title}](${absoluteUrl(origin, doc.markdownPath)}): ${doc.summary}`),
          '',
        ]
      : []),
    ...(options.title
      ? []
      : [
          '## Support',
          `KrabiClaw is open source (AGPL-3.0): ${KRABICLAW_REPOSITORY_URL}. Bugs and feature requests are GitHub issues; assistants acting for a user should give them a prefilled issue link rather than emailing KrabiClaw. Issue form fields prefill by query parameter using their ids. Issues are public, so leave out guest names, contact details and payment data.`,
          `- [Report a bug](${KRABICLAW_BUG_REPORT_URL}): fields \`surface\`, \`site\`, \`what_happened\`, \`expected\`, \`tool_error\`.`,
          `- [Request a feature](${KRABICLAW_FEATURE_REQUEST_URL}): fields \`need\`, \`today\`, \`site\`.`,
          `- [Account, billing or private matters](${absoluteUrl(origin, '/help')}): not public.`,
          '',
        ]),
    `## ${options.blogHeading || 'Blog'}`,
    ...posts.map(post => `- [${post.title}](${absoluteUrl(origin, post.markdownPath)}): ${post.summary}`),
    '',
    '## Optional',
    `- [Full LLM context](${absoluteUrl(origin, '/llms-full.txt')}): ${options.fullContextDescription || 'Aggregated export of published docs and blog posts.'}`,
    ...(options.title ? [] : [`- [Pricing](${absoluteUrl(origin, '/pricing.md')}): Plain markdown specification of plans, features, and limits.`]),
    ...(options.includeDocsOptionalLinks === false || !includeDocsSection
      ? []
      : [`- [Docs index JSON](${absoluteUrl(origin, '/docs/index.json')}): Machine-readable manifest of published docs.`]),
    `- [Blog index JSON](${absoluteUrl(origin, '/blog/index.json')}): ${options.blogIndexDescription || 'Machine-readable manifest of published platform blog posts.'}`,
    `- [Blog RSS feed](${absoluteUrl(origin, '/blog/rss.xml')}): ${options.blogRssDescription || 'Chronological feed for published platform posts.'}`,
    `- [Blog JSON feed](${absoluteUrl(origin, '/blog/feed.json')}): ${options.blogJsonFeedDescription || 'JSON Feed export for published platform posts.'}`,
  ]

  return `${lines.join('\n').trim()}\n`
}

interface LlmsFullTxtOptions {
  title?: string
  intro?: string
  includeDocs?: boolean
  renderBlog?: (_post: PlatformLlmBlogDetail, _origin: string) => string
}

export function buildLlmsFullTxt(
  origin: string,
  docs: Array<PlatformLlmDocDetail>,
  posts: Array<PlatformLlmBlogDetail>,
  options: LlmsFullTxtOptions = {},
) {
  const includeDocs = options.includeDocs !== false
  const lines: string[] = [
    `# ${options.title || 'KrabiClaw Full LLM Context'}`,
    '',
    `> ${options.intro || 'Full machine-readable export of KrabiClaw\'s published platform docs and platform blog.'}`,
    '',
    `Source organization: ${origin}`,
  ]

  if (includeDocs) {
    lines.push('', '## Docs')
    for (const doc of docs) {
      lines.push('', renderPlatformDocMarkdown(doc, origin), '')
    }
  }

  lines.push('## Blog')
  const renderBlog = options.renderBlog || ((post: PlatformLlmBlogDetail, postOrigin: string) => renderTenantBlogMarkdown(post, postOrigin, PLATFORM_TEMPLATE))

  for (const post of posts) {
    lines.push('', renderBlog(post, origin), '')
  }

  return `${normalizeWhitespace(lines.join('\n'))}\n`
}

export function buildDocsIndexJson(docs: PlatformLlmLinkEntry[]) {
  return {
    docs: docs.map(doc => ({
      title: doc.title,
      category: doc.category ?? null,
      url: doc.path,
      markdown_url: doc.markdownPath,
      canonical_url: doc.canonicalUrl,
      summary: doc.summary,
      updated_at: doc.updatedAt ?? null,
    })),
  }
}

export function buildBlogIndexJson(posts: PlatformLlmLinkEntry[]) {
  return {
    posts: posts.map(post => ({
      title: post.title,
      category: post.category ?? null,
      url: post.path,
      markdown_url: post.markdownPath,
      canonical_url: post.canonicalUrl,
      summary: post.summary,
      published_at: post.publishedAt ?? null,
      updated_at: post.updatedAt ?? null,
    })),
  }
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildBlogRss(origin: string, posts: PlatformLlmLinkEntry[]) {
  const title = 'KrabiClaw Blog'
  const description = 'KrabiClaw platform blog feed.'
  return buildNamedBlogRss(origin, posts, { title, description })
}

interface BlogFeedOptions {
  title?: string
  description?: string
}

export function buildNamedBlogRss(origin: string, posts: PlatformLlmLinkEntry[], options: BlogFeedOptions = {}) {
  const latestPostDate = posts
    .map(post => post.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1)

  const items = posts.map((post) => {
    const pubDate = post.publishedAt == null ? null : instantDate(post.publishedAt).toUTCString()
    return [
      '<item>',
      `<title>${escapeXml(post.title)}</title>`,
      `<link>${escapeXml(post.canonicalUrl)}</link>`,
      `<guid>${escapeXml(post.canonicalUrl)}</guid>`,
      `<description>${escapeXml(post.summary)}</description>`,
      pubDate === null ? '' : `<pubDate>${escapeXml(pubDate)}</pubDate>`,
      '</item>',
    ].join('')
  }).join('')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '<channel>',
    `<title>${escapeXml(options.title || 'KrabiClaw Blog')}</title>`,
    `<link>${escapeXml(absoluteUrl(origin, '/blog'))}</link>`,
    `<description>${escapeXml(options.description || 'KrabiClaw platform blog feed.')}</description>`,
    latestPostDate ? `<lastBuildDate>${escapeXml(new Date(latestPostDate).toUTCString())}</lastBuildDate>` : '',
    items,
    '</channel>',
    '</rss>',
  ].filter(Boolean).join('')
}

export function buildBlogJsonFeed(origin: string, posts: PlatformLlmLinkEntry[]) {
  return buildNamedBlogJsonFeed(origin, posts)
}

export function buildNamedBlogJsonFeed(origin: string, posts: PlatformLlmLinkEntry[], options: BlogFeedOptions = {}) {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: options.title || 'KrabiClaw Blog',
    home_page_url: absoluteUrl(origin, '/blog'),
    feed_url: absoluteUrl(origin, '/blog/feed.json'),
    description: options.description || 'KrabiClaw platform blog feed.',
    items: posts.map(post => ({
      id: post.canonicalUrl,
      url: post.canonicalUrl,
      title: post.title,
      summary: post.summary,
      date_published: post.publishedAt ?? null,
      date_modified: post.updatedAt ?? null,
      ...(post.authorName ? { authors: [{ name: post.authorName }] } : {}),
      tags: post.category ? [post.category] : [],
    })),
  }
}

export function resolvePublicOrigin(event: H3Event) {
  if (event.context.tenantType === 'tenant') {
    const tenantHost = String(
      event.context.tenantHost
      || getRequestHost(event, { xForwardedHost: true })
      || (event.req.headers.get('host'))
      || ''
    ).split(':')[0]
    if (!tenantHost) {
      throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant host not resolved' })
    }
    const forwardedProto = (event.req.headers.get('x-forwarded-proto'))
    const protocol = forwardedProto?.split(',')[0]?.trim()
      || (tenantHost.endsWith('.localhost') || tenantHost === 'localhost' ? 'http' : 'https')
    return `${protocol}://${tenantHost}`
  }

  const runtimeConfig = useRuntimeConfig()
  const origin = runtimeConfig.public.siteUrl
  if (!origin) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'runtimeConfig.public.siteUrl is not configured' })
  }
  return origin.replace(/\/$/, '')
}
