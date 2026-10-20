<template>
  <div>
    <DashboardListEditor
      v-model:editing="editing"
      title="Blog"
      :items="listItems"
      :error="loadError"
      empty-title="No posts yet"
      empty-icon="i-lucide-newspaper"
      add-label="Write a post"
      :removing-id="removingId"
      :reorderable="orderedCollection !== null"
      :add-to="blogCreatePath(orgSlug)"
      @remove="removePost"
      @move="moveArticle"
    >
      <template #actions>
        <UButton label="Categories" icon="i-lucide-folder" color="neutral" variant="soft" :to="`${level.path.value}/categories`" data-testid="blog-categories-link" />
      </template>
      <template #filters>
        <DashboardFilterPills id="blog-filter" v-model="activeTab" label="Post status" :items="statusTabs" />
      </template>

      <template #item="{ item }">
        <span class="flex w-full items-center gap-4 text-left" :data-testid="`blog-post-${item.id}`">
          <!--
            The picture leads, and a post without one keeps the same footprint so
            the list does not reflow between rows that have one and rows that do not.
          -->
          <span class="size-12 shrink-0 overflow-hidden rounded-lg bg-muted">
            <img v-if="coverUrl(item.row)" :src="coverUrl(item.row)!" :alt="coverAlt(item.row)" class="h-full w-full object-cover">
            <span v-else class="flex h-full w-full items-center justify-center">
              <UIcon name="i-lucide-newspaper" class="size-4 text-muted" />
            </span>
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-semibold text-highlighted">{{ item.title }}</span>
            <span class="mt-1 block truncate text-sm text-muted">{{ item.summary }}</span>
          </span>
        </span>
      </template>
    </DashboardListEditor>
    <div v-if="nextCursor" class="mt-4 flex justify-center">
      <UButton color="neutral" variant="outline" :loading="loadingMore" @click="loadMore">Load more posts</UButton>
    </div>
    <UAlert v-if="orderError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="orderError" />

  </div>
</template>

<script setup lang="ts">
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import { ARTICLE_COLLECTIONS, ARTICLE_COLLECTION_SLUGS, isArticleCollection, type ArticleCollection } from '~/utils/article-collections'
import { tenantBlogRepository } from '~/lib/components/workspace/blog/tenantBlogRepository'
import type { BlogPost } from '~/lib/components/workspace/blog/types'
import { blogCreatePath } from '~/server/utils/dashboard-links'
import { getErrorMessage } from '~/utils/errors'
import { mediaStillUrl } from '~/shared/media-placement-contract'

// The blog index. Rendered by `blog.vue`, which owns the frame.
const dashboardApi = useDashboardApi()
const route = useRoute()
const organizationId = await useDashboardOrganizationId()
const orgSlug = route.params.orgSlug as string
const level = useRouteLevel()

const repository = tenantBlogRepository({ organizationId, orgSlug })

// A post's life in order, so the tabs read as the pipeline they are. Drafts
// exist as a status now, and a post created from this list starts as one.
// Then the site's two collections, its blog and its docs: each is read in the
// order it lists in, and its tab is where that order is set.
const statusTabs = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'published', label: 'Live' },
  ...ARTICLE_COLLECTION_SLUGS.map(slug => ({ value: slug, label: ARTICLE_COLLECTIONS[slug].label })),
]
const activeTab = ref('all')
const editing = ref(false)
const removingId = ref<string | null>(null)

type BlogPage = { posts: BlogPost[]; page_info: { has_more: boolean; next_cursor: string | null } }
const isPostsResponse = (value: unknown): value is BlogPage =>
  isRecord(value)
  && Array.isArray(value.posts)
  && value.posts.every(post => isRecord(post) && typeof post.id === 'string' && typeof post.title === 'string')
  && isRecord(value.page_info)
  && typeof value.page_info.has_more === 'boolean'
  && (value.page_info.next_cursor === null || typeof value.page_info.next_cursor === 'string')

// The tab is a filter the database applies, a page at a time. A collection
// tab reads every article in that collection, in the order it lists in,
// because a new order names all of them.
const orderedCollection = computed<ArticleCollection | null>(() => isArticleCollection(activeTab.value) ? activeTab.value : null)
const statusFilter = computed(() => (activeTab.value === 'all' || orderedCollection.value ? undefined : String(activeTab.value)))
const fetchPage = (cursor?: string) => dashboardApi<BlogPage>(`/api/editor/organizations/${organizationId}/blog/posts`, {
  query: {
    ...(statusFilter.value ? { status: statusFilter.value } : {}),
    ...(orderedCollection.value ? { collection: orderedCollection.value, limit: 100 } : {}),
    ...(cursor ? { cursor } : {}),
  },
  validate: isPostsResponse,
})
async function fetchFirst(): Promise<BlogPage> {
  const first = await fetchPage()
  if (!orderedCollection.value) return first
  const posts = [...first.posts]
  let info = first.page_info
  while (info.has_more && info.next_cursor) {
    const next = await fetchPage(info.next_cursor)
    posts.push(...next.posts)
    info = next.page_info
  }
  return { posts, page_info: info }
}
const { data, error, refresh } = await useAsyncData(
  () => `dashboard-blog-posts:${organizationId}:${orderedCollection.value ?? statusFilter.value ?? 'all'}`,
  fetchFirst,
)

