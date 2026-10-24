import type { BlogLifecycleState, BlogPostRepository, BlogPost, BlogPostCreateInput, BlogPostUpdateInput } from './types'
import {
  isBlogLifecycleResponse,
  isBlogPostResponse,
  isCreatedBlogPostResponse,
  isSuccessResponse,
} from './blog-response-contracts'
import { dashboardFetch } from '~/composables/dashboardFetch'

interface TenantBlogRepositoryOptions {
  organizationId: string
}

export function tenantBlogRepository({ organizationId, orgSlug }: TenantBlogRepositoryOptions & { orgSlug: string }): BlogPostRepository {
  const baseUrl = `/api/editor/organizations/${organizationId}/blog`
  const dashboardBaseUrl = `/dashboard/${orgSlug}/website/blog`
  const scope = { orgSlug }
  return {
    listUrl: dashboardBaseUrl,
    editUrl: postId => `${dashboardBaseUrl}/${postId}`,

    async create(input: BlogPostCreateInput): Promise<BlogPost & { id: string }> {
      const res = await dashboardFetch<{ id: string; post: BlogPost }>(`${baseUrl}/posts`, scope, {
        method: 'POST',
        body: input,
        validate: isCreatedBlogPostResponse,
      })
      return { ...res.post, id: res.id }
    },

    async update(postId: string, input: BlogPostUpdateInput): Promise<BlogPost> {
      const res = await dashboardFetch<{ post: BlogPost }>(`${baseUrl}/${postId}`, scope, {
        method: 'PATCH',
        body: input,
        validate: isBlogPostResponse,
      })
      return res.post
    },

    async delete(postId: string): Promise<void> {
      await dashboardFetch(`${baseUrl}/${postId}`, scope, { method: 'DELETE', validate: isSuccessResponse })
    },

    async publish(postId: string, input): Promise<BlogPost> {
      await dashboardFetch<{ success: true; lifecycle: BlogLifecycleState }>(
        `/api/editor/organizations/${organizationId}/blog/${postId}/publish`,
        scope,
        { method: 'POST', body: input, validate: isBlogLifecycleResponse },
      )
      const response = await dashboardFetch<{ post: BlogPost }>(`${baseUrl}/${postId}`, scope, { validate: isBlogPostResponse })
      return response.post
    },

  }
}
