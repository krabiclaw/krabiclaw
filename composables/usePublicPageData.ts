// Route content and persistent site chrome are separate public resources. Route
// consumers select their datasets from the validated route response.
//
// Every route consumes its validated public payload directly. The shared shell
// and route loaders keep persistent chrome and route content on one contract.
//
// Usage (in a page):
//   const { getField, getHero, media, qa_list, ... } = await usePublicPageData()
import { watch } from "vue";
import {
  usePublicPageRequest,
  usePublicPageKey,
  buildPublicPageUrl,
  type PublicPageDataset,
} from "~/composables/usePublicPageRequest";
import { useOrganizationShellState } from "~/composables/useOrganizationShell";
import type { Product } from '~/server/types/products'
import {
  isPublicPagePayload,
  type PublicLocaleRepresentation,
  type PublicPagePayload,
} from '~/utils/public-resource-contracts'

const throwPublicPageError = (error: unknown): never => {
  const record = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : {}
  const statusCode = typeof record.statusCode === 'number'
    ? record.statusCode
    : typeof record.status === 'number'
      ? record.status
      : 500
  const statusMessage = typeof record.statusMessage === 'string'
    ? record.statusMessage
    : error instanceof Error
      ? error.message
      : 'Public page failed'

  throw createError({ statusCode, statusMessage, fatal: import.meta.client, cause: error })
}

