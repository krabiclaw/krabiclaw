// `#nitro/virtual/app` is emitted by the Nitro build: it creates the app and runs its
// plugins. Under node --test there is no build, so the app is only its hooks, the
// same HookableCore `useNitroHooks()` gives a built app. A handler reporting through
// the `error` hook (as server/plugins/error-logger.ts receives it) reaches whatever a
// test registers on `useNitroHooks()`; no plugin is installed here.
export function createNitroApp() {
  return {}
}

export function initNitroPlugins() {}
