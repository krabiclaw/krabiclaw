
// Maps each public route to the exact page datasets it may request.
//
// Page type → SSR call mapping:
//   /locations/[slug]/reviews  → type A  (reviews data included)
//   /locations                 → type B
//   /locations/[slug]          → type C  (Products, reviews, and posts previews included)
//   regular pages (/, /about…) → type D
//   /locations/[slug]/photos   → type E  (photos data included)
//   /locations/[slug]/qa       → type F  (qa data included)
//   /locations/[slug]/posts    → type G  (posts data included)
export type PublicPageDataset =
  | 'content'
  | 'location'
  | 'products'
  | 'menu_cards'
  | 'reviews'
  | 'photos'
  | 'qa'
  | 'blog_post'

export interface PublicPageRequest {
  page: string | null;
  location: string | null;
  datasets: readonly PublicPageDataset[];
  blogSlug: string | null; // set when the blog_post dataset is requested
  locale: string | null;
}

const siteDatasets: Record<string, readonly PublicPageDataset[]> = {
  home: ['content', 'location', 'products'],
  locations: ['location'],
  about: ['content'],
  contact: ['content'],
  reservations: ['content', 'products'],
  qa: ['qa'],
  reviews: ['reviews'],
  posts: [],
  photos: ['photos'],
  menu: ['products'],
  products: ['products'],
  experiences: ['products'],
  stays: ['products'],
  blog: [],
}
const locationDatasets: Record<string, readonly PublicPageDataset[]> = {
  location: ['content', 'location', 'products', 'reviews'],
  contact: ['content', 'location'],
  products: ['location', 'products'],
  experiences: ['location', 'products'],
  menu: ['location', 'products'],
  reviews: ['location', 'reviews'],
  photos: ['location', 'photos'],
  qa: ['location', 'qa'],
}

export function getPublicPageRequest(path: string): Omit<PublicPageRequest, 'locale'> {
  const [, root, slug, sub] = path.split('/')
  if (root === 'locations' && slug) {
    const page = sub || 'location'
    return { page, location: slug, datasets: Object.hasOwn(locationDatasets, page) ? locationDatasets[page]! : ['location'], blogSlug: null }
  }
  if (slug && /^\/(?:blog|article)\/[^/]+\/?$/.test(path)) {
    return { page: 'blog', location: null, datasets: ['blog_post'], blogSlug: slug }
  }
  const section = root || 'home'
  const page = Object.hasOwn(siteDatasets, section) ? section : null
  return { page, location: null, datasets: page ? siteDatasets[page]! : [], blogSlug: null }
}

export const usePublicPageRequest = () => {
  const route = useRoute();
  const locale = useState<string>('public-locale', () => 'en')
  const sourceLocale = useState<string | null>('public-source-locale', () => null)

  return computed<PublicPageRequest>(() => {
    const effectivePath = route.path
    const explicitLocale = typeof route.params.locale === 'string'
      ? route.params.locale
      : locale.value !== sourceLocale.value && (effectivePath === `/${locale.value}` || effectivePath.startsWith(`/${locale.value}/`))
        ? locale.value
        : null
    const localePath = explicitLocale
      ? {
          localeSegment: explicitLocale,
          sourcePath: effectivePath.slice(explicitLocale.length + 1) || '/',
          publicPath: effectivePath,
        }
      : { localeSegment: null, sourcePath: effectivePath, publicPath: effectivePath }
    const request = getPublicPageRequest(localePath.sourcePath)
    return {
      ...request,
      locale: localePath.localeSegment,
    }
  });
};

// Each field is percent-encoded and joined with "~" (not a valid URI-component
// character) so a hyphen inside a slug/locale can't be mistaken for a field
// separator and collide two otherwise-distinct param combinations.
// encodeURIComponent doesn't escape "~", so we replace it explicitly to avoid
// delimiter collisions.
const encodeKeyField = (value: string | null | undefined): string =>
  encodeURIComponent(value ?? "").replace(/~/g, '%7E');

export const usePublicPageKey = (
  organizationId: string,
  params: PublicPageRequest,
) =>
  [
    'page',
    encodeKeyField(organizationId),
    encodeKeyField(params.page),
    encodeKeyField(params.location),
    encodeKeyField([...params.datasets].sort().join(',')),
    encodeKeyField(params.blogSlug),
    encodeKeyField(params.locale),
  ].join("~");

export const buildPublicPageUrl = (
  params: PublicPageRequest,
) => {
  const qs = new URLSearchParams();
  if (params.page) qs.set("page", params.page);
  if (params.location) qs.set("location", params.location);
  if (params.datasets.length) qs.set("datasets", [...params.datasets].sort().join(','));
  if (params.blogSlug) qs.set("blogSlug", params.blogSlug);
  if (params.locale) qs.set('locale', params.locale)
  const q = qs.toString();
  return `/api/public/page${q ? `?${q}` : ""}`;
};
