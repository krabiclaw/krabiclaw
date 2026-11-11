import type { ArticleCollection } from '~/utils/article-collections'

/** One of a collection's categories, as the dashboard reads it. */
export interface DashboardArticleCategory {
  id: string
  collection: ArticleCollection
  name: string
  slug: string
  description: string | null
  /** The category it sits under; null at the top level. */
  parent_id: string | null
  /** Its place among its siblings. */
  sort_order: number
  article_count: number
  child_count: number
  created_at?: string | null
  updated_at?: string | null
}

const isCategory = (value: unknown): value is DashboardArticleCategory =>
  isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.slug === 'string'
  && (value.description === null || typeof value.description === 'string') && (value.parent_id === null || typeof value.parent_id === 'string')
  && typeof value.sort_order === 'number' && typeof value.article_count === 'number' && typeof value.child_count === 'number'
  && (value.created_at === undefined || value.created_at === null || typeof value.created_at === 'string')
  && (value.updated_at === undefined || value.updated_at === null || typeof value.updated_at === 'string')
export const isCategoriesResponse = (value: unknown): value is { categories: DashboardArticleCategory[] } =>
  isRecord(value) && Array.isArray(value.categories) && value.categories.every(isCategory)
export const isCategoryResponse = (value: unknown): value is { category: DashboardArticleCategory } =>
  isRecord(value) && isCategory(value.category)

/**
 * One collection's categories in the owner's order — what the post's Category
 * leaf picks from and the Categories list manages. Keyed by the collection, so
 * switching a post between the blog and the docs reads the other list.
 */
export function useArticleCategories(organizationId: string, collection: MaybeRefOrGetter<ArticleCollection>) {
  const dashboardApi = useDashboardApi()
  return useAsyncData(
    () => `article-categories:${organizationId}:${toValue(collection)}`,
    async () => (await dashboardApi(`/api/editor/organizations/${organizationId}/blog/categories`, {
      query: { collection: toValue(collection) }, validate: isCategoriesResponse,
    })).categories,
  )
}
