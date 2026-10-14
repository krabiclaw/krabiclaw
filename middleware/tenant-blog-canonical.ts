import { tenantBlogPostPath } from '~/utils/tenant-blog-route'

// A template whose blog articles live at another prefix (Blawby's /article)
// answers /blog/{slug} with a permanent redirect to that address.
export default defineNuxtRouteMiddleware((to) => {
  const { template } = useTenantOrganization().organization
  if (template.serviceRoutes.articleDetailPrefix === '/blog') return
  return navigateTo({ path: tenantBlogPostPath(template, String(to.params.slug || '')), query: to.query, hash: to.hash }, { redirectCode: 301 })
})
