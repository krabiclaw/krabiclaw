import type { ArticleCollection } from '~/utils/article-collections'

export interface BlogPost {
  id: string
  title: string
  slug?: string | null
  excerpt?: string | null
  /** Which of the site's collections the article belongs to: its blog or its docs. */
  collection?: ArticleCollection | null
  category?: { id: string; name: string; slug: string } | null
  /** Its place in its collection, from 1; 0 until the collection is ordered with it in it. */
  sort_order: number
  seo_keywords?: string | null
  published_at?: string | null
  updated_at: string
  first_published_at?: string | null
  slug_manually_overridden?: boolean | number | null
  status?: 'draft' | 'published'
  visibility?: 'listed' | 'unlisted'
  /** The leading image block's asset, or null when the article opens with text. */
  cover?: { asset_id: string; public_url?: string | null; thumbnail_url?: string | null; kind?: string | null; alt_text?: string | null; width?: number | null; height?: number | null } | null
  edit_url?: string | null
  content_document?: {
    document: { id: string; updated_at: string }
    blocks: BlogEditorBlock[]
  } | null
  editor_template?: 'tenant' | 'platform'
  /** The site's light palette; null on the platform template. */
  editor_colors?: import('~/shared/site-palette').SitePaletteColors | null
  created_at?: string | null
  editor_organization_name?: string | null
  public_path?: string | null
}

export interface BlogEditorBlock {
  id?: string
  type: string
  position?: number
  level?: number | null
  parent_block_id?: string | null
  data: Record<string, unknown>
  media?: Array<{ asset_id: string; slot: string; sort_order?: number; public_url?: string | null; thumbnail_url?: string | null; kind?: string | null; alt_text?: string | null; caption?: string | null }>
  updated_at?: string
}

export interface BlogPostCreateInput {
  title: string
  slug?: string | null
  content_blocks: BlogEditorBlock[]
  excerpt?: string | null
  collection?: ArticleCollection | null
  category_id?: string
  seo_keywords?: string | null
  visibility?: 'listed' | 'unlisted'
  /** Made once per new article, so a retried create makes one. */
  idempotency_key: string
}

export interface BlogPostUpdateInput {
  title?: string
  excerpt?: string | null
  collection?: ArticleCollection | null
  category_id?: string
  seo_keywords?: string | null
  visibility?: 'listed' | 'unlisted'
  slug?: string | null
  redirect_old_slug?: boolean
  reset_slug_override?: boolean
  content_blocks?: BlogEditorBlock[]
  expected_updated_at?: string
}

export interface BlogLifecycleState {
  id: string
  status: 'draft' | 'published'
  published_at: string | null
  updated_at: string
  changed: boolean
}

export interface BlogPostRepository {
  listUrl: string
  editUrl(_postId: string): string
  create(_input: BlogPostCreateInput): Promise<BlogPost & { id: string }>
  update(_postId: string, _input: BlogPostUpdateInput): Promise<BlogPost>
  delete(_postId: string): Promise<void>
  publish(_postId: string, _input: { expected_updated_at: string }): Promise<BlogLifecycleState>
}
