import { cloudflareEnv, textResponse } from '~/server/utils/api-response'
import {
  getPublishedTenantBlogPostBySlug, renderTenantBlogMarkdown, resolvePublicOrigin, } from '~/server/utils/platform-llm'

/**
 * The markdown mirror of one blog article, for any site including KrabiClaw's.
 * KrabiClaw's used to answer at /blog-md/{category}/{slug}.md, because its
 * article path carried the category.
 */
export default defineHandler(async (event) => {
  if (!event.context.organizationId) return textResponse('Post not found\n', { status: 404 })

  const slugParam = getRouterParam(event, 'slug')
  const pathMatch = event.path?.match(/^\/blog-md\/(.+)\.md$/)
  const rawSlug = String(
    typeof slugParam === 'string' && slugParam.trim()
      ? slugParam
      : pathMatch?.[1]
      ?? '', ).trim()
  const slug = rawSlug.endsWith('.md') ? rawSlug.slice(0, -'.md'.length) : rawSlug
  if (!slug) return textResponse('Post not found\n', { status: 404 })

  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return textResponse('Database not available\n', { status: 500 })

  const post = await getPublishedTenantBlogPostBySlug(db, String(event.context.organizationId), slug, 'blog')
  if (!post) return textResponse('Post not found\n', { status: 404 })

  return textResponse(renderTenantBlogMarkdown(post, resolvePublicOrigin(event), { themeId: String(event.context.themeId ?? '') }), {}, 'text/markdown; charset=utf-8')
})
import { defineHandler } from 'nitro';
import { getRouterParam } from 'nitro/h3';
