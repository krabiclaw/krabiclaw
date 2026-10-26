// /article/:slug is permanently moved to /blog/:slug across all templates.
export default defineNuxtRouteMiddleware((to) => {
  const slug = 'slug' in to.params ? String(to.params.slug || '') : ''
  const prefix = 'locale' in to.params && to.params.locale ? `/${String(to.params.locale)}` : ''
  return navigateTo({ path: `${prefix}/blog/${encodeURIComponent(slug)}`, query: to.query, hash: to.hash }, { redirectCode: 301 })
})

