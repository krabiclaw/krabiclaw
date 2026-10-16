// Site-wide chrome is a stable SSR resource keyed only by tenant and locale.
// Route-specific content is loaded separately so client navigation cannot
// replace the persistent header/footer state with another route's request.
import { buildPublicPageUrl, usePublicResourceKey, type PublicPageRequest } from "~/composables/usePublicPageRequest";
import {
  isPublicShellPayload,
  type PublicShellPayload as OrganizationShellPayload,
} from '~/utils/public-resource-contracts'

export const useOrganizationShellState = () => {
  const { id: organizationId } = useTenantOrganization().organization
  const { locale } = useI18n()

  const params = computed<PublicPageRequest>(() => ({
    page: null,
    location: null,
    datasets: [],
    blogSlug: null,
    locale: locale.value,
  }));

  const key = computed(() => usePublicResourceKey('shell', organizationId, params.value));
  const url = computed(() => buildPublicPageUrl(params.value, 'shell'));

  const asyncData = useAsyncData<OrganizationShellPayload>(
    key,
    (_nuxtApp, { signal }) => loadPublicResourcePayload<OrganizationShellPayload>({
      organizationId,
      resourceKind: 'shell',
      url: url.value,
      key: key.value,
      query: {
        locale: params.value.locale ?? undefined,
      },
      validate: isPublicShellPayload,
      failureMessage: 'Public shell failed',
      signal,
    }),
    {
      server: true,
      dedupe: 'cancel',
      // Reuse what SSR already resolved. Without this the shell can be
      // fetched a second time during hydration, and that fetch carries
      // different authorization than the server render did (the preview
      // cookie is a third-party cookie inside the onboarding preview
      // frame), which renders a different shell than the one being
      // hydrated. The page loader does the same for the same reason.
      getCachedData(cacheKey) {
        return useNuxtApp().payload.data[cacheKey] as OrganizationShellPayload | undefined
      },
    },
  );
  const { data, error, pending, refresh } = asyncData
  const ready = import.meta.server ? asyncData : Promise.resolve()

  const locations = computed(() => data.value?.locations ?? []);
  const config = computed(() => (data.value?.config ?? {}) as Record<string, string>);
  const shellOrganization = computed(() => data.value?.organization ?? null);
  const googleMaps = computed(() => data.value?.googleMaps ?? null);
  // Before the shell loads no section is known to have anything on it.
  const sections = computed(() => data.value?.sections ?? null);
  const platformMessages = useState<Record<string, string> | null>('platform-locale-messages', () => null)
  watch(
    () => data.value?.platformMessages,
    messages => { platformMessages.value = messages ?? null },
    { immediate: true },
  )
  return {
    locations,
    config,
    organization: shellOrganization,
    googleMaps,
    sections,
    data,
    pending,
    error,
    refresh,
    ready,
  };
};
