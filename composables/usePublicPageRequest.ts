
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
  | 'reviews'
  | 'photos'
  | 'qa'
  | 'blogPost'
  | 'reservationPolicies'

export interface PublicPageRequest {
  page: string | null;
  location: string | null;
  datasets: readonly PublicPageDataset[];
  blogSlug: string | null; // set when the blogPost dataset is requested
  locale: string | null;
}

export function getPublicPageRequest(path: string): Omit<PublicPageRequest, "locale"> {

  // Location sub-pages: /locations/[slug]/*
  const locationMatch = path.match(/^\/locations\/([^/]+)/);
  if (locationMatch) {
    const slug = locationMatch[1];
    const segments = path.split("/");
    const sub = segments.length > 3 ? segments[3] : undefined;
    const page = sub || "location";
    const fullData =
      page === "reviews" || page === "photos" || page === "qa"
        ? page
        : null;
    return {
      page,
      location: slug ?? null,
      datasets: [
        ...(page === 'location' || page === 'contact' ? ['content'] as const : []),
        'location',
        ...(page === 'location' || page === 'menu' || page === 'products' || page === 'experiences' ? ['products'] as const : []),
        ...(page === "location" ? ['reviews'] as const : []),
        ...(fullData ? [fullData] as PublicPageDataset[] : []),
      ],
      blogSlug: null,
    };
  }

  // Blog post detail: /blog/[slug] — single segment only. Deeper paths like
  // /blog/[category]/[slug] belong to pages/blog/[category]/[slug].vue and
  // must not be captured here, or the wrong segment ends up as blogSlug.
  const blogMatch = path.match(/^\/blog\/([^/]+)\/?$/);
  if (blogMatch) {
    return {
      page: "blog",
      location: null,
      datasets: ['blogPost'],
      blogSlug: blogMatch[1] ?? null,
    };
  }

  const articleMatch = path.match(/^\/article\/([^/]+)\/?$/);
  if (articleMatch) {
    return {
      page: "blog",
      location: null,
      datasets: ['blogPost'],
      blogSlug: articleMatch[1] ?? null,
    };
  }

  // Top-level pages
  if (path === "/" || path === "")
    return {
      page: "home",
      location: null,
      datasets: ['content', 'location', 'products'],
      blogSlug: null,
    };
  if (path.startsWith("/locations"))
    return {
      page: "locations",
      location: null,
      datasets: ['location'],
      blogSlug: null,
    };
  if (path.startsWith("/about"))
    return {
      page: "about",
      location: null,
      datasets: ['content'],
      blogSlug: null,
    };
  if (path.startsWith("/contact"))
    return {
      page: "contact",
      location: null,
      datasets: ['content'],
      blogSlug: null,
    };
  if (path.startsWith("/reservations"))
    return {
      page: "reservations",
      location: null,
      datasets: ['content', 'reservationPolicies'],
      blogSlug: null,
    };
  if (path.startsWith("/qa"))
    return {
      page: "qa",
      location: null,
      datasets: ['qa'],
      blogSlug: null,
    };
  if (path.startsWith("/reviews"))
    return {
      page: "reviews",
      location: null,
      datasets: ['reviews'],
      blogSlug: null,
    };
  if (path.startsWith("/posts"))
    return {
      page: "posts",
      location: null,
      datasets: [],
      blogSlug: null,
    };
  if (path.startsWith("/photos"))
    return {
      page: "photos",
      location: null,
      datasets: ['photos'],
      blogSlug: null,
    };
  if (path === "/menu" || path.startsWith("/menu/"))
    return {
      page: "menu",
      location: null,
      datasets: ['products'],
      blogSlug: null,
    };
  if (path === '/products' || path.startsWith('/products/'))
    return {
      page: 'products',
      location: null,
      datasets: ['products'],
      blogSlug: null,
    };
  // Experiences are their own surface on every vertical that sells products: a
  // restaurant reaches /menu and /experiences, a studio /products and
  // /experiences. An Experience's own page is site-wide, so /experiences/<slug>
  // reads the same dataset as its collection.
  if (path === '/experiences' || path.startsWith('/experiences/'))
    return {
      page: 'experiences',
      location: null,
      datasets: ['products'],
      blogSlug: null,
    };
  if (path === "/blog" || path === "/blog/")
    return {
      page: "blog",
      location: null,
      datasets: [],
      blogSlug: null,
    };

    return {
      page: null,
      location: null,
      datasets: [],
      blogSlug: null,
    };
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
      datasets: request.datasets,
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

export const usePublicResourceKey = (
  resourceKind: 'shell' | 'page',
  organizationId: string,
  params: PublicPageRequest,
) =>
  [
    resourceKind,
    encodeKeyField(organizationId),
    encodeKeyField(params.page),
    encodeKeyField(params.location),
    encodeKeyField([...params.datasets].sort().join(',')),
    encodeKeyField(params.blogSlug),
    encodeKeyField(params.locale),
  ].join("~");

export const buildPublicPageUrl = (
  params: PublicPageRequest,
  resourceKind: 'shell' | 'page' = 'page',
) => {
  const qs = new URLSearchParams();
  if (params.page) qs.set("page", params.page);
  if (params.location) qs.set("location", params.location);
  if (params.datasets.length) qs.set("datasets", [...params.datasets].sort().join(','));
  if (params.blogSlug) qs.set("blogSlug", params.blogSlug);
  if (params.locale) qs.set('locale', params.locale)
  const q = qs.toString();
  return `/api/public/${resourceKind}${q ? `?${q}` : ""}`;
};
