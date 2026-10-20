// /article/:slug is permanently moved to /blog/:slug across all templates.
export default defineNuxtRouteMiddleware((to) => {
  const slug = 'slug' in to.params ? String(to.params.slug || '') : ''
  return navigateTo({ path: `/blog/${encodeURIComponent(slug)}`, query: to.query, hash: to.hash }, { redirectCode: 301 })
})

