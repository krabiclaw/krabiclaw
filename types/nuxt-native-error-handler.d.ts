// Bound to the installed Nuxt renderer by the nitro:config hook.
declare module '#nuxt-native-error-handler' {
  import type { NitroErrorHandler } from 'nitro/types'
  const handler: NitroErrorHandler
  export default handler
}
