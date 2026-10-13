import { registerErrorTracking } from '~/utils/error-tracking-runtime.client'

export default defineNuxtPlugin({
  name: 'error-tracking',
  enforce: 'pre',
  setup: registerErrorTracking,
})
