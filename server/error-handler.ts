import { defineErrorHandler } from 'nitro'
import nuxtErrorHandler from '#nuxt-native-error-handler'

// The native renderer serializes the JSON error result into its internal
// request. Carry the public identity already resolved on the failing request;
// error rendering never repeats its database lookup or metadata validation.
export default defineErrorHandler((error, event, helpers) => {
  const context = event.req.context
  if (!context?.organization || !event.req.headers.get('accept')?.includes('text/html') || new URL(event.req.url).pathname.startsWith('/api/')) {
    return nuxtErrorHandler(error, event, helpers)
  }
  return nuxtErrorHandler(error, event, {
    defaultHandler: async (...args) => {
      const result = await helpers.defaultHandler(...args)
      if (args[2]?.json && result.body && typeof result.body === 'object') {
        result.body.tenantContext = {
          organization: context.organization,
          previewAuthorized: context.previewAuthorized === true,
        }
      }
      return result
    },
  })
})
