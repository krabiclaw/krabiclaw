import { resolvePublicTemplate } from '~/utils/template-registry'

export function usePublicTemplate() {
  const { isTenant, organization, themeId } = useTenantOrganization()
  // Krabiclaw's own site has a template like any other site: it renders page
  // documents at the paths that template declares (#903). Returning null here
  // made every platform route ask a template that did not exist, which is why
  // the marketing pages had to be hardcoded Vue instead of CMS documents.
  const template = computed(() => resolvePublicTemplate({
    themeId,
    vertical: organization?.vertical,
  }))

  return {
    template,
    isBlawby: computed(() => isTenant && template.value.slug === 'blawby'),
  }
}
