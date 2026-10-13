import type { ComputedRef, InjectionKey } from 'vue'
import type { PublishedArticleCategory } from '~/composables/usePublishedArticles'

export interface ArticleNav {
  /** The collection's top-level categories; each holds its subcategories. */
  categories: PublishedArticleCategory[]
  indexLabel: string
  search: { surface: 'blog' | 'docs' | 'tenant_blog'; variant: 'platform' | 'saya' | 'blawby' } | null
}

/**
 * The collection's navigation, provided by the articles layout to the
 * template's header inside it: on a phone the header's own menu is the one
 * navigation, so the article list lives there rather than in a second drawer.
 */
export const articleNavKey = Symbol('article-nav') as InjectionKey<ComputedRef<ArticleNav>>

/**
 * The navigation of the collection the current page belongs to. The page names
 * its collection in its meta (`articleCollection`); the articles layout reads
 * it here, so going from the blog to the docs changes the list without
 * remounting the layout.
 */
export async function useArticleNav() {
  const route = useRoute()
  const { t } = useI18n()
  const { template } = useTenantOrganization()
  const publicLocale = useState<string>('public-locale', () => 'en')
  const collection = computed(() => route.meta.articleCollection === 'docs' ? 'docs' as const : 'blog' as const)
  const { categoryTree } = await usePublishedArticles(collection)

  return computed<ArticleNav>(() => ({
    categories: categoryTree.value,
    indexLabel: collection.value === 'docs' ? t('saya.footer.docs') : t('saya.footer.blog'),
    // Krabiclaw searches its own blog and docs; a site searches its articles, in English only.
    search: template.slug === 'platform'
      ? { surface: collection.value, variant: 'platform' }
      : publicLocale.value === 'en' ? { surface: 'tenant_blog', variant: template.slug } : null,
  }))
}