const loadError = computed(() => (error.value ? getErrorMessage(error.value, 'Failed to load posts') : null))
const nextCursor = computed(() => (data.value?.page_info.has_more ? data.value.page_info.next_cursor : null))
const loadingMore = ref(false)
async function loadMore() {
  const base = data.value
  if (!base || !nextCursor.value) return
  loadingMore.value = true
  try {
    const page = await fetchPage(nextCursor.value)
    // A page fetched for the list that was showing is dropped if the tab changed meanwhile.
    if (data.value !== base) return
    data.value = { posts: [...base.posts, ...page.posts], page_info: page.page_info }
  } finally {
    loadingMore.value = false
  }
}
const loadedPosts = computed(() => data.value?.posts ?? [])
const collectionOrder = computed(() => localOrder.value?.collection === orderedCollection.value ? localOrder.value.posts : loadedPosts.value)
const visiblePosts = computed(() => (orderedCollection.value ? collectionOrder.value : loadedPosts.value))

const listItems = computed(() => visiblePosts.value.map(row => ({
  id: row.id,
  title: row.title.trim() || 'Untitled post',
  summary: postSummary(row),
  to: `${level.path.value}/${row.id}`,
  row,
})))

const STATUS_LABELS: Record<string, string> = { draft: 'Draft', published: 'Live' }

/** Where it is in its life, then what it is filed under, then one date. */
function postSummary(post: BlogPost): string {
  // Read from the status rather than treating anything unscheduled as live: a
  // draft was announcing itself as published on the row and in the index.
  const parts: string[] = [post.status ? STATUS_LABELS[post.status] ?? post.status : 'Live']
  // The blog is implied; a doc says it is one.
  if (post.collection && post.collection !== 'blog') parts.push(ARTICLE_COLLECTIONS[post.collection].label)
  if (post.category) parts.push(post.category.name)
  parts.push(postWhen(post))
  return parts.filter(Boolean).join(' · ')
}

function postWhen(post: BlogPost): string {
  if (post.published_at) return formatDate(post.published_at)
  return post.updated_at ? `Edited ${formatDate(post.updated_at)}` : ''
}

function coverUrl(post: BlogPost): string | null {
  if (!post.cover) return null
  // The thumbnail is a scaled-down duplicate of the same asset, so it is the
  // right source for a row; the full image is only fetched where it shows big.
  return mediaStillUrl(post.cover)
}

/** The cover's description belongs to the asset; the headline is already beside it. */
function coverAlt(post: BlogPost): string {
  return post.cover?.alt_text ?? ''
}

function formatDate(iso: string) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Collection order ────────────────────────────────────
// Moves are held on the list while it is in its edit state and written, whole,
// when the edit state closes — the way a menu's collections are reordered.
// The moves not yet written, and the collection they belong to.
const localOrder = ref<{ collection: ArticleCollection; posts: BlogPost[] } | null>(null)
const orderError = ref<string | null>(null)

function moveArticle(item: { row: BlogPost }, direction: -1 | 1) {
  const order = [...collectionOrder.value]
  const from = order.findIndex(post => post.id === item.row.id)
  const to = from + direction
  if (from < 0 || to < 0 || to >= order.length) return
  ;[order[from], order[to]] = [order[to]!, order[from]!]
  if (orderedCollection.value) localOrder.value = { collection: orderedCollection.value, posts: order }
}

// A failed write keeps the moves, still shown on their own tab, for the next Done to retry.
async function commitOrder() {
  const pending = localOrder.value
  if (!pending) return
  orderError.value = null
  try {
    await dashboardApi(`/api/editor/organizations/${organizationId}/blog/order`, {
      method: 'PUT',
      body: { collection: pending.collection, post_ids: pending.posts.map(post => post.id) },
      validate: isRecord,
    })
    if (localOrder.value === pending) localOrder.value = null
  } catch (error) {
    orderError.value = getErrorMessage(error, 'Failed to save the new order')
  }
  await refresh()
}

watch(editing, (value, previous) => {
  if (previous && !value) void commitOrder()
})
// Leaving a collection's tab mid-edit writes the moves made there, rather than dropping them.
watch(activeTab, () => { void commitOrder() })

/** Removal lives in the list's edit state, the way every other list does it. */
async function removePost(item: { id: string }) {
  removingId.value = item.id
  try {
    await repository.delete(item.id)
    // A deleted article leaves the order being edited too, or the order written
    // on Done would name an article that no longer exists and be refused whole.
    if (localOrder.value) localOrder.value = { ...localOrder.value, posts: localOrder.value.posts.filter(post => post.id !== item.id) }
    await refresh()
  } finally {
    removingId.value = null
  }
}
</script>