export const usePublicPageData = async <T = Product>(options: {
  datasets?: readonly PublicPageDataset[]
  validateProduct?: (value: unknown) => value is T
} = {}) => {
  const { id: organizationId } = useTenantOrganization().organization
  const params = usePublicPageRequest();
  const requestedParams = computed(() => options.datasets
    ? { ...params.value, datasets: [...options.datasets] }
    : { ...params.value, datasets: [...params.value.datasets] })
  const key = computed(() => usePublicPageKey(organizationId, requestedParams.value));

  const url = computed(() => buildPublicPageUrl(requestedParams.value));

  const shell = useOrganizationShellState();
  const requestEvent = import.meta.server ? useRequestEvent() : undefined
  const asyncData = useAsyncData<PublicPagePayload<T>>(
          key,
          (_nuxtApp, { signal }) => {
            const currentParams = requestedParams.value
            return loadPublicResourcePayload<PublicPagePayload<T>>({
              organizationId,
              resourceKind: 'page',
              url: url.value,
              key: key.value,
              query: {
                page: currentParams.page ?? undefined,
                location: currentParams.location ?? undefined,
                datasets: [...currentParams.datasets].sort().join(',') || undefined,
                blogSlug: currentParams.blogSlug ?? undefined,
                locale: currentParams.locale ?? undefined,
              },
              validate: (value): value is PublicPagePayload<T> =>
                options.validateProduct
                  ? isPublicPagePayload(value, currentParams.page ?? 'home', options.validateProduct)
                  : isPublicPagePayload(value, currentParams.page ?? 'home'),
              failureMessage: 'Public page failed',
              signal,
              requestEvent,
            })
          },
          {
            dedupe: 'defer',
            // The root can finish the read before the page itself mounts on the server.
            getCachedData: import.meta.server ? (key, app) => app.payload.data[key] : undefined,
            watch: [],
          },
        );
  const { data, error, pending, refresh } = asyncData
  const locale_representations = useState<PublicLocaleRepresentation[]>('public-locale-representations', () => [])
  watch(
    () => data.value?.locale_representations,
    representations => { locale_representations.value = representations ?? [] },
    { immediate: true },
  )

  // Persistent chrome comes from the stable shell. Route-owned collections
  // come from the keyed page response and change with navigation.
  const { locations, config, organization, sections } = shell;
  const google_maps = computed(() => ({
    ...(shell.google_maps.value ?? {}),
    reviews: data.value?.global_reviews ?? [],
  }))
  const products = computed(() => data.value?.products ?? []);
  const collections = computed(() => data.value?.collections ?? []);
  // ── Single location (for /locations/[slug]/* pages) ───────
  const location = computed(() => {
    if (!requestedParams.value.location) return null;
    return locations.value.find((l) => l.slug === requestedParams.value.location) ?? null;
  });

  // ── Location reviews preview (3 items) ───────────────────
  const location_reviews = computed(() => (data.value?.location_reviews ?? []) as ApiRecord[]);

  // ── Full page datasets (types A / E / F) ─────────────────
  const reviews_aggregate = computed(() => (data.value?.reviews_aggregate ?? null) as ApiRecord | null);
  const reviews_list = computed(() => (data.value?.reviews_list ?? []) as ApiRecord[]);
  const media = computed(() => (data.value?.media ?? []) as ApiRecord[]);
  const qa_list = computed(() => (data.value?.qa_list ?? []) as ApiRecord[]);
  const blog_post = computed(() => (data.value?.blog_post ?? null) as ApiRecord | null);
  const tenantPage = computed(() => data.value?.tenant_page ?? null);

  const table_policy_summaries = computed(() => data.value?.table_policy_summaries ?? {});

  const blocks = computed(() => {
    const fields = new Map<string, NonNullable<typeof tenantPage.value>['blocks'][number]>()
    for (const block of tenantPage.value?.blocks ?? []) {
      const field = block.type === 'hero' ? 'hero' : block.data.field
      fields.set(typeof field === 'string' && field.trim() ? field.trim() : `${block.type}.${block.position}`, block)
      if (block.type === 'hero' && typeof block.data.eyebrow === 'string' && block.data.eyebrow.trim()) fields.set('hero.kicker', block)
    }
    return fields
  })
  const heroMedia = computed(() => blocks.value.get('hero')?.media.find(item => item.slot === 'media'))
  function getField(field: string, fallback: string | null = null): string | null {
    const hero = blocks.value.get('hero')?.data
    if (field === 'hero.media') return heroMedia.value?.public_url ?? fallback
    if (field === 'hero.title' && typeof hero?.title === 'string') return hero.title
    if (field === 'hero.subtitle' && typeof hero?.subtitle === 'string') return hero.subtitle
    const block = blocks.value.get(field)
    if (!block) return fallback
    const { type, data, media } = block
    const value = type === 'hero' ? data.eyebrow : type === 'heading' ? data.text
      : type === 'markdown' ? data.markdown ?? data.content : type === 'image' || type === 'gallery' ? media[0]?.public_url || data.title : data.title
    return typeof value === 'string' && value.trim() ? value : fallback
  }
  function getHero(defaults = { title: '', subtitle: '', image: '', video: '' }) {
    const asset = heroMedia.value
    const isVideo = asset?.kind === 'video'
    return {
      title: getField('hero.title', defaults.title) ?? defaults.title,
      subtitle: getField('hero.subtitle', defaults.subtitle) ?? defaults.subtitle,
      image: (isVideo ? defaults.image : asset?.public_url) || defaults.image,
      video: (isVideo ? asset.public_url : defaults.video) || defaults.video,
      thumbnail_url: asset?.thumbnail_url || null,
      imageKind: isVideo ? 'image' : (asset?.kind || 'image'),
      videoKind: 'video',
    }
  }

  await asyncData
  if (error.value) throwPublicPageError(error.value)
  locale_representations.value = data.value?.locale_representations ?? []
  await shell.ready
  if (shell.error.value) throwPublicPageError(shell.error.value)

  return {
    data,
    pending,
    refresh,
    locations,
    organization,
    location,
    sections,
    config,
    google_maps,
    location_reviews,
    reviews_aggregate,
    reviews_list,
    media,
    qa_list,
    blog_post,
    tenantPage,
    table_policy_summaries,
    getField,
    getHero,
    products,
    collections,
    error,
    locale_representations,
  };
};
