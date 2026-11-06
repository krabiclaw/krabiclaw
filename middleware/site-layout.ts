/**
 * A page every site renders wraps itself in that site's layout here,
 * before it renders, so the layout's site-wide head is set first and the
 * page's own metadata is the last word.
 */
export default defineNuxtRouteMiddleware(() => {
  const { site } = useTenantOrganization().organization
  return setPageLayout(site.layout)
})
