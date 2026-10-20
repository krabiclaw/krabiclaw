// A request under the build-asset prefixes only reaches the Worker when the
// Assets binding has no such file — every real asset is served before this runs.
//
// Without this, such a request fell through to SSR and was answered by whatever
// route matched the path: on a legal practice's host that was the tenant page catch-all,
// which reported `400 Invalid route slug` for `/_nuxt/DbWZgctb.js`. The
// `/_nuxt/**` route rule then stamped `max-age=31536000, immutable` on the
// error, so a browser and the edge cached a wrong answer for a year, and each
// miss cost four D1 queries.
//
// A missing build asset is a 404, and it is never cached.

import { defineHandler } from 'nitro'
import { setResponseHeaders } from 'nitro/h3'

const BUILD_ASSET_PREFIXES = ['/_nuxt/', '/assets/']

export default defineHandler((event) => {
  if (!BUILD_ASSET_PREFIXES.some(prefix => event.path.startsWith(prefix))) return
  setResponseHeaders(event, { 'cache-control': 'no-store' })
  event.res.status = 404
  return 'Build asset not found'
})
