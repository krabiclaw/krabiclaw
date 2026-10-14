// Route content and persistent site chrome are separate public resources. Route
// consumers select their datasets from the validated route response.
//
// Every route consumes its validated public payload directly. The shared shell
// and route loaders keep persistent chrome and route content on one contract.
//
// Usage (in a page):
//   const { getField, getHero, media, qaList, ... } = await usePublicPageData()
import { onMounted, watch } from "vue";
import {
  usePublicPageRequest,
  usePublicResourceKey,
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

interface ContentRow {
  field: string;
  content: string | null;
  hero_title: string | null;
  hero_subtitle: string | null;
  media?: Array<{ asset_id: string; slot: string; public_url: string | null; thumbnail_url?: string | null; kind?: string | null }>;
  [key: string]: unknown;
}

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

export const usePublicPageData = async (options: {
  datasets?: readonly PublicPageDataset[]
  server?: boolean
  lazy?: boolean
  routeOwned?: boolean
} = {}) => {
  const { id: organizationId } = useTenantOrganization().organization
  const params = usePublicPageRequest();
  const requestedParams = computed(() => options.datasets
    ? { ...params.value, datasets: [...options.datasets] }
    : { ...params.value, datasets: [...params.value.datasets] })
  const key = computed(() => usePublicResourceKey('page', organizationId, requestedParams.value));

  const url = computed(() => buildPublicPageUrl(requestedParams.value));

  const shell = useOrganizationShellState();
  const requestEvent = import.meta.server ? useRequestEvent() : undefined
  const deferredSupplement = options.routeOwned === false
    && options.server === false
    && options.lazy === true;

  const asyncData = useAsyncData<PublicPagePayload>(
          key,
          (_nuxtApp, { signal }) => {
            const currentParams = requestedParams.value
            return loadPublicResourcePayload<PublicPagePayload>({
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
              validate: (value): value is PublicPagePayload =>
                isPublicPagePayload(value, currentParams.page ?? 'home'),
              failureMessage: 'Public page failed',
              signal,
              requestEvent,
            })
          },
          {
            server: options.server ?? true,
            lazy: deferredSupplement,
            dedupe: 'defer',
            immediate: !deferredSupplement,
            watch: [],
          },
        );
  if (import.meta.client && deferredSupplement && 'execute' in asyncData) {
    onMounted(() => void asyncData.execute());
  }
  const { data, error, pending, refresh } = asyncData
  const localeRepresentations = useState<PublicLocaleRepresentation[]>('public-locale-representations', () => [])
  if (options.routeOwned !== false) {
    watch(
      () => data.value?.localeRepresentations,
      representations => { localeRepresentations.value = representations ?? [] },
      { immediate: true },
    )
  }

  // Persistent chrome comes from the stable shell. Route-owned collections
  // come from the keyed page response and change with navigation.
  const { locations, config, organization } = shell;
  const googleMaps = computed(() => ({
    ...(shell.googleMaps.value ?? {}),
    reviews: data.value?.globalReviews ?? [],
  }))
  const products = computed(() => data.value?.products ?? []);
  const collections = computed(() => data.value?.collections ?? []);
  /**
   * Products grouped by the collections they belong to, in the merchant's
   * order. A product in two collections appears in both — that is what
   * membership means — and one in none appears in neither, rather than being
   * swept into a bucket nobody created.
   */
  const productsByCollection = computed(() => {
    const positions = new Map<string, Map<string, number>>();
    for (const product of products.value) {
      for (const membership of product.collections) {
        const forCollection = positions.get(membership.collection_id) ?? new Map<string, number>();
        forCollection.set(product.id, membership.sort_order);
        positions.set(membership.collection_id, forCollection);
      }
    }
    return collections.value.reduce<Record<string, Product[]>>((groups, collection) => {
      const forCollection = positions.get(collection.id);
      if (!forCollection) return groups;
      groups[collection.name] = products.value
        .filter(product => forCollection.has(product.id))
        .sort((left, right) => (forCollection.get(left.id)! - forCollection.get(right.id)!) || left.name.localeCompare(right.name));
      return groups;
    }, {});
  });

  // ── Single location (for /locations/[slug]/* pages) ───────
  const location = computed(() => {
    if (!requestedParams.value.location) return null;
    return locations.value.find((l) => l.slug === requestedParams.value.location) ?? null;
  });

  // ── Location reviews preview (3 items) ───────────────────
  const locationReviews = computed(() => (data.value?.locationReviews ?? []) as ApiRecord[]);

  // ── Full page datasets (types A / E / F) ─────────────────
  const reviewsAggregate = computed(() => (data.value?.reviewsAggregate ?? null) as ApiRecord | null);
  const reviewsList = computed(() => (data.value?.reviewsList ?? []) as ApiRecord[]);
  const media = computed(() => (data.value?.media ?? []) as ApiRecord[]);
  const qaList = computed(() => (data.value?.qaList ?? []) as ApiRecord[]);
  const blogPost = computed(() => (data.value?.blogPost ?? null) as ApiRecord | null);
  const tenantPage = computed(() => data.value?.tenant_page ?? null);

  const reservationPolicyByLocation = computed(() => data.value?.reservationPolicyByLocation ?? {});

  // ── Content ───────────────────────────────────────────────
  const contentMap = computed(() => {
    const rows = (data.value?.content ?? []) as ContentRow[];
    return rows.reduce<Record<string, ContentRow>>((acc, row) => {
      acc[row.field] = row;
      return acc;
    }, {});
  });

  const getField = (
    field: string,
    defaultValue: string | null = null,
  ): string | null => {
    if (
      ["hero.title", "hero.subtitle", "hero.media"].includes(
        field,
      )
    ) {
      const heroRow = contentMap.value["hero"];
      const fieldRow = contentMap.value[field];
      if (field === "hero.title")
        return heroRow?.hero_title ?? fieldRow?.content ?? defaultValue;
      if (field === "hero.subtitle")
        return heroRow?.hero_subtitle ?? fieldRow?.content ?? defaultValue;
      if (field === "hero.media")
        return heroRow?.media?.find(item => item.slot === 'media')?.public_url ?? defaultValue;
    }
    const row = contentMap.value[field];
    if (!row) return defaultValue;
    const mediaValue = row.media?.[0]?.public_url || row.content;
    const val = row.type === "media" ? mediaValue : row.content;
    return val && val.trim() !== "" ? val : defaultValue;
  };

  const getHero = (
    defaults = { title: "", subtitle: "", image: "", video: "" },
  ) => {
    const row = contentMap.value["hero"];
    const heroMedia = row?.media?.find(item => item.slot === 'media') ?? null;
    const isVideo = heroMedia?.kind === "video";
    return {
      title:
        getField("hero.title", row?.hero_title ?? defaults.title) ??
        defaults.title,
      subtitle:
        getField("hero.subtitle", row?.hero_subtitle ?? defaults.subtitle) ??
        defaults.subtitle,
      image:
        (isVideo ? defaults.image : getField("hero.media", heroMedia?.public_url || defaults.image)) ??
        defaults.image,
      video:
        (isVideo ? getField("hero.media", heroMedia?.public_url || defaults.video) : defaults.video) ??
        defaults.video,
      thumbnail_url: heroMedia?.thumbnail_url || null,
      imageKind: isVideo ? "image" : (heroMedia?.kind || "image"),
      videoKind: isVideo ? "video" : "video",
    };
  };


  // Register every lifecycle hook above before suspending setup. Route-owned
  // data is authoritative: navigation completes only after this single request
  // succeeds, and failures propagate to Nuxt's error boundary.
  if (!deferredSupplement && 'then' in asyncData) {
    await asyncData
    if (asyncData.error.value) throwPublicPageError(asyncData.error.value)
  }
  if (options.routeOwned !== false) {
    localeRepresentations.value = data.value?.localeRepresentations ?? []
  }
  await shell.ready
  if (options.routeOwned !== false && shell.error.value) throwPublicPageError(shell.error.value)

  return {
    data,
    pending,
    refresh,
    locations,
    organization,
    location,
    config,
    googleMaps,
    locationReviews,
    reviewsAggregate,
    reviewsList,
    media,
    qaList,
    blogPost,
    tenantPage,
    reservationPolicyByLocation,
    getField,
    getHero,
    contentMap,
    products,
    productsByCollection,
    collections,
    error,
    localeRepresentations,
  };
};
